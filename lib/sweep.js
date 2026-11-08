/**
 * Tiering policy and the filesystem engine behind it.
 *
 * Deliberately free of Cordis: the plugin (`lib/index.js`) feeds it the live
 * agent set, the pinned-id set, and the projection metadata, and this module
 * owns every decision and every byte moved.
 *
 * Safety model, in order of what can go wrong:
 *   - a session with a live agent must never move (caller supplies `isLive`);
 *   - a partial move must never strand a session: cold dir first, manifest
 *     second, and a failed manifest write moves the directory straight back;
 *   - a restore verifies the sha256 recorded at freeze time before it drops
 *     the cold copy.
 *
 * @module @gnanesh/dsh-session-coldstore/sweep
 */
import { readdir, readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'
import {
  LIVE_ROOT,
  PROJCACHE_ROOT,
  destinationRefusal,
  dirName,
  layout,
  moveFileReplace,
  movePath,
  normalizeId,
  readJson,
  sha256File,
  sizeOf,
  writeJsonAtomic,
} from './manifest.js'

const MANIFEST_VERSION = 1
const DEFAULT_INDEX_MAX_BYTES = 32 * 1024 * 1024
const PREVIEW_CHARS = 4000

/** Reasons a session is exempt from freezing. Ordered by precedence. */
export const EXEMPT_REASONS = [
  'live',
  'pinned',
  'starred',
  'unread',
  'goal',
  'todo',
  'subagent',
  'too-new',
  'already-cold',
]

export class Coldstore {
  /**
   * @param {object} options
   * @param {string} [options.coldRoot] cold tier root
   * @param {string} [options.liveRoot] DSH session root
   * @param {string} [options.projcacheRoot] projection cache directory
   * @param {object} [options.index] a ColdIndex instance (optional)
   * @param {object} [options.logger] minimal logger with `.warn`
   */
  constructor(options = {}) {
    this.layout = layout(options.coldRoot)
    this.liveRoot = options.liveRoot || LIVE_ROOT
    this.projcacheRoot = options.projcacheRoot || PROJCACHE_ROOT
    this.index = options.index
    this.logger = options.logger || { warn() {} }
    this.manifest = { version: MANIFEST_VERSION, entries: {} }
    this.stars = { version: MANIFEST_VERSION, ids: [] }
    this.ledger = { version: MANIFEST_VERSION, opened: {} }
    this.touched = false
  }

  // ── state ──────────────────────────────────────────────────────────────

  async load() {
    const m = await readJson(this.layout.manifest, null)
    this.manifest = m && m.entries ? m : { version: MANIFEST_VERSION, entries: {} }
    const s = await readJson(this.layout.stars, null)
    this.stars = s && Array.isArray(s.ids) ? s : { version: MANIFEST_VERSION, ids: [] }
    const l = await readJson(this.layout.ledger, null)
    this.ledger = l && l.opened ? l : { version: MANIFEST_VERSION, opened: {} }
    // The instant this plugin started observing. The `unread` exemption needs
    // it: a session that predates observation has unknown read history and
    // must not be classed as unread, or the whole backlog is permanently
    // exempt the moment any single session is opened.
    if (typeof this.ledger.installedAt !== 'number') {
      this.ledger.installedAt = Date.now()
      await this.saveLedger()
    }
    this.touched = Object.keys(this.ledger.opened).length > 0
    return this
  }

  async saveManifest() {
    await writeJsonAtomic(this.layout.manifest, this.manifest)
  }

  async saveStars() {
    await writeJsonAtomic(this.layout.stars, this.stars)
  }

  async saveLedger() {
    await writeJsonAtomic(this.layout.ledger, this.ledger)
  }

  /** Record that a session was observed as open; the unread exemption reads this. */
  async markOpened(sessionId, at = Date.now()) {
    const id = normalizeId(sessionId)
    const prev = this.ledger.opened[id]
    if (prev && prev >= at - 60_000) return false
    this.ledger.opened[id] = at
    this.touched = true
    await this.saveLedger()
    return true
  }

  isStarred(id) {
    return this.stars.ids.includes(normalizeId(id))
  }

  async setStarred(id, starred) {
    const sid = normalizeId(id)
    const set = new Set(this.stars.ids)
    if (starred) set.add(sid)
    else set.delete(sid)
    this.stars.ids = [...set]
    await this.saveStars()
    if (this.index) await Promise.resolve(this.index.setStarred?.(sid, Boolean(starred))).catch(() => {})
    return true
  }

  coldEntries() {
    return Object.values(this.manifest.entries)
  }

  // ── discovery ──────────────────────────────────────────────────────────

  /** Every materialized session under the live root. */
  async liveSessions() {
    let projects = []
    try {
      projects = await readdir(this.liveRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const project of projects) {
      if (!project.isDirectory() || project.name.startsWith('.')) continue
      const projectDir = path.join(this.liveRoot, project.name)
      let children = []
      try {
        children = await readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (!child.isDirectory()) continue
        const dir = path.join(projectDir, child.name)
        const transcript = await findTranscript(dir)
        if (!transcript) continue
        out.push({
          id: normalizeId(child.name),
          dir,
          dirName: child.name,
          projectDir: project.name,
          transcript,
          bytes: await dirBytes(dir),
        })
      }
    }
    return out
  }

  projcachePath(id) {
    return path.join(this.projcacheRoot, `${normalizeId(id)}.json`)
  }

  /** Projection-derived facts for one session, or `{}` when no cache doc exists. */
  async metadata(id) {
    const doc = await readJson(this.projcachePath(id), null)
    if (!doc || !doc.record) return {}
    const rows = doc.record.rows || {}
    const val = (key) => rows[key]?.val
    const listMeta = val('sessionListMetadata') || {}
    const goal = val('goal')
    return {
      title: typeof val('title') === 'string' ? val('title') : '',
      cwd: typeof val('workingDirectory') === 'string' ? val('workingDirectory') : '',
      lastPromptAt: listMeta.lastPromptAt || doc.record.identity?.createdAt || 0,
      createdAt: doc.record.identity?.createdAt || 0,
      goal,
      todos: val('todos'),
      origin: doc.record.identity?.origin,
      parentSessionId: doc.record.identity?.parentSession,
    }
  }

  // ── policy ─────────────────────────────────────────────────────────────

  /**
   * Classify every live session as a freeze candidate or an exemption.
   *
   * @param {object} policy
   * @param {number} policy.retainDays sessions prompted within this window stay live
   * @param {(id: string) => boolean} [policy.isLive] live-agent predicate
   * @param {readonly string[]} [policy.pinnedIds] pinned session ids
   * @param {boolean} [policy.keepPinned] default true
   * @param {boolean} [policy.keepStarred] default true
   * @param {boolean} [policy.keepUnread] default true
   * @param {number} [policy.minIdleMs] extra idle requirement, default 0
   * @param {number} [policy.now] clock override for tests
   */
  async plan(policy = {}) {
    const now = policy.now || Date.now()
    const retainMs = Math.max(0, policy.retainDays ?? 7) * 86_400_000
    const cutoff = now - Math.max(retainMs, policy.minIdleMs || 0)
    const isLive = policy.isLive || (() => false)
    const pinned = new Set((policy.pinnedIds || []).map(normalizeId))
    const cold = new Set(Object.keys(this.manifest.entries))

    const candidates = []
    const exempt = []
    for (const live of await this.liveSessions()) {
      const meta = await this.metadata(live.id)
      const kind = (reason) => ({
        id: live.id,
        title: meta.title || '',
        cwd: meta.cwd || '',
        lastPromptAt: meta.lastPromptAt || 0,
        bytes: live.bytes,
        projectDir: live.projectDir,
        reason,
      })
      const reason = this.classify({ live, meta, cutoff, isLive, pinned, cold, policy })
      if (reason) exempt.push(kind(reason))
      else candidates.push(kind(undefined))
    }
    const totals = { count: candidates.length, bytes: candidates.reduce((n, c) => n + c.bytes, 0) }
    return { candidates, exempt, totals }
  }

  classify({ live, meta, cutoff, isLive, pinned, cold, policy }) {
    if (cold.has(live.id)) return 'already-cold'
    if (isLive(live.id)) return 'live'
    if ((policy.keepPinned ?? true) && pinned.has(live.id)) return 'pinned'
    if ((policy.keepStarred ?? true) && this.isStarred(live.id)) return 'starred'
    if (policy.keepUnread ?? true) {
      // Unread means: created after we started observing, and never opened
      // since. Older sessions have no read history to consult, so they fall
      // through to retainDays / pin / star instead of being exempt forever.
      const opened = this.ledger.opened[live.id]
      const observable = typeof this.ledger.installedAt === 'number'
        && meta.createdAt
        && meta.createdAt >= this.ledger.installedAt
      if (!opened && observable) return 'unread'
    }
    // The goal projection is `{ goal: { phase, ... }, roundsStarted, ... }`;
    // accept a bare `{ phase }` too so older/newer shapes both classify.
    const phase = meta.goal?.goal?.phase ?? meta.goal?.phase
    if (phase && phase !== 'complete' && phase !== 'cancelled') return 'goal'
    if (Array.isArray(meta.todos) && meta.todos.some((t) => t && t.status !== 'completed')) return 'todo'
    if (meta.origin === 'subagent' || meta.parentSessionId) return 'subagent'
    const stamp = meta.lastPromptAt || meta.createdAt || 0
    if (!stamp || stamp > cutoff) return 'too-new'
    return undefined
  }

  // ── moves ──────────────────────────────────────────────────────────────

  /**
   * Move one live session into the cold tier.
   *
   * @returns {Promise<object>} the manifest entry written
   */
  async freezeOne(live, meta = {}) {
    const id = live.id
    const coldDir = path.join(this.layout.sessions, id)
    const coldDoc = path.join(this.layout.projcache, `${id}.json`)
    const liveDoc = this.projcachePath(id)
    const hasDoc = existsSync(liveDoc)

    // Preflight before the first move. A half-done freeze is a stranded
    // session: the transcript already moved, the cache document refused.
    await mkdir(this.layout.sessions, { recursive: true })
    await mkdir(this.layout.projcache, { recursive: true })
    const dirRefusal = await destinationRefusal(coldDir)
    if (dirRefusal) throw new Error(`${id}: ${dirRefusal}`)

    await movePath(live.dir, coldDir)
    let docMoved = false
    const rollback = async () => {
      if (docMoved) await moveFileReplace(coldDoc, liveDoc).catch(() => {})
      await movePath(coldDir, live.dir).catch(() => {})
    }
    try {
      if (hasDoc) {
        // The live document is the authoritative one at freeze time.
        await moveFileReplace(liveDoc, coldDoc)
        docMoved = true
      }
      const entry = {
        id,
        projectDir: live.projectDir,
        dirName: live.dirName || dirName(id),
        frozenAt: Date.now(),
        lastPromptAt: meta.lastPromptAt || 0,
        title: meta.title || '',
        cwd: meta.cwd || '',
        bytes: live.bytes,
        sha256: await sha256File(path.join(coldDir, path.basename(live.transcript))),
        projcacheDoc: docMoved,
      }
      this.manifest.entries[id] = entry
      try {
        await this.saveManifest()
      } catch (error) {
        delete this.manifest.entries[id]
        throw error
      }
      await this.indexOne(entry, coldDir)
      return entry
    } catch (error) {
      // Never leave a session frozen-but-unrecorded: put it back first.
      await rollback()
      throw error
    }
  }

  /** Index one frozen session's text; failures are logged, never fatal. */
  async indexOne(entry, coldDir) {
    if (!this.index) return
    try {
      const transcript = await findTranscript(coldDir)
      if (!transcript) return
      const bytes = await sizeOf(transcript)
      if (bytes > DEFAULT_INDEX_MAX_BYTES) {
        this.logger.warn(`coldstore: skip indexing ${entry.id} (${bytes} bytes exceeds cap)`)
        return
      }
      const text = extractText(await readFile(transcript))
      if (text) {
        // The index only tokenizes `text`, so fold the row's own labels in:
        // a search for the session title or its directory must match too.
        const labels = [entry.title, entry.cwd, entry.projectDir].filter(Boolean).join('\n')
        await this.index.add({ ...entry, starred: this.isStarred(entry.id) }, labels ? `${labels}\n${text}` : text)
      }
    } catch (error) {
      this.logger.warn(`coldstore: indexing ${entry.id} failed: ${String(error)}`)
    }
  }

  /**
   * Execute a reviewed batch.
   *
   * Maker/checker: the caller staged a set of ids from an earlier `plan()`,
   * and this re-derives eligibility *now* before touching anything. A session
   * that was pinned, starred, opened, resumed, or aged back inside the window
   * between staging and commit is skipped rather than frozen — the committed
   * set is the reviewed set, minus anything that stopped qualifying.
   *
   * @param {readonly string[]} ids the staged ids
   * @param {object} policy the same policy shape `plan()` takes
   * @returns {Promise<{moved: object[], skipped: {id: string, reason: string}[]}>}
   */
  async commit(ids, policy = {}) {
    const current = await this.plan(policy)
    const eligible = new Set(current.candidates.map((c) => c.id))
    const dirs = new Map((await this.liveSessions()).map((s) => [s.id, s]))
    const isLive = policy.isLive || (() => false)
    const moved = []
    const skipped = []
    for (const raw of ids) {
      const id = normalizeId(raw)
      if (isLive(id)) {
        skipped.push({ id, reason: 'live' })
        continue
      }
      if (!eligible.has(id)) {
        skipped.push({ id, reason: 'no-longer-eligible' })
        continue
      }
      const live = dirs.get(id)
      if (!live) {
        skipped.push({ id, reason: 'missing' })
        continue
      }
      try {
        moved.push(await this.freezeOne(live, await this.metadata(id)))
      } catch (error) {
        skipped.push({ id, reason: String(error?.message ?? error) })
      }
    }
    return { moved, skipped }
  }

  /** Move one cold session back into the live root, verifying its digest first. */
  async restoreOne(id) {
    const sid = normalizeId(id)
    const entry = this.manifest.entries[sid]
    if (!entry) throw new Error(`not cold: ${sid}`)
    const coldDir = path.join(this.layout.sessions, sid)
    const coldDoc = path.join(this.layout.projcache, `${sid}.json`)
    // Restore into the directory name the session actually had; a migration-era
    // name is not always `dirName(id)`.
    const liveDir = path.join(this.liveRoot, entry.projectDir, entry.dirName || dirName(sid))
    const liveDoc = this.projcachePath(sid)

    // Everything that can refuse is checked before anything moves, then the
    // moves are ordered so a failure can put the cold copy back.
    const transcript = await findTranscript(coldDir)
    if (!transcript) throw new Error(`cold transcript missing for ${sid}`)
    const digest = await sha256File(transcript)
    if (entry.sha256 && digest !== entry.sha256) {
      throw new Error(`digest mismatch for ${sid}; refusing to restore a changed transcript`)
    }
    const dirRefusal = await destinationRefusal(liveDir)
    if (dirRefusal) throw new Error(`${sid}: ${dirRefusal}`)

    await movePath(coldDir, liveDir)
    let docMoved = false
    try {
      if (entry.projcacheDoc && existsSync(coldDoc)) {
        // The cold document is the authoritative one at restore time; DSH may
        // have written a fresh one when it re-listed the session.
        await moveFileReplace(coldDoc, liveDoc)
        docMoved = true
      }
      delete this.manifest.entries[sid]
      await this.saveManifest()
      if (this.index) await this.index.remove(sid).catch(() => {})
      return { id: sid, dir: liveDir }
    } catch (error) {
      // Put the cold copy back so the manifest keeps describing reality.
      this.manifest.entries[sid] = entry
      if (docMoved) await moveFileReplace(liveDoc, coldDoc).catch(() => {})
      await movePath(liveDir, coldDir).catch(() => {})
      throw error
    }
  }

  /** Move one cold session to `trash/`; recoverable, never unlinked. */
  async trashOne(id) {
    const sid = normalizeId(id)
    const entry = this.manifest.entries[sid]
    if (!entry) throw new Error(`not cold: ${sid}`)
    const target = path.join(this.layout.trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${sid}`)
    await movePath(path.join(this.layout.sessions, sid), target)
    try {
      delete this.manifest.entries[sid]
      await this.saveManifest()
    } catch (error) {
      // The trash copy is the only copy; a failed manifest write must not leave
      // it unrecorded.
      this.manifest.entries[sid] = entry
      await movePath(target, path.join(this.layout.sessions, sid)).catch(() => {})
      throw error
    }
    if (this.index) await this.index.remove(sid).catch(() => {})
    return { id: sid, dir: target }
  }

  /** First `PREVIEW_CHARS` characters of a cold transcript. */
  async previewOne(id) {
    const entry = this.manifest.entries[normalizeId(id)]
    if (!entry) throw new Error(`not cold: ${normalizeId(id)}`)
    const transcript = await findTranscript(path.join(this.layout.sessions, normalizeId(id)))
    if (!transcript) throw new Error('cold transcript missing')
    const text = extractText(await readFile(transcript))
    return { entry, preview: text.slice(0, PREVIEW_CHARS) }
  }
}

/**
 * Order transcripts newest-format-first.
 *
 * A session directory accumulates one transcript per format generation
 * (`session.jsonl.zstd` is the oldest, then `session.v2`, `session.v3`,
 * `session.v4`). Read in `readdir` order, the first match can be a v2 stub
 * holding a single header line, so the highest version must win.
 */
function transcriptVersion(name) {
  const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name)
  if (!match) return name.endsWith('.zstd') ? -1 : -2
  return match[1] ? Number(match[1]) : 0
}

/** Locate a session's newest transcript file inside its directory. */
async function findTranscript(dir) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const candidates = names.filter((n) => n.endsWith('.zstd')).sort((a, b) => transcriptVersion(b) - transcriptVersion(a))
  return candidates.length ? path.join(dir, candidates[0]) : undefined
}

/** Total bytes of one session directory, all formats included. */
async function dirBytes(dir) {
  let total = 0
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    total += await sizeOf(path.join(dir, entry.name))
  }
  return total
}

/**
 * Decode a session journal, which is **not** a single zstd frame.
 *
 * Session logs are appended one frame per write, so a file is a concatenation
 * of independent zstd frames. Node's one-shot decoder stops after the first
 * frame, which silently yields only the header line. Split on the frame magic
 * and decode each frame; a frame that fails to decode (a false-positive magic
 * inside compressed bytes) is skipped rather than losing the whole log.
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function decompressJournal(buffer) {
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZSTD_MAGIC)) return buffer
  const starts = []
  let at = buffer.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    starts.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + 1)
  }
  if (starts.length <= 1) return zstdDecompressSync(buffer)
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[i], end)))
    } catch {
      /* a false frame boundary: skip this slice, keep the rest */
    }
  }
  if (!parts.length) return zstdDecompressSync(buffer)
  return Buffer.concat(parts)
}

/**
 * Events whose payload is human prose worth indexing.
 *
 * A session log also carries the assembled system prompt, tool schemas, raw
 * tool arguments and streamed deltas. Indexing those would make every session
 * match every tool name and bloat each document by megabytes, so only the
 * conversational events are harvested.
 */
const CONTENT_EVENTS = new Set([
  'user/message',
  'assistant/message',
  'session/title',
  'compaction/summary',
])

/** Hard ceiling on one session's indexed text; ~2 MB of prose is ample. */
const MAX_TEXT_CHARS = 400_000

/**
 * Best-effort plaintext from a compressed session log.
 *
 * @param {Buffer} buffer compressed (multi-frame) or already-plain journal bytes
 * @returns {string} newline-joined prose for the full-text index
 */
export function extractText(buffer) {
  let raw
  try {
    raw = decompressJournal(buffer)
  } catch {
    return ''
  }
  const out = []
  let budget = MAX_TEXT_CHARS
  for (const line of raw.toString('utf8').split('\n')) {
    if (budget <= 0) break
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || !CONTENT_EVENTS.has(event.type)) continue
    const before = out.length
    collectStrings(event.data ?? event, out, 0)
    for (let i = before; i < out.length; i += 1) budget -= out[i].length + 1
  }
  return out.join('\n')
}

function collectStrings(value, out, depth) {
  if (value == null || depth > 12) return
  if (typeof value === 'string') {
    if (value.length > 1) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      // Skip bulky structured payloads that carry no human prose.
      if (key === 'base64' || key === 'signature' || key === 'type' || key === 'role' || key === 'kind') continue
      collectStrings(value[key], out, depth + 1)
    }
  }
}

/** Cheap aggregate of the live root, for the status strip. */
export async function liveStats(store) {
  const live = await store.liveSessions()
  return { count: live.length, bytes: live.reduce((n, s) => n + s.bytes, 0) }
}

/** Cheap aggregate of the cold tier, for the status strip. */
export function coldStats(store) {
  const entries = store.coldEntries()
  return { count: entries.length, bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0) }
}
