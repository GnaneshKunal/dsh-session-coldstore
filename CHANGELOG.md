# Changelog

## 0.1.2 — 2026-11-08

Closes the hole the 0.1.1 fix opened. Making `movePath` refuse to overwrite was
right for a transcript directory, but freeze and restore also move the projection
cache document: a stale document there aborted the second move *after* the session
directory had already gone somewhere the manifest did not describe.

- Freeze and restore now **preflight both destinations** (the session directory and
  its cache document) before the first move, and roll back every move if a later
  step fails. A cache document is replaced deliberately — the live copy is
  authoritative at freeze, the cold one at restore — while a transcript directory
  is never replaced. `delete` rolls back too if the manifest write fails.
- `/freeze` is decided by `freezeRefusal` for dry run as well, so its dryRun branch
  is no longer dead code; it normalizes ids and rejects a non-array body with 400.
- CLI restore gives the projection-cache document the same replace-and-rollback
  treatment as the host.
- Docs: `dryRun` is scoped exactly (it gates what *enters* cold; restore and an
  explicit delete stay available), `minIdleMs` is described as the floor it is,
  and the Entry shape documents `dirName`.
- The translation-key test now also matches the parameterized `t('key', vars)`
  calls it used to skip.

## 0.1.1 — 2026-11-08
the places where the plugin did not keep its own promises.

- **`POST /freeze` no longer bypasses the safety policy.** It moved sessions
  with `dryRun` on and skipped pin/star/unread/goal/todo/subagent. It now
  answers 409 while dry run is on and runs every exemption before moving
  anything — naming a session is never an exemption bypass.
- `movePath` no longer `rm -rf`s its destination. A populated destination is
  refused and an empty one replaced, so a stale copy cannot destroy a
  transcript.
- CLI `restore` verifies the recorded sha256 before moving a session back
  (`--force` overrides) and refuses a populated live directory.
- The Settings page's Cancel/Close buttons are translated instead of showing
  raw keys, and a test now asserts every key the UI asks for exists.
- `--cold <dir>` no longer swallows the following word as the command;
  `--help` prints usage.
- Docs corrected where they described the package inaccurately: the web
  server registration contract, a lock/lease that was never implemented, the
  real exemption precedence, the `dryRun` boundary, and the plaintext copy
  inside `index.sqlite`.
- `version` in `/status` comes from one constant, checked against
  `package.json` in CI. `engines.node` matches the declared compatibility
  range. `CHANGELOG.md` ships in the tarball.

## 0.1.0 — 2026-05-18

Initial implementation: tiered freeze/restore of DSH sessions, an FTS5 index
over the cold tier, a settings page with a staged sweep, and a standalone CLI.
