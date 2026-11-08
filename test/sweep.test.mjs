/**
 * Engine tests for the coldstore tiering policy.
 *
 * Runs entirely inside a temp directory: it never reads or moves a real
 * session. `node test/sweep.test.mjs` -> prints `PASS n` and exits 0.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Coldstore } from '../lib/sweep.js'
import { normalizeId } from '../lib/manifest.js'

const DAY = 86_400_000
let passed = 0
const failures = []

async function test(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

/** Build a fixture with one live session and its projection-cache document. */
async function fixture({ lastPromptDaysAgo = 30, createdDaysAgo = 40, pinned = [], title = 'Test session', goal, todos, origin, ageTheLedger = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'coldstore-test-'))
  const liveRoot = path.join(root, 'sessions')
  const projcacheRoot = path.join(root, 'projcache')
  const coldRoot = path.join(root, 'cold')
  const sessionId = 'session-aaaa-1111'
  const dir = path.join(liveRoot, '--project--', 'aaaa-1111')
  await mkdir(dir, { recursive: true })
  await mkdir(projcacheRoot, { recursive: true })

  const journal = [
    JSON.stringify({ type: 'user/message', content: 'please summarise the quarterly numbers' }),
    JSON.stringify({ type: 'assistant/message', content: 'here is the summary of the quarterly numbers' }),
  ].join('\n')
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(journal)))

  await writeFile(path.join(projcacheRoot, `${sessionId}.json`), JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: Date.now() - createdDaysAgo * DAY, cwd: '/tmp/project', origin },
      rows: {
        title: { val: title },
        workingDirectory: { val: '/tmp/project' },
        sessionListMetadata: { val: { blank: false, lastPromptAt: Date.now() - lastPromptDaysAgo * DAY } },
        ...(goal ? { goal: { val: goal } } : {}),
        ...(todos ? { todos: { val: todos } } : {}),
      },
    },
  }))

  if (ageTheLedger) {
    // Pretend the plugin has been observing for 60 days, so a session created
    // today is inside its observation window.
    await mkdir(coldRoot, { recursive: true })
    await writeFile(path.join(coldRoot, 'read.json'), JSON.stringify({
      version: 1,
      installedAt: Date.now() - 60 * DAY,
      opened: {},
    }))
  }

  const store = await new Coldstore({ coldRoot, liveRoot, projcacheRoot }).load()
  return { root, store, sessionId, dir, liveRoot, projcacheRoot, coldRoot, pinned }
}

await test('classifies an old idle session as a freeze candidate', async () => {
  const f = await fixture()
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.candidates[0].id, f.sessionId)
  assert.equal(plan.exempt.length, 0)
  assert.ok(plan.totals.bytes > 0)
})

await test('too-new sessions are exempt', async () => {
  const f = await fixture({ lastPromptDaysAgo: 1 })
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.candidates.length, 0)
  assert.equal(plan.exempt[0].reason, 'too-new')
})

await test('a session created after observation began and never opened is exempt as unread', async () => {
  const f = await fixture({ createdDaysAgo: 0, lastPromptDaysAgo: 30, ageTheLedger: true })
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.candidates.length, 0)
  assert.equal(plan.exempt[0].reason, 'unread')
})

await test('a session older than observation is NOT exempt just because it was never opened', async () => {
  const f = await fixture({ createdDaysAgo: 40 })
  // Opening one unrelated session used to poison the whole backlog into `unread`.
  await f.store.markOpened('session-someone-else')
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.candidates.length, 1, 'the backlog must still freeze')
  assert.equal(plan.exempt.length, 0)
})

await test('pinned sessions are exempt', async () => {
  const f = await fixture()
  const plan = await f.store.plan({ retainDays: 7, pinnedIds: [f.sessionId] })
  assert.equal(plan.candidates.length, 0)
  assert.equal(plan.exempt[0].reason, 'pinned')
})

await test('starred sessions are exempt', async () => {
  const f = await fixture()
  await f.store.setStarred(f.sessionId, true)
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.candidates.length, 0)
  assert.equal(plan.exempt[0].reason, 'starred')
})

await test('live sessions are exempt', async () => {
  const f = await fixture()
  const plan = await f.store.plan({ retainDays: 7, isLive: () => true })
  assert.equal(plan.candidates.length, 0)
  assert.equal(plan.exempt[0].reason, 'live')
})

await test('an active goal is exempt', async () => {
  const f = await fixture({ goal: { goal: { objective: 'finish the thing', phase: 'active' }, roundsStarted: 2 } })
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.exempt[0].reason, 'goal')
})

await test('in-progress todos are exempt', async () => {
  const f = await fixture({ todos: [{ content: 'ship it', status: 'in_progress' }] })
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.exempt[0].reason, 'todo')
})

await test('subagent sessions are exempt', async () => {
  const f = await fixture({ origin: 'subagent' })
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.exempt[0].reason, 'subagent')
})

