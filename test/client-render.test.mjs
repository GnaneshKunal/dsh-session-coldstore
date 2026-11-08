/**
 * Render harness for the Coldstore Settings page.
 *
 * `node --check` cannot see an unbound identifier — the module only throws
 * when the component actually runs, and a throwing slot entry blanks the page.
 * This executes the real factory against a stubbed React and renders the
 * component for several `/status` shapes, so a missing binding fails here
 * instead of in the browser.
 *
 * `node test/client-render.test.mjs` -> `PASS n` and exit 0.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Handlers reach the network through `fetch`; give them a benign stub.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

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

/**
 * Minimal React stub. `useState` seeds its FIRST call with `seed`, because the
 * component's first hook is its `/status` snapshot and effects are inert here.
 */
/** 1-based index of the `useState` call that declares `name`. */
function hookIndex(name) {
  const at = source.indexOf(`const [${name}, set`)
  if (at < 0) return -1
  return (source.slice(0, at).match(/useState\(/g) || []).length + 1
}

function stubReact(seeds) {
  const element = (type, props, ...children) => ({ type, props: props || {}, children })
  let calls = 0
  return {
    createElement: element,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => {
      calls += 1
      const seeded = seeds && Object.prototype.hasOwnProperty.call(seeds, calls)
      return [seeded ? seeds[calls] : initial, () => {}]
    },
  }
}

/** Minimal DOM stub for the plugin's stylesheet-injection effect. */
function stubDocument() {
  return {
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  }
}

/** Load the factory and return the registered slot entry. */
function loadEntry(seeds) {
  let entry
  const loader = {
    load: ({ factory }) => {
      entry = factory((name) => {
        if (name === 'react') return stubReact(seeds)
        throw new Error(`unexpected require: ${name}`)
      })
    },
  }
  const fn = new Function('window', 'document', 'module', 'exports', source)
  fn({ __ModuleLoader__: loader }, stubDocument(), { exports: {} }, {})
  assert.ok(entry, 'factory did not register')
  return entry
}

/** Mount the plugin and capture the component registered into settings.section. */
function mount(seeds) {
  const entry = loadEntry(seeds)
  let component
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    locale: {
      register: () => () => {},
      bind: () => (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (_options, Component) => {
        component = Component
        return () => {}
      },
    },
  }
  entry.apply(ctx)
  assert.ok(component, 'no component registered into settings.section')
  return component
}

/** Render with a seeded `/status` snapshot and (optionally) a staged batch. */
function render(status, batch) {
  const seeds = {}
  if (status !== undefined) seeds[hookIndex('status')] = status
  if (batch !== undefined) seeds[hookIndex('batch')] = batch
  const Component = mount(seeds)
  return Component({ t, close: () => {} })
}

const t = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key)

const shapes = {
  'no status yet': null,
  'dry run with a staged batch': {
    retainDays: 7,
    dryRun: true,
    retainDraft: 7,
    live: { count: 1204, bytes: 537477131 },
    cold: { count: 0, bytes: 0 },
    stars: 0,
    index: { rows: 0 },
    lastSweep: 1793540596000,
    batch: { id: 'b1', createdAt: 1793540880170, count: 683, bytes: 333706751 },
    keepPinned: true,
    keepStarred: true,
    keepUnread: true,
    minIdleMs: 3600000,
  },
  'live mode, empty cold tier': {
    retainDays: 3,
    dryRun: false,
    live: { count: 520, bytes: 200000000 },
    cold: { count: 0, bytes: 0 },
    lastSweep: null,
    batch: null,
    keepPinned: true,
    keepStarred: false,
    keepUnread: true,
    minIdleMs: 0,
  },
  'garbage fields': {
    dryRun: 'nope',
    live: null,
    cold: 'x',
    lastSweep: 'not-a-number',
    batch: {},
    retainDays: null,
    minIdleMs: null,
  },
}

for (const [label, status] of Object.entries(shapes)) {
  await test(`renders without throwing: ${label}`, () => {
    const tree = render(status)
    assert.ok(tree, 'component returned nothing')
    const serialized = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
    assert.ok(serialized.length > 100, 'render produced no markup')
  })
}

await test('the dry-run banner uses the server flag, not the draft', () => {
  const dry = render({ dryRun: true })
  assert.ok(JSON.stringify(dry).includes('dryRunOn'), 'dry-run banner missing when the server is in dry run')
  const live = render({ dryRun: false })
  assert.ok(!JSON.stringify(live).includes('cs_banner'), 'banner must not render in live mode')
})

await test('a staged batch renders a Commit control', () => {
  const tree = render(
    {
      dryRun: false,
      batch: { id: 'b2', createdAt: 1793540880170, count: 12, bytes: 1024 },
      live: { count: 10, bytes: 1 },
      cold: { count: 2, bytes: 2 },
    },
    { id: 'b2', createdAt: 1793540880170, candidates: [{ id: 's1' }], exempt: [], totals: { count: 12, bytes: 1024 } },
  )
  const json = JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[fn]' : value))
  assert.ok(json.includes('actionCommit'), 'Commit button missing from the staged bar')
  assert.ok(json.includes('cs_batch'), 'staged batch bar missing')
})

/** Collect every handler prop anywhere in a rendered tree. */
function collectHandlers(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectHandlers(child, out)
    return out
  }
  if (node.props) {
    for (const key of ['onChange', 'onClick', 'onStar', 'onRestore', 'onDelete', 'onPreview']) {
      if (typeof node.props[key] === 'function') out.push([key, node.props[key]])
    }
  }
  if (node.children) collectHandlers(node.children, out)
  return out
}

const interactive = render(
  {
    dryRun: false,
    retainDays: 7,
    keepPinned: true,
    keepStarred: true,
    keepUnread: true,
    notifyOnSweep: true,
    minIdleMs: 3600000,
    live: { count: 10, bytes: 1 },
    cold: { count: 2, bytes: 2 },
    batch: { id: 'b9', createdAt: Date.now(), count: 5, bytes: 500 },
  },
  { id: 'b9', createdAt: Date.now(), candidates: [{ id: 's1' }], exempt: [], totals: { count: 5, bytes: 500 } },
)

await test('every interactive handler runs without throwing', async () => {
  const handlers = collectHandlers(interactive)
  assert.ok(handlers.length >= 5, `expected several handlers, found ${handlers.length}`)
  const broken = []
  for (const [kind, fn] of handlers) {
    try {
      await fn({ target: { value: '7' } })
    } catch (error) {
      broken.push(`${kind}: ${error.message}`)
    }
  }
  assert.deepEqual(broken, [], `handlers threw: ${broken.join('; ')}`)
})

if (failures.length) {
  console.error(`FAIL ${failures.length}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS ${passed}`)
