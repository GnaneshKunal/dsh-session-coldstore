# Session Coldstore

Tiered storage for DeepSeek Harness sessions.

DSH keeps every session in one live root and re-reads it on every listing, and
any full-text index build has to chew through all of it. On a large corpus that
is fine on disk and expensive in memory. Coldstore moves sessions you have not
touched in a while out of the live root — **without deleting them** — and keeps
them searchable through an on-disk FTS5 index.

## What actually gets cheaper

| | Hot (live root) | Cold (`~/.dsh/coldstore`) |
|---|---|---|
| Sidebar / session list | yes | no |
| `readdir` listing scan | yes | no |
| Full-text index build input | yes | no |
| Disk | yes | yes — nothing is deleted |
| Restorable | — | one click, or `bin/coldstore.mjs restore` |

Coldstore does **not** reduce a running process's heap by itself: an unopened
session's transcript was never resident. What it fixes is the *corpus* — the
work every listing, search and index build has to do over it.

## Install

```
dsh plugin add @gnanesh/dsh-session-coldstore
```

Or through the Plugin Manager: install the bundle by package name. From a
checkout instead, point the same command at the directory:

```
dsh plugin add /absolute/path/to/dsh-session-coldstore
```

The bundle inserts one row:

```yaml
- insert:
    - id: session-coldstore
      name: '@gnanesh/dsh-session-coldstore'
      config:
        retainDays: 7
        dryRun: true
```

Override it in the profile's `cordis.patch.yml` by id. `dryRun: true` is the
default; nothing moves until you turn it off.

## Config

| key | default | meaning |
|---|---|---|
| `retainDays` | `7` | stay live while prompted within this many days |
| `dryRun` | `true` | sweep reports only |
| `coldRoot` | `~/.dsh/coldstore` | cold tier root |
| `keepPinned` | `true` | never freeze a pinned session |
| `keepStarred` | `true` | never freeze a starred session |
| `keepUnread` | `true` | never freeze a session never observed as opened |
| `minIdleMs` | `3600000` | extra idle requirement (ms) |
| `sweepOnBoot` | `true` | one sweep ~5 s after activation |
| `sweepIntervalMinutes` | `720` | repeat interval; `0` disables |
| `indexCold` | `true` | index text as sessions freeze |
| `notifyOnSweep` | `true` | post a macOS notification after an automatic sweep that moved something |

The Settings page writes the same keys to `~/.dsh/coldstore/config.json`, which
overrides the row config without touching your patch layer.

## Exemptions

In precedence order, a session is never frozen when it is:

1. `live` — a live agent exists for it;
2. `pinned` — in the workspace registry's pin set;
3. `starred` — starred in the portal;
4. `unread` — never observed as opened (see the limitation below);
5. `goal` — it carries a goal that is not `complete`/`cancelled`;
6. `todo` — it has a todo that is not `completed`;
7. `subagent` — a subagent child;
8. `too-new` — prompted inside `retainDays` (or `minIdleMs`).

**The `unread` limitation, stated plainly:** DSH keeps no durable "you read
this" marker — the "unopened" dot is transient client state. Coldstore keeps its
own ledger (`read.json`) from the moment it is installed. Sessions that already
existed before installation have no read history, so they are governed by
`retainDays`, pin and star instead. Review the first dry-run plan and star
anything you want protected.

## Two sweep paths

| Path | Trigger | Behaviour |
|---|---|---|
| **Manual (maker/checker)** | the Settings page | **Stage sweep** produces a reviewed batch and moves nothing. You then **Commit** — that moves exactly the batch you reviewed. A stale batch id is rejected, so a plan reviewed in one tab cannot commit a different plan staged in another. |
| **Automatic** | `sweepOnBoot`, `sweepIntervalMinutes` | plans and moves in one step, no checkpoint. `dryRun: true` still blocks every move. |

At commit the Host **re-derives eligibility** and skips anything that stopped
qualifying since staging — newly pinned, starred, opened, live, or aged back
inside `retainDays`. Those skips are reported, never silently applied.

The staged batch persists in `coldstore/pending.json`, so a page refresh keeps
showing it until you commit or discard.

## Notifications

An **automatic** sweep that actually moves something posts a native macOS
notification (`osascript`) summarising what happened, for example
*"42 sessions frozen (128.4 MB) · 480 kept live"*. Boot sweeps and interval
sweeps both do this; a sweep that moves nothing stays silent. Set
`notifyOnSweep: false` to turn it off.

This deliberately does **not** use `dsh-notify-me`. That plugin is passive and
client-side: it fires when a session goes running→idle or asks for attention,
and it exposes no API for a plugin to post a custom notification. A scheduled
sweep is not a session turn, so routing through it would silently never fire.

Notifications are best-effort: a missing `osascript` or a denied permission is
logged and never fails the sweep. The sweep also clears any staged manual batch
after it moves sessions, so the page cannot offer a Commit for sessions that
already left.

## Safety

- Nothing is deleted. `delete` moves the session to `coldstore/trash/`.
- A live session is never moved.
- Freezing writes the manifest **after** the directory moves and moves it
  straight back if that write fails — no frozen-but-unrecorded session.
- Restore verifies the sha256 recorded at freeze time and refuses a changed
  transcript.
- `bin/coldstore.mjs` needs neither the plugin nor DSH: `list`, `verify`,
  `restore --all` work from the manifest alone.

```
node bin/coldstore.mjs list
node bin/coldstore.mjs verify
node bin/coldstore.mjs restore --all --dry-run
node bin/coldstore.mjs restore --all
```

## Layout

```
~/.dsh/coldstore/
  manifest.json      entries keyed by session id, with sha256
  pending.json       the staged manual batch awaiting commit
  stars.json         starred ids (forever exempt)
  read.json          opened-session ledger
  config.json        portal-saved overrides
  index.sqlite       FTS5 index over cold sessions
  sessions/<id>/     the moved session directory, byte-identical
  projcache/<id>.json
  trash/<ts>-<id>/   delete target
```

## Tests

```
node test/sweep.test.mjs      # tiering policy + freeze/restore/trash round-trip
node test/index-engine.test.mjs  # FTS5 search, filters, hostile queries
```

Both run entirely in temp directories and never touch a real session.

## Restoring search after a sweep

Coldstore shrinks the corpus so an FTS5 reconciliation can complete. Once the
live root is small enough, re-enable DSH's own session search with a
**file-backed** index and a bounded timeout:

```yaml
- id: session-query-sqlite
  config:
    path: '/absolute/path/to/.dsh/session-query.sqlite'
    openAt: first-search
- id: optional-tool-session-query
  config:
    searchTimeoutMs: 60000
```

Never use `path: ':memory:'` with `first-search`: that puts the entire index in
the JS heap.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
