/**
 * Notification plumbing tests.
 *
 * Asserts the AppleScript is built and escaped correctly without posting
 * anything. `node test/notify.test.mjs` -> `PASS n`, exit 0.
 */
import assert from 'node:assert/strict'
import { buildNotificationScript, appleScriptString, sweepSummary } from '../lib/index.js'

let passed = 0
const failures = []

function test(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

test('builds a display-notification script with title and sound', () => {
  const script = buildNotificationScript('12 sessions frozen (240.5 MB) · 3 kept live')
  assert.match(script, /^display notification "/)
  assert.match(script, /with title "DSH Coldstore"/)
  assert.match(script, /sound name "Glass"/)
  assert.ok(script.includes('12 sessions frozen'))
})

test('omits the sound clause when none is given', () => {
  assert.ok(!buildNotificationScript('x', 'T', '').includes('sound name'))
})

test('escapes quotes and backslashes so the script cannot break out', () => {
  // input:  he said "stop" \ now      ->  escaped: he said \"stop\" \\\\ now
  const input = 'he said "stop" \\ now'
  assert.equal(appleScriptString(input), 'he said \\"stop\\" \\\\ now')
  const script = buildNotificationScript(input)
  // Three string literals (message, title, sound) => exactly six bare delimiters.
  const bare = script.split(/(?<!\\)"/)
  assert.equal(bare.length - 1, 6, `expected 6 bare quotes, got ${bare.length - 1}`)
  assert.ok(script.includes('with title "DSH Coldstore"'))
})

test('flattens newlines, which would end the AppleScript statement', () => {
  const escaped = appleScriptString('line one\nline two\r\nline three')
  assert.ok(!escaped.includes('\n') && !escaped.includes('\r'))
  assert.ok(escaped.includes('line one line two'))
})

test('summary reads naturally for 0, 1 and many', () => {
  assert.equal(sweepSummary({ moved: [], bytes: 0, skipped: [] }), '0 sessions frozen (0.0 MB) · 0 kept live')
  assert.match(sweepSummary({ moved: [{}], bytes: 1048576, skipped: [{}] }), /^1 session frozen \(1\.0 MB\) · 1 kept live$/)
  assert.match(sweepSummary({ moved: [{}, {}], bytes: 2 * 1048576, skipped: [] }), /^2 sessions frozen \(2\.0 MB\)/)
})

test('a hostile session title cannot inject AppleScript', () => {
  const script = buildNotificationScript('" & do shell script "rm -rf ~" & "')
  assert.ok(!script.includes('do shell script "'), 'injected command survived escaping')
})

if (failures.length) {
  console.error(`FAIL ${failures.length}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS ${passed}`)
