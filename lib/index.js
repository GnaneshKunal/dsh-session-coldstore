/**
 * Session Coldstore — tiered storage for DSH sessions.
 *
 * Old sessions leave the live root (so they stop costing the sidebar, the
 * listing scan, and any full-text index build) and land in `~/.dsh/coldstore`
 * byte-identical, with a sha256 manifest entry and an on-disk FTS5 index.
 * Nothing is ever deleted: `restore` moves a session back, `delete` moves it
 * to `coldstore/trash/`.
 *
 * The plugin owns a Settings page (`lib/client.js`) and talks to it over one
 * HTTP route prefix, `/session-coldstore`.
 *
 * @module @gnanesh/dsh-session-coldstore
 */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import ColdIndex from './index-engine.js'
import { Coldstore, coldStats, liveStats } from './sweep.js'
import { DSH_HOME, normalizeId, readJson, writeJsonAtomic } from './manifest.js'

export const name = 'session-coldstore'

/**
 * Defaults for every tunable. Exported as plain data rather than a
 * Schemastery `Config` schema on purpose: this bundle is linked from a local
 * checkout, so a profile-shipped package such as `@deepseek-ai/schemastery`
 * does not resolve from its directory. Defaults are merged in `apply` instead,
 * and `cordis.patch.yml` / `coldstore/config.json` override any of them.
 */
export const DEFAULTS = {
  retainDays: 7,
  dryRun: true,
  coldRoot: path.join(DSH_HOME, 'coldstore'),
  keepPinned: true,
  keepStarred: true,
  keepUnread: true,
  minIdleMs: 3_600_000,
  sweepOnBoot: true,
  sweepIntervalMinutes: 720,
  indexCold: true,
  notifyOnSweep: true,
}

const ROUTE = '/session-coldstore'

/** Reported by /status. CI keeps it equal to package.json's version. */
export const VERSION = '0.1.2'

/**
 * Why a session named in a direct `POST /freeze` may not be frozen, or null.
 *
 * Pure on purpose: the guard is the plugin's safety contract, so it is tested
 * without standing up the host. A named session gets no exemption bypass —
 * dry run, liveness and every policy exemption hold exactly as they do in a
 * sweep.
 */
export function freezeRefusal({ id, dryRun, eligible, exempt, liveIds, hasLiveDir }) {
  if (dryRun) return 'dry run'
  if (liveIds.has(id)) return 'session is live'
  const reason = exempt.get(id)
  if (reason) return `exempt: ${reason}`
  if (!eligible.has(id)) return 'not a freeze candidate'
  if (!hasLiveDir) return 'not found in the live root'
  return null
}

/** Row config merged with the overrides the portal saved at runtime. */
async function resolvedConfig(config) {
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const overrides = await readJson(path.join(merged.coldRoot, 'config.json'), {})
  return { ...merged, ...(overrides && typeof overrides === 'object' ? overrides : {}) }
}

/** Escape one AppleScript string literal. */
export function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
}

/**
 * Build the `osascript` invocation for a sweep summary.
 *
 * Kept pure so it can be asserted without posting a real notification.
 *
 * @param {string} message body text (already human-readable)
 * @param {string} [title] notification title
 * @param {string} [sound] macOS sound name; omit for silent
 * @returns {string} the `-e` script argument
 */
export function buildNotificationScript(message, title = 'DSH Coldstore', sound = 'Glass') {
  const soundClause = sound ? ` sound name "${appleScriptString(sound)}"` : ''
  return `display notification "${appleScriptString(message)}" with title "${appleScriptString(title)}"${soundClause}`
}

/**
 * Post a macOS notification. Never throws: a missing notifier or a denied
 * permission must not fail a sweep that already did its work.
 */
export function notifyDesktop(script, logger) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve(false)
      return
    }
    execFile('osascript', ['-e', script], { timeout: 5_000 }, (error) => {
      if (error) {
        logger?.warn?.(`coldstore: notification failed: ${String(error.message || error)}`)
        resolve(false)
        return
      }
      resolve(true)
    })
  })
}

