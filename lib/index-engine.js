/**
 * Cold-tier FTS5 index for dsh-session-coldstore.
 *
 * Contract: API.md — "Index engine (`lib/index-engine.js`)".
 *
 * Layout: one sqlite database holds two things.
 *   cold      plain table: the metadata we filter / sort by, plus the raw
 *             plaintext document of the transcript (stored exactly once).
 *   cold_fts  FTS5 external-content table over `cold.doc`, joined by rowid.
 *
 * Every mutation writes both tables in one transaction, so the FTS index can
 * never drift from the content table (and `open()` self-checks + rebuilds if a
 * previous process died mid-flight).
 *
 * Node builtins only — `node:sqlite` (DatabaseSync) and `node:fs` / `node:path`.
 * No top-level awaits: the constructor never opens sqlite, `open()` does.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_SNIPPET_CHARS = 240
const MAX_TERMS = 32
const SNIPPET_TOKENS = 12
const SNIPPET_ELLIPSIS = '\u2026'

/** FTS5 treats these bare words as operators; users type them as words. */
const OPERATOR_WORDS = new Set(['and', 'or', 'not', 'near'])

/**
 * A single search term: a run of letters, digits or underscores. Everything
 * FTS5 would read as syntax (quotes, parentheses, `*`, `:`, `-`, `"`, `^`, `~`,
 * braces) is simply not part of a run, so it can never reach the MATCH string.
 */
