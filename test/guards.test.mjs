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
import { tmpdir } from 'node:os'
import path from 'node:path'
import { freezeRefusal } from '../lib/index.js'
import { movePath } from '../lib/manifest.js'

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
  const used = new Set([...source.matchAll(/[^A-Za-z0-9_$.]t\('([^']+)'\)/g)].map((m) => m[1]))
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
