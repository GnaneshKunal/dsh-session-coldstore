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
Decompression is `zlib.zstdDecompressSync` from `node:zlib` (Node 24 has it).
Do not add npm dependencies.

## Host ↔ Client HTTP routes

Base: `/session-coldstore/api`. All JSON. Register with
`ctx.webServer.register({ method, path, handler })` and return `Response`.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/status` | – | `{ retainDays, dryRun, coldRoot, keepPinned, keepStarred, keepUnread, minIdleMs, notifyOnSweep, live:{count,bytes}, cold:{count,bytes}, stars:number, index:{rows}, lastSweep }` |
| GET | `/plan` | `?days=` | `{ candidates: V[], exempt: E[], totals:{count,bytes} }` |
| POST | `/sweep` | – | **stages** a batch, moves nothing: `{ id, createdAt, retainDays, candidates: V[], exempt: E[], totals }` |
| GET | `/batch` | – | `{ batch: Batch \| null }` |
| POST | `/commit` | `{ batchId }` | `{ batchId, moved: V[], skipped: {id,reason}[], bytes }` — refuses under `dryRun` or on a stale `batchId` |
| POST | `/discard` | – | `{ ok: true }` |
| POST | `/freeze` | `{ ids: string[] }` | `{ moved: V[], failed: {id,error}[] }` — direct, bypasses staging |
| POST | `/restore` | `{ ids: string[] }` | `{ restored: string[], failed: {id,error}[] }` |
| GET | `/search` | `?q&limit&offset&from&to&starred` | `{ items: R[], total }` |
| GET | `/session` | `?id=` | `{ entry: Entry, preview: string }` |
| POST | `/star` | `{ id, starred: boolean }` | `{ ok: true }` — accepts **any** session id, cold or live, so a session can be protected *before* it freezes |
| POST | `/delete` | `{ ids: string[] }` | `{ trashed: string[] }` |
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

1. `live` — a live agent exists for the id, or the session lease is held
   (`flock` on `<dir>/session.lock` fails with `EWOULDBLOCK`).
2. `pinned` — id in `workspaceRegistry.pinnedSessionIds`.
3. `starred` — id in `stars.json` (set from the portal's plan list or a cold
   row; reachable *before* freezing, which is the point).
4. `unread` — id never observed as the current session in `read.json`
   (the plugin's own `{id: lastOpenedAt}` ledger).
5. `goal` — projection `goal` value has `phase` not in `complete|cancelled`.
6. `todo` — projection `todos` contains a non-completed item.
7. `subagent` — projection `origin === 'subagent'` or parentSessionId present.
8. `too-new` — `lastPromptAt` (or `createdAt`) newer than `retainDays`.
9. `already-cold` — already in coldstore (not an exemption, just skip).

## Safety rules

- Never move a directory whose lease cannot be acquired.
- Never move a session that is absent from the manifest after a partial copy:
  move into coldstore first, write the manifest, and only then remove the
  source — and if the manifest write fails, move it straight back.
- `restore` verifies sha256 before deleting anything from coldstore.
- `delete` moves to `coldstore/trash/`, never unlinks.