const TERM_RE = /[\p{L}\p{N}_]+/gu

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cold (
  id TEXT PRIMARY KEY NOT NULL,
  project_dir TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  frozen_at INTEGER NOT NULL DEFAULT 0,
  last_prompt_at INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS cold_fts USING fts5(
  doc,
  content = 'cold',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);
CREATE INDEX IF NOT EXISTS cold_last_prompt_idx ON cold (last_prompt_at DESC);
CREATE INDEX IF NOT EXISTS cold_starred_idx ON cold (starred);
`

/**
 * @typedef {object} ColdEntry
 * @property {string} id Canonical session id, WITH the `session-` prefix.
 * @property {string} [projectDir] Original live-root project directory name.
 * @property {number} [frozenAt] Epoch ms; used when `lastPromptAt` is absent.
 * @property {number} [lastPromptAt] Epoch ms; filters and newest-first sort.
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {number} [bytes]
 * @property {boolean|number|string} [starred] Optional override; when omitted an
 *   existing row keeps its current star flag (re-index must not clear stars).
 */

/**
 * @typedef {object} SearchQuery
 * @property {string} [q] Free text. Empty/absent means "list all cold rows".
 * @property {number} [limit] 1..100, default 20.
 * @property {number} [offset] default 0.
 * @property {number|string} [from] Inclusive epoch-ms lower bound on lastPromptAt.
 * @property {number|string} [to] Inclusive epoch-ms upper bound on lastPromptAt.
 * @property {boolean|number|string} [starred] When unset, no star filter.
 */

/**
 * @typedef {object} SearchHit
 * @property {string} id
 * @property {string} snippet FTS5 `snippet()`, truncated to <= 240 chars.
 */

/**
 * Full-text index over cold (frozen) sessions.
 */
export default class ColdIndex {
  #indexPath

  #db = null

  /**
   * Synchronous, side-effect free: sqlite is not touched until `open()`.
   * @param {{ indexPath: string }} options
   */
  constructor(options = {}) {
    const indexPath = options?.indexPath
    if (typeof indexPath !== 'string' || indexPath.trim() === '') {
      throw new TypeError('ColdIndex: options.indexPath must be a non-empty string')
    }
    this.#indexPath = indexPath
  }

  get indexPath() {
    return this.#indexPath
  }

  get isOpen() {
    return this.#db !== null
  }

  /**
   * Open (or create) the database and its schema. Idempotent: a second call on
   * an open instance resolves to the same instance without re-opening.
   * @returns {Promise<this>}
   */
  async open() {
    if (this.#db) return this
    if (this.#indexPath !== ':memory:') {
      mkdirSync(dirname(this.#indexPath), { recursive: true })
    }
    const db = new DatabaseSync(this.#indexPath)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec(SCHEMA_SQL)
      this.#db = db
      this.#repairFts()
    } catch (error) {
      this.#db = null
      try {
        db.close()
      } catch {
        // The handle is already unusable; the original error is what matters.
      }
      throw error
    }
    return this
  }

  /**
   * Insert or replace one cold row. `text` is the transcript plaintext.
   *
   * `entry.starred` is optional: an existing row keeps its star flag when the
   * entry does not mention one, because manifest Entry (API.md) has no starred
   * field and re-indexing must not silently unstar sessions.
   *
   * @param {ColdEntry} entry
   * @param {string} text
   * @returns {Promise<void>}
   */
  async add(entry, text) {
    const db = this.#requireDb()
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('ColdIndex.add(entry, text): entry must be an object')
    }
    const id = normalizeId(entry.id)
    if (!id) {
      throw new TypeError('ColdIndex.add(entry, text): entry.id must be a non-empty string')
    }
    const doc = toDocumentText(text)
    const starred = toBooleanOrNull(entry.starred)
    const frozenAt = toEpochMs(entry.frozenAt) ?? 0
    const lastPromptAt = toEpochMs(entry.lastPromptAt) ?? frozenAt
    const columns = [
      asText(entry.title),
      asText(entry.cwd),
      asText(entry.projectDir ?? entry.project_dir),
      toInteger(entry.bytes, 0),
      frozenAt,
      lastPromptAt,
    ]

    this.#transaction(() => {
      const existing = db.prepare('SELECT rowid, doc, starred FROM cold WHERE id = ?').get(id)
      if (!existing) {
        const inserted = db
          .prepare(
            `INSERT INTO cold (id, title, cwd, project_dir, bytes, frozen_at, last_prompt_at, starred, doc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, ...columns, starred === null ? 0 : Number(starred), doc)
        db.prepare('INSERT INTO cold_fts (rowid, doc) VALUES (?, ?)').run(inserted.lastInsertRowid, doc)
        return
      }

      // Keep the rowid stable and remove the OLD document from the FTS index:
      // external-content FTS5 needs the previous text to delete its terms.
      const rowid = existing.rowid
      db.prepare("INSERT INTO cold_fts (cold_fts, rowid, doc) VALUES ('delete', ?, ?)").run(
        rowid,
        asText(existing.doc),
      )
      const starFlag = starred === null ? Number(existing.starred) || 0 : Number(starred)
      db.prepare(
        `UPDATE cold
            SET title = ?, cwd = ?, project_dir = ?, bytes = ?, frozen_at = ?,
                last_prompt_at = ?, starred = ?, doc = ?
          WHERE rowid = ?`,
      ).run(...columns, starFlag, doc, rowid)
      db.prepare('INSERT INTO cold_fts (rowid, doc) VALUES (?, ?)').run(rowid, doc)
    })
  }

  /**
   * Delete one cold row (no-op when absent).
   * @param {string} id
   * @returns {Promise<boolean>} true when a row was removed.
   */
  async remove(id) {
    const db = this.#requireDb()
    const key = normalizeId(id)
    if (!key) return false
    let removed = false
    this.#transaction(() => {
      const existing = db.prepare('SELECT rowid, doc FROM cold WHERE id = ?').get(key)
      if (!existing) return
      db.prepare("INSERT INTO cold_fts (cold_fts, rowid, doc) VALUES ('delete', ?, ?)").run(
        existing.rowid,
        asText(existing.doc),
      )
      db.prepare('DELETE FROM cold WHERE rowid = ?').run(existing.rowid)
      removed = true
    })
    return removed
  }

  /**
   * Set the star flag of one row. Additive to the contract: `add()` alone cannot
   * express a star toggle, and `/search?starred=` filters on this column.
   * @param {string} id
   * @param {boolean|number|string} starred
   * @returns {Promise<boolean>} true when the row existed.
   */
  async setStarred(id, starred) {
    const db = this.#requireDb()
    const key = normalizeId(id)
    const flag = toBooleanOrNull(starred)
    if (!key || flag === null) return false
    const result = db.prepare('UPDATE cold SET starred = ? WHERE id = ?').run(flag ? 1 : 0, key)
    return Number(result.changes) > 0
  }

  /**
   * Number of indexed cold rows. Additive to the contract; /status uses the
   * same number via `search({ q: '', limit: 1 }).total`.
   * @returns {Promise<number>}
   */
  async count() {
    const db = this.#requireDb()
    const row = db.prepare('SELECT COUNT(*) AS n FROM cold').get()
    return Number(row?.n ?? 0)
  }

  /**
   * Search cold rows.
   *
   * - `q` empty/absent (or containing no searchable term after sanitizing) lists
   *   every row newest-first by `lastPromptAt`, with `snippet: ''`.
   * - otherwise rows are ordered by FTS5 relevance (`rank`), then newest-first.
   * - `from`/`to` are inclusive epoch-ms bounds on `lastPromptAt`.
   * - `total` is the unpaged count under the same filters.
   *
   * @param {SearchQuery} [query]
   * @returns {Promise<{ items: SearchHit[], total: number }>}
   */
  async search(query = {}) {
    const db = this.#requireDb()
    const options = query ?? {}
    const limit = normalizeLimit(options.limit)
    const offset = normalizeOffset(options.offset)
    const filters = buildFilters(options)
    const match = buildMatch(options.q)

    if (match === null) {
      const rows = db
        .prepare(
          `SELECT c.id AS id
             FROM cold c
            WHERE 1 = 1${filters.sql}
            ORDER BY c.last_prompt_at DESC, c.id ASC
            LIMIT ? OFFSET ?`,
        )
        .all(...filters.params, limit, offset)
      const totalRow = db
        .prepare(`SELECT COUNT(*) AS n FROM cold c WHERE 1 = 1${filters.sql}`)
        .get(...filters.params)
      return {
        items: rows.map((row) => ({ id: asText(row.id), snippet: '' })),
        total: Number(totalRow?.n ?? 0),
      }
    }

    const rows = db
      .prepare(
        `SELECT c.id AS id,
                snippet(cold_fts, 0, '', '', '${SNIPPET_ELLIPSIS}', ${SNIPPET_TOKENS}) AS snippet
           FROM cold_fts
           JOIN cold c ON c.rowid = cold_fts.rowid
          WHERE cold_fts MATCH ?${filters.sql}
          ORDER BY cold_fts.rank, c.last_prompt_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(match, ...filters.params, limit, offset)
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM cold_fts
           JOIN cold c ON c.rowid = cold_fts.rowid
          WHERE cold_fts MATCH ?${filters.sql}`,
      )
      .get(match, ...filters.params)

    return {
      items: rows.map((row) => ({
        id: asText(row.id),
        snippet: truncateSnippet(row.snippet),
      })),
      total: Number(totalRow?.n ?? 0),
    }
  }

  /**
   * Full plaintext document of one cold row.
   * @param {string} id
   * @returns {Promise<{ id: string, doc: string } | undefined>}
   */
  async get(id) {
    const db = this.#requireDb()
    const key = normalizeId(id)
    if (!key) return undefined
    const row = db.prepare('SELECT id, doc FROM cold WHERE id = ?').get(key)
    if (!row) return undefined
    return { id: asText(row.id), doc: asText(row.doc) }
  }

  /**
   * Close the database. Idempotent.
   * @returns {Promise<void>}
   */
  async close() {
    const db = this.#db
    if (!db) return
    this.#db = null
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // Checkpointing is hygiene only; never fail a close over it.
    }
    db.close()
  }

  // ── internals ────────────────────────────────────────────────────────────

  #requireDb() {
    const db = this.#db
    if (!db) throw new Error('ColdIndex is not open; call await open() first')
    return db
  }

  /**
   * Rebuild the FTS index when it disagrees with the content table.
   *
   * `COUNT(*)` on an external-content FTS5 table scans the CONTENT table, so it
   * can never detect drift. The index-side row count lives in the `docsize`
   * shadow table (one entry per indexed row); a mismatch means a row exists in
   * `cold` but has no terms in the index, which would make it unsearchable.
   * Shadow tables are internal to FTS5, so any failure here is swallowed: the
   * host's /reindex route repairs individual rows.
   */
  #repairFts() {
    const db = this.#db
    try {
      const content = Number(db.prepare('SELECT COUNT(*) AS n FROM cold').get()?.n ?? 0)
      const indexed = Number(db.prepare('SELECT COUNT(*) AS n FROM cold_fts_docsize').get()?.n ?? 0)
      if (content !== indexed) {
        db.exec("INSERT INTO cold_fts (cold_fts) VALUES ('rebuild')")
      }
    } catch {
      // A damaged / unreadable index must not block startup.
    }
  }

  #transaction(work) {
    const db = this.#db
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Rollback of an already-finished transaction is harmless.
      }
      throw error
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Canonical session ids carry the `session-` prefix (API.md). This engine does
 * NOT add or strip it: ids are opaque keys chosen by the caller, so `add()`,
 * `get()` and `remove()` agree as long as the caller normalizes once.
 * @param {unknown} value
 * @returns {string} trimmed id, or '' when unusable.
 */