/** Human summary of one automatic sweep. */
export function sweepSummary(result) {
  const moved = result.moved?.length || 0
  const mb = ((result.bytes || 0) / 1048576).toFixed(1)
  const skipped = result.skipped?.length || 0
  return `${moved} session${moved === 1 ? '' : 's'} frozen (${mb} MB) · ${skipped} kept live`
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? { warn() {}, info() {} }

  /** Shared activation state; declared before any effect so callbacks may read it. */
  const state = {
    store: undefined,
    settings: { ...DEFAULTS, ...(config || {}) },
    lastSweep: 0,
    closed: false,
    liveIds: new Set(),
  }

  // ── engine ─────────────────────────────────────────────────────────────
  ctx.effect(() => {
    let disposed = false
    const boot = async () => {
      const settings = await resolvedConfig(config)
      state.settings = settings
      let index
      if (settings.indexCold) {
        index = new ColdIndex({ indexPath: path.join(settings.coldRoot, 'index.sqlite') })
        try {
          await index.open()
        } catch (error) {
          logger.warn(`coldstore: index unavailable, search disabled: ${String(error)}`)
          index = undefined
        }
      }
      const store = await new Coldstore({ coldRoot: settings.coldRoot, index, logger }).load()
      if (disposed) {
        await index?.close?.().catch?.(() => {})
        return
      }
      state.store = store
      if (settings.dryRun) logger.warn('coldstore: dry run is on — sweeps report without moving sessions')
    }
    void boot().catch((error) => logger.warn(`coldstore: activation failed: ${String(error)}`))
    return () => {
      disposed = true
      state.closed = true
      const index = state.store?.index
      if (index) void Promise.resolve(index.close?.()).catch(() => {})
    }
  }, 'session-coldstore: engine')

  const store = () => state.store
  const isLive = (id) => state.liveIds.has(id)

  // ── live agents ────────────────────────────────────────────────────────
  const refreshLive = (agents) => {
    const ids = new Set()
    try {
      for (const agent of agents.list()) {
        const id = agent?.session?.header?.id ?? agent?.id
        if (id) ids.add(id)
      }
    } catch {
      /* treat an unreadable registry as "no live agents" */
    }
    state.liveIds = ids
  }

  ctx.effect(() => ctx.inject(['agents'], (child) => {
    const agents = child.agents
    refreshLive(agents)
    const off = child.on('agent/created', (payload) => {
      refreshLive(agents)
      const id = payload?.agent?.session?.header?.id ?? payload?.session?.header?.id
      if (id && state.store) void state.store.markOpened(id).catch(() => {})
    })
    return () => {
      try {
        off?.()
      } catch {
        /* ignore */
      }
    }
  }).dispose, 'session-coldstore: live-agents')

  const pinnedIds = () => {
    try {
      return ctx.workspaceRegistry?.pinnedSessionIds ?? []
    } catch {
      return []
    }
  }

  const policyFor = (settings) => ({
    retainDays: settings.retainDays,
    keepPinned: settings.keepPinned,
    keepStarred: settings.keepStarred,
    keepUnread: settings.keepUnread,
    minIdleMs: settings.minIdleMs || 0,
    pinnedIds: pinnedIds(),
    isLive,
  })

  // ── maker / checker ────────────────────────────────────────────────────
  const pendingPath = () => path.join(state.settings.coldRoot, 'pending.json')

  const loadBatch = async () => {
    const saved = await readJson(pendingPath(), null)
    state.batch = saved && Array.isArray(saved.candidates) ? saved : null
    return state.batch
  }

  const clearBatch = async () => {
    state.batch = null
    try {
      await writeJsonAtomic(pendingPath(), null)
    } catch {
      /* the batch is only a staged intent; failing to clear it is not fatal */
    }
  }

  /** Maker step: freeze a reviewed candidate set as a pending batch. */
  const stageBatch = async (settings) => {
    const engine = store()
    if (!engine) throw new Error('coldstore is still starting up')
    const plan = await engine.plan(policyFor(settings))
    const batch = {
      id: `b${Date.now().toString(36)}`,
      createdAt: Date.now(),
      retainDays: settings.retainDays,
      candidates: plan.candidates,
      exempt: plan.exempt,
      totals: plan.totals,
    }
    await mkdir(settings.coldRoot, { recursive: true })
    await writeJsonAtomic(pendingPath(), batch)
    state.batch = batch
    return batch
  }

  /**
   * Automatic sweep: plan and move in one step, with no human checkpoint.
   *
   * Used by the boot sweep and the interval timer only. Manual, user-initiated
   * sweeps go through `stageBatch` + `commitBatch` instead, so what a human
   * approves is exactly what moves.
   */
  const runSweepDirect = async (settings) => {
    const engine = store()
    if (!engine) throw new Error('coldstore is still starting up')
    const plan = await engine.plan(policyFor(settings))
    if (settings.dryRun) {
      return { moved: [], skipped: plan.exempt, candidates: plan.candidates, bytes: 0, dryRun: true }
    }
    const { moved, skipped } = await engine.commit(plan.candidates.map((c) => c.id), policyFor(settings))
    state.lastSweep = Date.now()
    const result = {
      moved,
      skipped: [...plan.exempt.map((e) => ({ id: e.id, reason: e.reason })), ...skipped],
      bytes: moved.reduce((n, e) => n + (e.bytes || 0), 0),
      dryRun: false,
    }
    // A staged manual batch is stale the moment an automatic sweep runs; drop it
    // so the page cannot offer a Commit for sessions that already moved.
    if (moved.length > 0 && state.batch) await clearBatch()
    if (moved.length > 0 && settings.notifyOnSweep !== false) {
      void notifyDesktop(buildNotificationScript(sweepSummary(result)), logger)
    }
    return result
  }

  /** Checker step: move exactly the reviewed batch, re-validated at commit time. */
  const commitBatch = async (settings, batchId) => {
    const engine = store()
    if (!engine) throw new Error('coldstore is still starting up')
    const batch = state.batch || (await loadBatch())
    if (!batch) throw new Error('nothing is staged; run a sweep first')
    if (!batchId || batchId !== batch.id) {
      throw new Error('the staged batch changed while you were reviewing; review the new plan')
    }
    if (settings.dryRun) throw new Error('dry run is on: nothing can be committed')
    const { moved, skipped } = await engine.commit(batch.candidates.map((c) => c.id), policyFor(settings))
    await clearBatch()
    state.lastSweep = Date.now()
    return {
      batchId: batch.id,
      moved,
      skipped,
      bytes: moved.reduce((n, e) => n + (e.bytes || 0), 0),
    }
  }

  // ── schedule ───────────────────────────────────────────────────────────
  ctx.effect(() => {
    let timer
    const boot = setTimeout(() => {
      void (async () => {
        try {
          const settings = await resolvedConfig(config)
          state.settings = settings
          if (state.closed || !store()) return
          await loadBatch()
          if (settings.sweepOnBoot) await runSweepDirect(settings)
          const every = (settings.sweepIntervalMinutes || 0) * 60_000
          if (every > 0 && !state.closed) {
            timer = setInterval(() => {
              void runSweepDirect(state.settings).catch((error) => logger.warn(`coldstore: scheduled sweep failed: ${String(error)}`))
            }, every)
            timer.unref?.()
          }
        } catch (error) {
          logger.warn(`coldstore: boot sweep failed: ${String(error)}`)
        }
      })()
    }, 5_000)
    return () => {
      clearTimeout(boot)
      if (timer) clearInterval(timer)
    }
  }, 'session-coldstore: schedule')

  // ── HTTP ───────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const url = new URL(req.url, 'http://localhost')
        const route = url.pathname.slice(ROUTE.length).replace(/^\/api/, '') || '/'
        const send = (status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(payload))
        }
        const body = async () => {
          if (req.method === 'GET') return {}
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8')
          if (!raw) return {}
          try {
            return JSON.parse(raw)
          } catch {
            throw new Error('invalid JSON body')
          }
        }

        try {
          const settings = await resolvedConfig(config)
          state.settings = settings
          const engine = store()

          if (req.method === 'GET' && route === '/status') {
            if (!engine) return send(503, { error: 'coldstore is still starting up' })
            // Memory can lag the disk across a plugin reload; a staged batch the
            // user is reviewing must still render.
            if (!state.batch) await loadBatch()
            const live = await liveStats(engine)
            const cold = coldStats(engine)
            let rows = 0
            try {
              rows = engine.index ? (await engine.index.search({ q: '', limit: 1 })).total : 0
            } catch {
              rows = 0
            }
            return send(200, {
              retainDays: settings.retainDays,
              dryRun: settings.dryRun,
              coldRoot: settings.coldRoot,
              version: VERSION,
              live,
              cold,
              stars: engine.stars.ids.length,
              index: { rows },
              lastSweep: state.lastSweep || null,
              batch: state.batch
                ? {
                  id: state.batch.id,
                  createdAt: state.batch.createdAt,
                  count: state.batch.candidates.length,
                  bytes: state.batch.totals?.bytes || 0,
                }
                : null,
              keepPinned: settings.keepPinned,
              keepStarred: settings.keepStarred,
              keepUnread: settings.keepUnread,
              minIdleMs: settings.minIdleMs,
              notifyOnSweep: settings.notifyOnSweep !== false,
            })
          }

          if (!engine) return send(503, { error: 'coldstore is still starting up' })

          if (req.method === 'GET' && route === '/plan') {
            const days = url.searchParams.get('days')
            const scoped = days === null ? settings : { ...settings, retainDays: Number(days) }
            return send(200, await engine.plan(policyFor(scoped)))
          }

          if (req.method === 'POST' && route === '/sweep') {
            await body()
            return send(200, await stageBatch(settings))
          }

          if (req.method === 'GET' && route === '/batch') {
            return send(200, { batch: state.batch || (await loadBatch()) })
          }

          if (req.method === 'POST' && route === '/commit') {
            const payload = await body()
            return send(200, await commitBatch(settings, payload.batchId || payload.id))
          }

          if (req.method === 'POST' && route === '/discard') {
            await body()
            await clearBatch()
            return send(200, { ok: true })
          }

          if (req.method === 'POST' && route === '/freeze') {
            const payload = await body()
            if (!Array.isArray(payload.ids)) {
              return send(400, { error: 'ids must be an array of session ids' })
            }
            // Naming a session is not an exemption bypass: a direct freeze runs
            // the same policy a sweep does, so dryRun, liveness and every
            // exemption hold here too — freezeRefusal decides, not this route.
            const plan = await engine.plan(policyFor(settings))
            const eligible = new Set(plan.candidates.map((c) => c.id))
            const exempt = new Map(plan.exempt.map((e) => [e.id, e.reason]))
            const dirs = new Map((await engine.liveSessions()).map((s) => [s.id, s]))
            const liveIds = new Set([...dirs.keys()].filter((id) => isLive(id)))
            const moved = []
            const failed = []
            for (const raw of payload.ids) {
              const id = normalizeId(String(raw))
              const refusal = freezeRefusal({
                id,
                dryRun: settings.dryRun,
                eligible,
                exempt,
                liveIds,
                hasLiveDir: dirs.has(id),
              })
              if (refusal) {
                failed.push({ id, error: refusal })
                continue
              }
              const live = dirs.get(id)
              try {
                moved.push(await engine.freezeOne(live, await engine.metadata(id)))
              } catch (error) {
                failed.push({ id, error: String(error?.message ?? error) })
              }
            }
            // Under dry run every id above refused, so this reports rather than acts.
            if (settings.dryRun) {
              return send(409, { error: 'dry run: nothing moves until dryRun is turned off', moved, failed })
            }
            return send(200, { moved, failed })
          }

          if (req.method === 'POST' && route === '/restore') {
            const payload = await body()
            if (!Array.isArray(payload.ids)) {
              return send(400, { error: 'ids must be an array of session ids' })
            }
            const ids = payload.ids
            const restored = []
            const failed = []
            for (const raw of ids) {
              try {
                restored.push((await engine.restoreOne(String(raw))).id)
              } catch (error) {
                failed.push({ id: String(raw), error: String(error?.message ?? error) })
              }
            }
            return send(200, { restored, failed })
          }

          if (req.method === 'GET' && route === '/search') {
            const q = url.searchParams.get('q') || ''
            const limit = Number(url.searchParams.get('limit') || 20)
            const offset = Number(url.searchParams.get('offset') || 0)
            const from = url.searchParams.get('from')
            const to = url.searchParams.get('to')
            const starred = url.searchParams.get('starred')
            const result = engine.index
              ? await engine.index.search({
                q,
                limit,
                offset,
                from: from ? Number(from) : undefined,
                to: to ? Number(to) : undefined,
                starred: starred === null || starred === '' ? undefined : starred === 'true',
              })
              : { items: [], total: 0 }
            const items = result.items.map((item) => {
              const entry = engine.manifest.entries[item.id] || {}
              return {
                id: item.id,
                title: entry.title || '',
                cwd: entry.cwd || '',
                lastPromptAt: entry.lastPromptAt || 0,
                bytes: entry.bytes || 0,
                projectDir: entry.projectDir || '',
                starred: engine.isStarred(item.id),
                snippet: item.snippet || '',
              }
            })
            return send(200, { items, total: result.total })
          }

          if (req.method === 'GET' && route === '/session') {
            const id = url.searchParams.get('id')
            if (!id) return send(400, { error: 'id is required' })
            return send(200, await engine.previewOne(id))
          }

          if (req.method === 'POST' && route === '/star') {
            const { id, starred } = await body()
            if (!id) return send(400, { error: 'id is required' })
            await engine.setStarred(id, Boolean(starred))
            return send(200, { ok: true })
          }

          if (req.method === 'POST' && route === '/delete') {
            const { ids = [] } = await body()
            const trashed = []
            const failed = []
            for (const raw of ids) {
              try {
                trashed.push((await engine.trashOne(String(raw))).id)
              } catch (error) {
                failed.push({ id: String(raw), error: String(error?.message ?? error) })
              }
            }
            return send(200, { trashed, failed })
          }

          if (req.method === 'POST' && route === '/config') {
            const patch = await body()
            // Merge into the stored overrides: the page saves a partial patch
            // (dryRun always, retainDays only when valid), so replacing the
            // file would silently drop every earlier choice.
            const existing = await readJson(path.join(settings.coldRoot, 'config.json'), {})
            const next = existing && typeof existing === 'object' ? { ...existing } : {}
            if (typeof patch.retainDays === 'number') next.retainDays = Math.max(0, patch.retainDays)
            if (typeof patch.dryRun === 'boolean') next.dryRun = patch.dryRun
            if (typeof patch.keepPinned === 'boolean') next.keepPinned = patch.keepPinned
            if (typeof patch.keepStarred === 'boolean') next.keepStarred = patch.keepStarred
            if (typeof patch.keepUnread === 'boolean') next.keepUnread = patch.keepUnread
            if (typeof patch.minIdleMs === 'number') next.minIdleMs = Math.max(0, patch.minIdleMs)
            if (typeof patch.notifyOnSweep === 'boolean') next.notifyOnSweep = patch.notifyOnSweep
            await mkdir(settings.coldRoot, { recursive: true })
            await writeJsonAtomic(path.join(settings.coldRoot, 'config.json'), next)
            state.settings = { ...settings, ...next }
            return send(200, { ok: true })
          }

          if (req.method === 'POST' && route === '/reindex') {
            if (!engine.index) return send(400, { error: 'indexing is disabled' })
            let rows = 0
            for (const entry of engine.coldEntries()) {
              await engine.indexOne(entry, path.join(engine.layout.sessions, entry.id))
              rows += 1
            }
            return send(200, { rows })
          }

          return send(404, { error: `unknown route: ${req.method} ${route}` })
        } catch (error) {
          logger.warn(`coldstore: ${req.method} ${route} failed: ${String(error)}`)
          return send(500, { error: String(error?.message ?? error) })
        }
      },
    }), 'session-coldstore: route')
  }).dispose, 'session-coldstore: http')
}
