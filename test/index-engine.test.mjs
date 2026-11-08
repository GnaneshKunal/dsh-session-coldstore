#!/usr/bin/env node
/**
 * Plain-node test runner for lib/index-engine.js (no test framework).
 *
 *   node test/index-engine.test.mjs
 *
 * Prints `PASS <n>` and exits 0 when everything holds; otherwise prints each
 * failure with its stack and exits 1.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import ColdIndex from '../lib/index-engine.js'

const T0 = 1_700_000_000_000
const LONG_TOKEN = 'z'.repeat(1500)

const entries = [
  {
    id: 'session-aaa',
    projectDir: 'proj-alpha',
    frozenAt: T0,
    lastPromptAt: T0 + 100_000,
    title: 'Kubernetes rollback',
    cwd: '/srv/alpha',
    bytes: 1234,
  },
  {
    id: 'session-bbb',
    projectDir: 'proj-beta',
    frozenAt: T0,
    lastPromptAt: T0 + 200_000,
    title: 'Postgres vacuum',
    cwd: '/srv/beta',
    bytes: 5678,
  },
  {
    id: 'session-ccc',
    projectDir: 'proj-gamma',
    frozenAt: T0,
    lastPromptAt: T0 + 300_000,
    title: 'Vite cache',
    cwd: '/srv/gamma',
    bytes: 9,
  },
]

const texts = {
  'session-aaa': 'kubernetes deployment rollback runbook for the api service',
  'session-bbb': `database migration postgres vacuum ${LONG_TOKEN} finished cleanly`,
  'session-ccc': 'frontend bundler vite cache warming and invalidation',
}

let passed = 0
const failures = []

/** Run one named check; collect failures instead of aborting the run. */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`not ok - ${name}`)
  }
}

const idsOf = (result) => result.items.map((item) => item.id)