function normalizeId(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** @param {unknown} value */
function asText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

/** Transcript plaintext, tolerating an already-loaded buffer. */
function toDocumentText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}

/** @param {unknown} value @param {number} fallback */
function toInteger(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * Epoch ms from a number, numeric string or Date; null when unusable.
 * @param {unknown} value
 * @returns {number | null}
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  return null
}

/**
 * Strict boolean, or null for "not specified" (which means "no filter" in a
 * search, and "keep the stored flag" in add()).
 * @param {unknown} value
 * @returns {boolean | null}
 */
function toBooleanOrNull(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return null
}

/** @param {unknown} value */
function normalizeLimit(value) {
  const n = toInteger(value, DEFAULT_LIMIT)
  if (n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

/** @param {unknown} value */
function normalizeOffset(value) {
  const n = toInteger(value, 0)
  return n > 0 ? n : 0
}

/**
 * Translate user text into a safe FTS5 MATCH expression: only word runs survive,
 * each one double-quoted (quotes removed first), operator words dropped. Returns
 * null when nothing searchable remains, so callers take the list-all path
 * instead of handing FTS5 an empty MATCH string (which is a syntax error).
 * @param {unknown} q
 * @returns {string | null}
 */
function buildMatch(q) {
  if (q === undefined || q === null) return null
  const raw = typeof q === 'string' ? q : String(q)
  const terms = (raw.match(TERM_RE) ?? [])
    .filter((term) => !OPERATOR_WORDS.has(term.toLowerCase()))
    .slice(0, MAX_TERMS)
  const unique = [...new Set(terms)]
  if (unique.length === 0) return null
  return unique.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ')
}

/**
 * WHERE fragment for the shared metadata filters, aliased to `c`.
 * @param {SearchQuery} options
 * @returns {{ sql: string, params: Array<number> }}
 */
function buildFilters(options) {
  const clauses = []
  const params = []
  const from = toEpochMs(options.from)
  const to = toEpochMs(options.to)
  if (from !== null) {
    clauses.push('c.last_prompt_at >= ?')
    params.push(from)
  }
  if (to !== null) {
    clauses.push('c.last_prompt_at <= ?')
    params.push(to)
  }
  const starred = toBooleanOrNull(options.starred)
  if (starred !== null) {
    clauses.push('c.starred = ?')
    params.push(starred ? 1 : 0)
  }
  return { sql: clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`, params }
}

/**
 * FTS5 snippet() can be far longer than the UI wants (one huge token yields the
 * whole token), so hard-truncate to MAX_SNIPPET_CHARS code points.
 * @param {unknown} value
 */
function truncateSnippet(value) {
  const text = value === undefined || value === null ? '' : String(value)
  if (text.length <= MAX_SNIPPET_CHARS) return text
  const chars = Array.from(text)
  if (chars.length <= MAX_SNIPPET_CHARS) return text
  return `${chars.slice(0, MAX_SNIPPET_CHARS - 1).join('')}${SNIPPET_ELLIPSIS}`
}
