# Internal contract — host ↔ client ↔ index engine

Authoritative on-disk layout and HTTP route shapes for this package.
Every part of the plugin codes against THIS file. If a shape changes, change it
here first.

## Layout

```
~/.dsh/sessions/                 <- live root, owned by DSH (readdir scanned per list)
  <project>/<sessionId>/session.v4.jsonl.zstd
~/.dsh/storages/session_projcache/sessions/session-<uuid>.json   <- projection cache doc
~/.dsh/coldstore/                <- this plugin's cold tier (config: coldRoot)
  manifest.json                  <- {"version":1,"entries":{"<id>":Entry}}
  stars.json                     <- {"version":1,"ids":["<id>", ...]}
  index.sqlite                   <- FTS5 index (cold rows only)
  sessions/<sessionId>/          <- moved session dir, byte-identical
  projcache/<sessionId>.json     <- moved projection-cache doc
  trash/<timestamp>-<sessionId>/ <- delete target (recoverable)
```

Session ids in the DSH registry carry the `session-` prefix
(`session-8cd1...`). Directory names on disk may omit it; normalize on read:
`id = name.startsWith('session-') ? name : 'session-' + name`.
The projection-cache filename is always the bare `<sessionId>.json`.

## Entry (manifest.json)

```ts
type Entry = {
  id: string              // canonical session id, with session- prefix
  projectDir: string      // original ~/.dsh/sessions/<project> basename
  dirName: string         // on-disk directory name, which may differ from dirName(id)
  frozenAt: number        // epoch ms
  lastPromptAt: number    // epoch ms, from the projection cache
  title: string
  cwd: string
  bytes: number           // session.v4.jsonl.zstd size
  sha256: string          // of the moved transcript, verified on restore
  projcacheDoc: boolean   // whether a cache doc was moved with it
}
```

## Index engine (`lib/index-engine.js`)

Default export: `class ColdIndex`.

```js
new ColdIndex({ indexPath })            // synchronous constructor, does not open
await idx.open()                        // opens/creates sqlite + schema; idempotent
await idx.add(entry, text)              // add/replace one cold row
await idx.remove(id)                    // drop one row
await idx.search({ q, limit, offset, from, to, starred })  // -> { items, total }
await idx.get(id)                       // -> { id, doc } | undefined
await idx.close()
```

`text` is the plaintext extracted from the transcript; `search()` returns
`items: [{ id, snippet }]`. Snippet is the FTS5 `snippet()` output, no longer
than 240 chars.

Use `node:sqlite` (`DatabaseSync`) with `CREATE VIRTUAL TABLE ... USING fts5`.
Decompression is `zlib.zstdDecompressSync` from `node:zlib` (Node 22.15+).
Do not add npm dependencies.

## Host ↔ Client HTTP routes