async function closeQuietly(index) {
  if (!index) return
  try {
    await index.close()
  } catch {
    // Cleanup must not mask a real failure.
  }
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'coldstore-index-'))
  const indexPath = path.join(dir, 'index.sqlite')
  let index
  let reopened

  try {
    index = new ColdIndex({ indexPath })
    await index.open()

    for (const entry of entries) {
      const starred = entry.id === 'session-bbb' ? { ...entry, starred: true } : entry
      await index.add(starred, texts[entry.id])
    }

    // ── basics ────────────────────────────────────────────────────────────
    await check('add() stores all three rows', async () => {
      assert.equal(await index.count(), 3)
    })

    await check('open() is idempotent', async () => {
      await index.open()
      assert.equal(await index.count(), 3)
    })

    await check('empty q lists cold rows newest-first', async () => {
      const result = await index.search({})
      assert.deepEqual(idsOf(result), ['session-ccc', 'session-bbb', 'session-aaa'])
      assert.equal(result.total, 3)
      assert.ok(result.items.every((item) => typeof item.snippet === 'string'))
      assert.ok(result.items.every((item) => item.snippet.length <= 240))
    })

    await check('word search returns the right doc with a snippet', async () => {
      const result = await index.search({ q: 'kubernetes' })
      assert.equal(result.total, 1)
      assert.deepEqual(idsOf(result), ['session-aaa'])
      assert.match(result.items[0].snippet, /kubernetes/i)
      assert.ok(result.items[0].snippet.length <= 240)
    })

    await check('snippet is truncated to <= 240 chars', async () => {
      const result = await index.search({ q: LONG_TOKEN })
      assert.deepEqual(idsOf(result), ['session-bbb'])
      const { snippet } = result.items[0]
      assert.ok(snippet.length <= 240, `snippet was ${snippet.length} chars`)
      assert.ok(snippet.endsWith('\u2026'), 'expected the truncation ellipsis')
    })

    await check('get() returns id + doc, unknown id is undefined', async () => {
      const hit = await index.get('session-aaa')
      assert.deepEqual(hit, { id: 'session-aaa', doc: texts['session-aaa'] })
      assert.equal(await index.get('session-nope'), undefined)
      assert.equal(await index.get(''), undefined)
    })

    // ── filters ───────────────────────────────────────────────────────────
    await check('from/to narrow by lastPromptAt', async () => {
      const result = await index.search({ from: T0 + 150_000, to: T0 + 250_000 })
      assert.deepEqual(idsOf(result), ['session-bbb'])
      assert.equal(result.total, 1)
    })

    await check('from/to bounds are inclusive', async () => {
      const exact = T0 + 200_000
      const result = await index.search({ from: exact, to: exact })
      assert.deepEqual(idsOf(result), ['session-bbb'])
      assert.equal(result.total, 1)
    })

    await check('from alone / to alone filter one side', async () => {
      const fromOnly = await index.search({ from: T0 + 200_000 })
      assert.deepEqual(idsOf(fromOnly), ['session-ccc', 'session-bbb'])
      assert.equal(fromOnly.total, 2)

      const toOnly = await index.search({ to: T0 + 200_000 })
      assert.deepEqual(idsOf(toOnly), ['session-bbb', 'session-aaa'])
      assert.equal(toOnly.total, 2)
    })

    await check('from > to yields nothing', async () => {
      const result = await index.search({ from: T0 + 300_000, to: T0 + 100_000 })
      assert.deepEqual(result.items, [])
      assert.equal(result.total, 0)
    })

    await check('starred filter works when q is empty', async () => {
      const starred = await index.search({ q: '', starred: true })
      assert.deepEqual(idsOf(starred), ['session-bbb'])
      assert.equal(starred.total, 1)

      const unstarred = await index.search({ q: '', starred: false })
      assert.deepEqual(idsOf(unstarred), ['session-ccc', 'session-aaa'])
      assert.equal(unstarred.total, 2)

      const all = await index.search({ q: '', starred: undefined })
      assert.equal(all.total, 3)
    })

    await check('starred filter combines with q and from/to', async () => {
      const hit = await index.search({ q: 'postgres', starred: true, from: T0 + 150_000, to: T0 + 250_000 })
      assert.deepEqual(idsOf(hit), ['session-bbb'])
      assert.equal(hit.total, 1)

      const miss = await index.search({ q: 'postgres', starred: true, from: T0 + 250_000 })
      assert.deepEqual(miss.items, [])
      assert.equal(miss.total, 0)
    })

    await check('total is the unpaged count while items are paged', async () => {
      const result = await index.search({ q: '', limit: 2, offset: 1 })
      assert.deepEqual(idsOf(result), ['session-bbb', 'session-aaa'])
      assert.equal(result.total, 3)
    })

    await check('limit/offset defaults and clamps', async () => {
      const noOptions = await index.search()
      assert.equal(noOptions.items.length, 3)

      for (const limit of [0, -5, undefined, 999]) {
        const result = await index.search({ limit })
        assert.ok(result.items.length <= 100)
        assert.equal(result.total, 3)
        assert.equal(result.items.length, 3)
      }

      const beyond = await index.search({ offset: 50 })
      assert.deepEqual(beyond.items, [])
      assert.equal(beyond.total, 3)
    })

    // ── hostile input ─────────────────────────────────────────────────────
    await check('hostile queries never throw', async () => {
      const hostile = [
        'foo"bar AND (baz',
        'AND',
        'OR',
        'NOT',
        'NEAR',
        '"',
        '""',
        '(',
        ')',
        '*',
        'title:foo',
        'col:val',
        '--',
        '^',
        '~',
        '{}',
        '[]',
        "'",
        '%',
        '\\',
        '\u0000',
        '❰❱',
        'a'.repeat(5000),
        'AND OR NOT NEAR',
      ]
      for (const q of hostile) {
        const result = await index.search({ q })
        assert.ok(Array.isArray(result.items), `items not an array for ${JSON.stringify(q)}`)
        assert.equal(typeof result.total, 'number')
      }
    })

    await check('operator-only query degrades to list-all instead of 0 rows', async () => {
      const result = await index.search({ q: 'AND' })
      assert.equal(result.total, 3)
      assert.equal(result.items.length, 3)
    })

    await check('quoted / punctuation-laced terms still match', async () => {
      const result = await index.search({ q: 'kubernetes"' })
      assert.deepEqual(idsOf(result), ['session-aaa'])
      assert.equal(result.total, 1)
    })

    // ── mutations ─────────────────────────────────────────────────────────
    await check('add() replaces an existing row (old text leaves the index)', async () => {
      await index.add(entries[0], 'helm chart release replaced the raw manifests')
      const old = await index.search({ q: 'kubernetes' })
      assert.equal(old.total, 0)
      const fresh = await index.search({ q: 'helm' })
      assert.deepEqual(idsOf(fresh), ['session-aaa'])
      assert.equal(fresh.total, 1)
      assert.equal(await index.count(), 3)
    })

    await check('re-adding without starred keeps the stored star flag', async () => {
      await index.add(entries[1], 'postgres autovacuum tuning notes')
      const starred = await index.search({ q: '', starred: true })
      assert.deepEqual(idsOf(starred), ['session-bbb'])
      const old = await index.search({ q: 'autovacuum' })
      assert.deepEqual(idsOf(old), ['session-bbb'])
      const gone = await index.search({ q: 'migration' })
      assert.equal(gone.total, 0)
    })

    await check('setStarred() toggles the column and reports missing rows', async () => {
      assert.equal(await index.setStarred('session-ccc', true), true)
      const on = await index.search({ q: '', starred: true })
      assert.deepEqual(idsOf(on), ['session-ccc', 'session-bbb'])
      assert.equal(on.total, 2)

      assert.equal(await index.setStarred('session-ccc', false), true)
      const off = await index.search({ q: '', starred: true })
      assert.deepEqual(idsOf(off), ['session-bbb'])
      assert.equal(await index.setStarred('session-missing', true), false)
    })

    await check('remove() drops the row from both tables', async () => {
      assert.equal(await index.remove('session-bbb'), true)
      assert.equal(await index.get('session-bbb'), undefined)
      const text = await index.search({ q: 'autovacuum' })
      assert.equal(text.total, 0)
      const list = await index.search({ q: '' })
      assert.deepEqual(idsOf(list), ['session-ccc', 'session-aaa'])
      assert.equal(list.total, 2)
      assert.equal(await index.count(), 2)
      assert.equal(await index.remove('session-bbb'), false)
    })

    // ── persistence ───────────────────────────────────────────────────────
    await check('rows and FTS content survive close + reopen', async () => {
      await index.close()
      reopened = new ColdIndex({ indexPath })
      await reopened.open()
      const list = await reopened.search({ q: '' })
      assert.equal(list.total, 2)
      const helm = await reopened.search({ q: 'helm' })
      assert.deepEqual(idsOf(helm), ['session-aaa'])
      const ccc = await reopened.get('session-ccc')
      assert.equal(ccc.doc, texts['session-ccc'])
    })

    await check('open() twice on a reopened instance is a no-op', async () => {
      await reopened.open()
      assert.equal(await reopened.count(), 2)
    })
  } catch (error) {
    failures.push({ name: 'fatal', error })
  } finally {
    await closeQuietly(index)
    await closeQuietly(reopened)
    await rm(dir, { recursive: true, force: true })
  }

  // ── standalone instances ────────────────────────────────────────────────
  await check('constructor rejects a missing indexPath', async () => {
    assert.throws(() => new ColdIndex({}), /indexPath/)
    assert.throws(() => new ColdIndex(), /indexPath/)
  })

  await check('open() heals content rows the FTS index never saw', async () => {
    const healDir = await mkdtemp(path.join(tmpdir(), 'coldstore-heal-'))
    const healPath = path.join(healDir, 'index.sqlite')
    try {
      const first = new ColdIndex({ indexPath: healPath })
      await first.open()
      await first.add({ id: 'session-1', lastPromptAt: 2, title: 'alpha' }, 'alpha document')
      await first.close()

      // Simulate a process that wrote the content table but died before the FTS
      // row: index-side count and content-side count disagree.
      const raw = new DatabaseSync(healPath)
      raw
        .prepare(
          `INSERT INTO cold (id, project_dir, title, cwd, bytes, frozen_at, last_prompt_at, starred, doc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('session-2', 'proj', 'orphan', '', 0, 0, 3, 0, 'orphan beta text')
      raw.close()

      const healed = new ColdIndex({ indexPath: healPath })
      await healed.open()
      try {
        assert.equal(await healed.count(), 2)
        const orphan = await healed.search({ q: 'orphan' })
        assert.deepEqual(idsOf(orphan), ['session-2'])
        assert.equal(orphan.total, 1)
      } finally {
        await healed.close()
      }
    } finally {
      await rm(healDir, { recursive: true, force: true })
    }
  })

  await check('works with an in-memory database', async () => {
    const mem = new ColdIndex({ indexPath: ':memory:' })
    await mem.open()
    await mem.add(entries[2], 'in memory only document about widgets')
    const result = await mem.search({ q: 'widgets' })
    assert.deepEqual(idsOf(result), ['session-ccc'])
    assert.equal(result.total, 1)
    await mem.close()
    await mem.close()
  })

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS ${passed}`)
    return 0
  }
  const total = passed + failures.length
  console.log(`FAIL ${failures.length} of ${total}`)
  for (const failure of failures) {
    console.log(`\n--- ${failure.name} ---`)
    console.log(failure.error?.stack ?? String(failure.error))
  }
  return 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error('fatal:', error)
    process.exitCode = 1
  })
