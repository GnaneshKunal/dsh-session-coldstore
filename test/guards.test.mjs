/**
 * Guards test: the promises this package makes that are cheap to break.
 *
 * Three things are checked here, each of which was wrong at some point:
 *   1. a direct freeze obeys dryRun and every exemption;
 *   2. a move never deletes a populated destination;
 *   3. every translation key the UI asks for exists.
 *
 * `node test/guards.test.mjs` -> prints `PASS n` and exits 0.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { freezeRefusal } from '../lib/index.js'
import { movePath } from '../lib/manifest.js'
import { Coldstore } from '../lib/sweep.js'

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

const none = new Map()
const noSet = new Set()
const base = { id: 'session-a', dryRun: false, eligible: new Set(['session-a']), exempt: none, liveIds: noSet, hasLiveDir: true }

// ── 1. freezeRefusal ────────────────────────────────────────────────────

await test('a candidate with nothing against it is allowed', async () => {
  assert.equal(freezeRefusal(base), null)
})

await test('dry run refuses even an eligible session', async () => {
  assert.equal(freezeRefusal({ ...base, dryRun: true }), 'dry run')
})

await test('a live session is refused', async () => {
  assert.equal(freezeRefusal({ ...base, liveIds: new Set(['session-a']) }), 'session is live')
})

await test('every exemption reason is reported, not bypassed', async () => {
  for (const reason of ['pinned', 'starred', 'unread', 'goal', 'todo', 'subagent', 'too-new', 'already-cold']) {
    assert.equal(freezeRefusal({ ...base, exempt: new Map([['session-a', reason]]) }), `exempt: ${reason}`)
  }
})

await test('a session outside the plan is refused', async () => {
  assert.equal(freezeRefusal({ ...base, eligible: new Set() }), 'not a freeze candidate')
})

await test('a session missing from the live root is refused', async () => {
  assert.equal(freezeRefusal({ ...base, hasLiveDir: false }), 'not found in the live root')
})

// ── 2. movePath ─────────────────────────────────────────────────────────

async function scratch() {
  return await mkdtemp(path.join(tmpdir(), 'coldstore-guard-'))
}

await test('movePath moves into a missing destination', async () => {
  const root = await scratch()
  const from = path.join(root, 'from')
  await mkdir(from)
  await writeFile(path.join(from, 'transcript'), 'payload')
  const to = path.join(root, 'to')
  await movePath(from, to)
  assert.equal(await readFile(path.join(to, 'transcript'), 'utf8'), 'payload')
})

await test('movePath replaces an empty destination', async () => {
  const root = await scratch()
  const from = path.join(root, 'from')
  const to = path.join(root, 'to')
  await mkdir(from)
  await mkdir(to)
  await writeFile(path.join(from, 'transcript'), 'payload')
  await movePath(from, to)
  assert.equal(await readFile(path.join(to, 'transcript'), 'utf8'), 'payload')
})

await test('movePath refuses a populated destination instead of deleting it', async () => {
  const root = await scratch()
  const from = path.join(root, 'from')
  const to = path.join(root, 'to')
  await mkdir(from)
  await mkdir(to)
  await writeFile(path.join(from, 'transcript'), 'new')
  await writeFile(path.join(to, 'transcript'), 'precious')
  await assert.rejects(() => movePath(from, to), /refusing to overwrite a non-empty path/)
  assert.equal(await readFile(path.join(to, 'transcript'), 'utf8'), 'precious')
  assert.equal(await readFile(path.join(from, 'transcript'), 'utf8'), 'new')
})

await test('movePath refuses to replace a file with a directory', async () => {
  const root = await scratch()
  const from = path.join(root, 'from')
  const to = path.join(root, 'to')
  await mkdir(from)
  await writeFile(to, 'a file lives here')
  await assert.rejects(() => movePath(from, to), /refusing to overwrite an existing file/)
  assert.equal(await readFile(to, 'utf8'), 'a file lives here')
})

// ── 2b. freeze and restore cannot strand a session ──────────────────────

async function coldstoreFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'coldstore-seq-'))
  const liveRoot = path.join(root, 'sessions')
  const projcacheRoot = path.join(root, 'projcache')
  const coldRoot = path.join(root, 'cold')
  const sid = 'session-seq-1'
  const bare = 'seq-1'
  const dir = path.join(liveRoot, '--proj--', bare)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), 'transcript')
  await mkdir(projcacheRoot, { recursive: true })
  await writeFile(path.join(projcacheRoot, `${sid}.json`), JSON.stringify({ record: { rows: { x: { val: 'live-doc' } } } }))
  const engine = await new Coldstore({ coldRoot, liveRoot, projcacheRoot }).load()
  const live = (await engine.liveSessions())[0]
  return { liveRoot, projcacheRoot, coldRoot, sid, dir, engine, live }
}

await test('freeze refuses a populated cold directory before moving anything', async () => {
  const f = await coldstoreFixture()
  const coldDir = path.join(f.coldRoot, 'sessions', f.sid)
  await mkdir(coldDir, { recursive: true })
  await writeFile(path.join(coldDir, 'session.v4.jsonl.zstd'), 'older')
  await assert.rejects(() => f.live && f.engine.freezeOne(f.live, f.engine.metadata(f.sid)), /destination is not empty/)
  assert.equal(await readFile(path.join(f.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'transcript')
  assert.deepEqual(Object.keys(f.engine.manifest.entries), [])
})

await test('freeze replaces a stale cold cache document instead of stranding', async () => {
  const f = await coldstoreFixture()
  await mkdir(path.join(f.coldRoot, 'projcache'), { recursive: true })
  await writeFile(path.join(f.coldRoot, 'projcache', `${f.sid}.json`), 'stale')
  const entry = await f.engine.freezeOne(f.live, await f.engine.metadata(f.sid))
  assert.equal(entry.projcacheDoc, true)
  assert.ok(!existsSync(f.dir), 'the live directory should have moved')
  const coldDoc = await readFile(path.join(f.coldRoot, 'projcache', `${f.sid}.json`), 'utf8')
  assert.ok(coldDoc.includes('live-doc'), 'the live document is authoritative at freeze time')
  assert.deepEqual(Object.keys(f.engine.manifest.entries), [f.sid])
})

await test('restore refuses a populated live directory and keeps the cold copy', async () => {
  const f = await coldstoreFixture()
  await f.engine.freezeOne(f.live, await f.engine.metadata(f.sid))
  await mkdir(f.dir, { recursive: true })
  await writeFile(path.join(f.dir, 'newer'), 'x')
  await assert.rejects(() => f.engine.restoreOne(f.sid), /destination is not empty/)
  assert.ok(existsSync(path.join(f.coldRoot, 'sessions', f.sid)), 'the cold copy must survive')
  assert.deepEqual(Object.keys(f.engine.manifest.entries), [f.sid])
})

await test('restore replaces a re-created live cache document', async () => {
  const f = await coldstoreFixture()
  await f.engine.freezeOne(f.live, await f.engine.metadata(f.sid))
  await writeFile(path.join(f.projcacheRoot, `${f.sid}.json`), 'recreated')
  await f.engine.restoreOne(f.sid)
  assert.ok(existsSync(f.dir))
  assert.deepEqual(Object.keys(f.engine.manifest.entries), [])
  assert.ok(!existsSync(path.join(f.coldRoot, 'sessions', f.sid)), 'the cold copy should have moved back')
})

// ── 3. translation keys ─────────────────────────────────────────────────

async function translationState() {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname))
  const dir = path.join(root, '..')
  const source = await readFile(path.join(dir, 'lib/client.js'), 'utf8')
  const locale = JSON.parse(await readFile(path.join(dir, 'locale/en.json'), 'utf8'))
  const start = source.indexOf('const en = {')
  const end = source.indexOf('\n    };', start)
  assert.ok(start > -1 && end > start, 'the inline dictionary shape changed; update this test')
  const dict = source.slice(start, end)
  const defined = new Set([
    ...[...dict.matchAll(/^\s{6}(?:'([^']+)'|([A-Za-z][\w.-]*))\s*:/gm)].map((m) => m[1] || m[2]),
    ...Object.keys(locale),
  ])
  // Both shapes count: t('key') and the parameterized t('key', vars).
  const used = new Set([...source.matchAll(/[^A-Za-z0-9_$.]t\('([^']+)'(?:\)|,)/g)].map((m) => m[1]))
  return { defined, used }
}

await test('the dictionary parse finds the real keys', async () => {
  const { defined } = await translationState()
  for (const key of ['title', 'cancel', 'close', 'actionStageSweep', 'reason.goal']) {
    assert.ok(defined.has(key), `expected ${key} among defined keys`)
  }
})

await test('every key the UI asks for is defined', async () => {
  const { defined, used } = await translationState()
  assert.ok(used.size > 20, `only ${used.size} calls found; the extraction regex is stale`)
  const missing = [...used].filter((key) => !defined.has(key))
  assert.deepEqual(missing, [], `missing translation keys: ${missing.join(', ')}`)
})

if (failures.length) {
  console.error(failures.map((f) => `FAIL ${f}`).join('\n'))
  console.log(`PASS ${passed}`)
  process.exit(1)
}
console.log(`PASS ${passed}`)
