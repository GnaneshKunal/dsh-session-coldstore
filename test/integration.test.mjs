/**
 * Integration test: the sweep engine and the FTS5 index together.
 *
 * Uses a temp directory only; never touches a real session.
 * `node test/integration.test.mjs` -> prints `PASS n` and exits 0.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Coldstore } from '../lib/sweep.js'
import ColdIndex from '../lib/index-engine.js'

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

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'coldstore-int-'))
  const liveRoot = path.join(root, 'sessions')
  const projcacheRoot = path.join(root, 'projcache')
  const coldRoot = path.join(root, 'cold')
  const sessions = [
    { id: 'session-alpha-1', project: '--proj-a--', title: 'Quarterly numbers review', text: 'please summarise the quarterly numbers' },
    { id: 'session-beta-2', project: '--proj-b--', title: 'Kubernetes migration notes', text: 'the cluster migration plan for kubernetes' },
  ]
  await mkdir(projcacheRoot, { recursive: true })
  for (const s of sessions) {
    const bare = s.id.replace(/^session-/, '')
    const dir = path.join(liveRoot, s.project, bare)
    await mkdir(dir, { recursive: true })
    const journal = [
      JSON.stringify({ type: 'user/message', content: s.text }),
      JSON.stringify({ type: 'assistant/message', content: `acknowledged: ${s.text}` }),
    ].join('\n')
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(journal)))
    await writeFile(path.join(projcacheRoot, `${s.id}.json`), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: Date.now() - 40 * DAY, cwd: `/tmp/${s.project}` },
        rows: {
          title: { val: s.title },
          workingDirectory: { val: `/tmp/${s.project}` },
          sessionListMetadata: { val: { blank: false, lastPromptAt: Date.now() - 20 * DAY } },
        },
      },
    }))
  }
  const index = new ColdIndex({ indexPath: path.join(coldRoot, 'index.sqlite') })
  await index.open()
  const store = await new Coldstore({ coldRoot, liveRoot, projcacheRoot, index }).load()
  return { root, store, index, coldRoot }
}

await test('freezing two sessions indexes them so search finds their transcripts', async () => {
  const f = await fixture()
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.candidates.length, 2)
  for (const live of await f.store.liveSessions()) {
    await f.store.freezeOne(live, await f.store.metadata(live.id))
  }
  const hits = await f.index.search({ q: 'kubernetes', limit: 10 })
  assert.equal(hits.total, 1)
  assert.equal(hits.items[0].id, 'session-beta-2')
  assert.ok(hits.items[0].snippet.length > 0, 'a matching row should carry a snippet')
})

await test('search matches a session title even though the title is not in the transcript', async () => {
  const f = await fixture()
  for (const live of await f.store.liveSessions()) {
    await f.store.freezeOne(live, await f.store.metadata(live.id))
  }
  const hits = await f.index.search({ q: 'quarterly', limit: 10 })
  assert.equal(hits.total, 1, 'title/labels must be folded into the indexed document')
})

await test('starring a cold session is reflected in the index filter', async () => {
  const f = await fixture()
  for (const live of await f.store.liveSessions()) {
    await f.store.freezeOne(live, await f.store.metadata(live.id))
  }
  const before = await f.index.search({ q: '', starred: true, limit: 10 })
  assert.equal(before.total, 0, 'nothing is starred yet')

  await f.store.setStarred('session-alpha-1', true)

  const starred = await f.index.search({ q: '', starred: true, limit: 10 })
  assert.equal(starred.total, 1)
  assert.equal(starred.items[0].id, 'session-alpha-1')

  const unstarred = await f.index.search({ q: '', starred: false, limit: 10 })
  assert.equal(unstarred.total, 1)
  assert.equal(unstarred.items[0].id, 'session-beta-2')
})

await test('restoring drops the row from the index', async () => {
  const f = await fixture()
  for (const live of await f.store.liveSessions()) {
    await f.store.freezeOne(live, await f.store.metadata(live.id))
  }
  await f.store.restoreOne('session-alpha-1')
  const hits = await f.index.search({ q: '', limit: 10 })
  assert.equal(hits.total, 1)
  assert.equal(hits.items[0].id, 'session-beta-2')
})

await test('trashing drops the row from the index', async () => {
  const f = await fixture()
  for (const live of await f.store.liveSessions()) {
    await f.store.freezeOne(live, await f.store.metadata(live.id))
  }
  await f.store.trashOne('session-beta-2')
  const hits = await f.index.search({ q: '', limit: 10 })
  assert.equal(hits.total, 1)
  assert.equal(hits.items[0].id, 'session-alpha-1')
})

await test('a frozen session is invisible to a second sweep', async () => {
  const f = await fixture()
  for (const live of await f.store.liveSessions()) {
    await f.store.freezeOne(live, await f.store.metadata(live.id))
  }
  const plan = await f.store.plan({ retainDays: 7 })
  assert.equal(plan.candidates.length, 0, 'the live root is empty after a full freeze')
})

if (failures.length) {
  console.error(`FAIL ${failures.length}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS ${passed}`)