Base: `/session-coldstore/api`. All JSON. Register one **prefix** route —
`ctx.webServer.register({ kind: 'prefix', path: '/session-coldstore', handler(req, res) })` —
and answer inside `handler` by writing the response yourself
(`res.writeHead(status, headers)` then `res.end(body)`). There is no returned
`Response` object; the host owns the socket.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/status` | – | `{ retainDays, dryRun, coldRoot, version, live:{count,bytes}, cold:{count,bytes}, stars:number, index:{rows}, lastSweep, batch:{id,createdAt,count,bytes}\|null, keepPinned, keepStarred, keepUnread, minIdleMs, notifyOnSweep }` |
| GET | `/plan` | `?days=` | `{ candidates: V[], exempt: E[], totals:{count,bytes} }` |
| POST | `/sweep` | – | **stages** a batch, moves nothing: `{ id, createdAt, retainDays, candidates: V[], exempt: E[], totals }` |
| GET | `/batch` | – | `{ batch: Batch \| null }` |
| POST | `/commit` | `{ batchId }` | `{ batchId, moved: V[], skipped: {id,reason}[], bytes }` — refuses under `dryRun` or on a stale `batchId` |
| POST | `/discard` | – | `{ ok: true }` |
| POST | `/freeze` | `{ ids: string[] }` | `{ moved: V[], failed: {id,error}[] }` — direct (no staging checkpoint), but **not** a policy bypass: under `dryRun` it refuses with 409, and every exemption still holds, so it moves only what a sweep would |
| POST | `/restore` | `{ ids: string[] }` | `{ restored: string[], failed: {id,error}[] }` |
| GET | `/search` | `?q&limit&offset&from&to&starred` | `{ items: R[], total }` |
| GET | `/session` | `?id=` | `{ entry: Entry, preview: string }` |
| POST | `/star` | `{ id, starred: boolean }` | `{ ok: true }` — accepts **any** session id, cold or live, so a session can be protected *before* it freezes |
| POST | `/delete` | `{ ids: string[] }` | `{ trashed: string[], failed: {id,error}[] }` — an explicit delete acts even under `dryRun`; it moves to `trash/` and never unlinks |
| POST | `/config` | any of `{ retainDays, dryRun, keepPinned, keepStarred, keepUnread, minIdleMs, notifyOnSweep }` | `{ ok: true }` — **merges** into `coldRoot/config.json`; a partial patch never drops an earlier choice |
| POST | `/reindex` | – | `{ rows }` |

Types:

```ts
type V = { id: string, title: string, cwd: string, lastPromptAt: number, bytes: number, projectDir: string }
type E = { id: string, title: string, reason: 'pinned'|'starred'|'unread'|'live'|'goal'|'todo'|'subagent'|'too-new'|'already-cold' }
type R = V & { snippet: string, starred: boolean }
```

Errors: non-2xx with `{ error: string }`.

## Maker / checker

Two sweep paths, deliberately different:

| Path | Trigger | Behaviour |
|---|---|---|
| **Manual** | the Settings page | `POST /sweep` **stages** a batch and persists it to `coldRoot/pending.json`; `POST /commit {batchId}` moves exactly that batch. The reviewed set is the committed set. |
| **Automatic** | boot (`sweepOnBoot`) and the interval timer (`sweepIntervalMinutes`) | plans and moves in one step, no checkpoint. `dryRun: true` still blocks every move. When it moves anything it posts a native notification (`notifyOnSweep`) and clears any staged manual batch, which is stale by then. |

At commit time the Host **re-derives eligibility** and skips anything that stopped
qualifying since it was staged — newly pinned, starred, opened, live, or aged
back inside `retainDays`. Those skips are returned, not silently applied.

A stale `batchId` is rejected, so a plan reviewed in one tab cannot commit a
different plan staged in another.

## Exemption rules (host-side, in this order)

`Coldstore.classify` returns the first reason that applies, so this order is
observable in `GET /plan` and in the `skipped` list a commit returns.

0. `already-cold` — the id is already in the manifest. This is a skip, not an
   exemption: it is checked before anything else because a cold id has no live
   directory left to move.
1. `live` — a live agent exists for the id (`ctx.agents` predicate). There is
   no lock file and no lease; liveness is the whole guard.
2. `pinned` — id in `workspaceRegistry.pinnedSessionIds`.
3. `starred` — id in `stars.json` (set from the portal's plan list or a cold
   row; reachable *before* freezing, which is the point).
4. `unread` — the id has no entry in the plugin's own `read.json` ledger, **and**
   the session was created after the ledger started observing
   (`ledger.installedAt`). Sessions older than installation have no read history
   to consult, so they fall through to `retainDays` / pin / star instead of
   being exempt forever.
5. `goal` — projection `goal` value has `phase` not in `complete|cancelled`.
6. `todo` — projection `todos` contains a non-completed item.
7. `subagent` — projection `origin === 'subagent'` or parentSessionId present.
8. `too-new` — `lastPromptAt` (or `createdAt`) newer than
   `max(retainDays, minIdleMs)`.

## Safety rules

- Never add a session to the cold tier while `dryRun` is on, on any path
  (sweep, commit, direct freeze). `restore` and `delete` are explicit,
  recoverable actions and are not gated by it.
- Never move a live session, and never let naming a session bypass an exemption.
- Never overwrite a populated destination: `movePath` replaces an *empty*
  directory only and otherwise throws, so a stale copy cannot silently destroy a
  transcript.
- Never strand a session: move into coldstore first, write the manifest, and if
  the manifest write fails, move it straight back.
- `restore` verifies the recorded sha256 before handing a transcript back. The
  CLI does the same and refuses on a mismatch unless `--force` is passed.
- `delete` moves to `coldstore/trash/`, never unlinks.
