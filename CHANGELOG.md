# Changelog

## 0.1.1 — 2026-11-08

Fixes from a pre-release audit. A dry-run install behaves as before; these are
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