await test('freeze moves the dir, writes a manifest entry with a digest, and restore round-trips', async () => {
  const f = await fixture()
  const [live] = await f.store.liveSessions()
  const meta = await f.store.metadata(live.id)
  const entry = await f.store.freezeOne(live, meta)

  assert.equal(existsSync(f.dir), false, 'live dir should be gone')
  assert.equal(existsSync(path.join(f.coldRoot, 'sessions', f.sessionId)), true, 'cold dir should exist')
  assert.equal(existsSync(path.join(f.projcacheRoot, `${f.sessionId}.json`)), false, 'cache doc should move')
  assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  assert.equal(entry.title, 'Test session')

  const persisted = JSON.parse(await readFile(path.join(f.coldRoot, 'manifest.json'), 'utf8'))
  assert.ok(persisted.entries[f.sessionId], 'manifest must persist')

  const restored = await f.store.restoreOne(f.sessionId)
  assert.equal(restored.id, f.sessionId)
  assert.equal(existsSync(f.dir), true, 'live dir should be back')
  assert.equal(existsSync(path.join(f.coldRoot, 'sessions', f.sessionId)), false)
  assert.equal(existsSync(path.join(f.projcacheRoot, `${f.sessionId}.json`)), true, 'cache doc should return')
  assert.deepEqual(f.store.coldEntries(), [])
})

await test('restore refuses a transcript whose digest changed', async () => {
  const f = await fixture()
  const [live] = await f.store.liveSessions()
  await f.store.freezeOne(live, await f.store.metadata(live.id))
  const coldFile = path.join(f.coldRoot, 'sessions', f.sessionId, 'session.v4.jsonl.zstd')
  await writeFile(coldFile, zstdCompressSync(Buffer.from('{"type":"user/message","content":"tampered"}')))
  await assert.rejects(() => f.store.restoreOne(f.sessionId), /digest mismatch/)
})

await test('delete moves to trash instead of unlinking', async () => {
  const f = await fixture()
  const [live] = await f.store.liveSessions()
  await f.store.freezeOne(live, await f.store.metadata(live.id))
  const { dir } = await f.store.trashOne(f.sessionId)
  assert.equal(existsSync(dir), true, 'trashed session must still exist')
  assert.ok(dir.includes(`${path.sep}trash${path.sep}`))
  assert.equal(f.store.coldEntries().length, 0)
})

await test('commit moves exactly the staged ids and skips what stopped qualifying', async () => {
  const f = await fixture()
  const staged = await f.store.plan({ retainDays: 7 })
  assert.equal(staged.candidates.length, 1)
  // Between review and commit the user stars it — the checker must not freeze it.
  await f.store.setStarred(f.sessionId, true)
  const result = await f.store.commit([f.sessionId], { retainDays: 7 })
  assert.equal(result.moved.length, 0)
  assert.deepEqual(result.skipped, [{ id: f.sessionId, reason: 'no-longer-eligible' }])
  assert.equal(existsSync(f.dir), true, 'nothing may move')
})

await test('commit skips a session that became live after staging', async () => {
  const f = await fixture()
  const result = await f.store.commit([f.sessionId], { retainDays: 7, isLive: () => true })
  assert.equal(result.moved.length, 0)
  assert.deepEqual(result.skipped, [{ id: f.sessionId, reason: 'live' }])
})

await test('commit freezes a staged id that still qualifies', async () => {
  const f = await fixture()
  const result = await f.store.commit([f.sessionId], { retainDays: 7 })
  assert.equal(result.moved.length, 1)
  assert.equal(result.skipped.length, 0)
  assert.equal(existsSync(f.dir), false, 'the session must have moved')
  assert.equal(f.store.coldEntries().length, 1)
})

await test('a second load sees the manifest written by the first', async () => {
  const f = await fixture()
  const [live] = await f.store.liveSessions()
  await f.store.freezeOne(live, await f.store.metadata(live.id))
  const reopened = await new Coldstore({ coldRoot: f.coldRoot, liveRoot: f.liveRoot, projcacheRoot: f.projcacheRoot }).load()
  assert.equal(reopened.coldEntries().length, 1)
})

await test('the newest transcript format wins when a dir holds several', async () => {
  const f = await fixture()
  // Migration artefact: an older v2 stub sits beside the v4 log.
  await writeFile(path.join(f.dir, 'session.v2.jsonl.zstd'), zstdCompressSync(Buffer.from('{"type":"session"}')))
  await writeFile(path.join(f.dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from('{"type":"session"}')))
  const [live] = await f.store.liveSessions()
  assert.match(live.transcript, /session\.v4\.jsonl\.zstd$/)
  assert.ok(live.bytes >= 3, 'bytes must count the whole directory, not one file')
})

await test('restore puts the session back under its original directory name', async () => {
  const f = await fixture()
  const [live] = await f.store.liveSessions()
  // A migration-era directory name keeps the `session-` prefix on disk.
  const prefixed = path.join(path.dirname(f.dir), 'session-aaaa-1111')
  await rename(f.dir, prefixed)
  const [again] = await f.store.liveSessions()
  const entry = await f.store.freezeOne(again, await f.store.metadata(again.id))
  assert.equal(entry.dirName, 'session-aaaa-1111', 'the on-disk name must be recorded')
  await f.store.restoreOne(f.sessionId)
  assert.equal(existsSync(prefixed), true, 'restore must not silently rename the directory')
})

await test('normalizeId adds the missing session- prefix', async () => {
  assert.equal(normalizeId('aaaa-1111'), 'session-aaaa-1111')
  assert.equal(normalizeId('session-aaaa-1111'), 'session-aaaa-1111')
})

if (failures.length) {
  console.error(`FAIL ${failures.length}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS ${passed}`)
