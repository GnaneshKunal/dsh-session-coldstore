# Changelog

## 0.1.0 — 2026-11-08

First public release.

- Tiered storage: freeze sessions idle for `retainDays` into `~/.dsh/coldstore`
  without deleting anything; restore them byte-identically, verified by sha256.
- Exemptions in precedence order: live, pinned, starred, unread, goal, todo,
  subagent, too-new.
- Two sweep paths: a manual stage/commit batch on the Settings page (maker/checker,
  stale batch ids refused, eligibility re-derived at commit) and an automatic
  boot/interval sweep.
- FTS5 index over cold sessions (`node:sqlite`, external-content table, transactional
  with the content table) so frozen transcripts stay searchable.
- Host API under `/session-coldstore/api`: status, plan, sweep, batch, commit,
  discard, freeze, restore, search.
- `coldstore` CLI (`bin/coldstore.mjs`) that needs neither the plugin nor DSH.
- macOS notification after an automatic sweep that actually moved something.
