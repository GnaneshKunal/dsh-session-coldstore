#!/usr/bin/env node
/**
 * Operator escape hatch for the session coldstore.
 *
 * This works with nothing but the coldstore directory and the manifest — it
 * does not import the plugin, Cordis, or DSH. If the plugin is broken, disabled
 * or uninstalled, `restore --all` still puts every frozen session back where
 * DSH expects it.
 *
 *   node bin/coldstore.mjs list
 *   node bin/coldstore.mjs verify
 *   node bin/coldstore.mjs restore <sessionId>...
 *   node bin/coldstore.mjs restore --all
 *
 * Options:
 *   --cold <dir>   cold tier root (default ~/.dsh/coldstore)
 *   --dry-run      report what would happen
 *   --force        restore despite a sha256 mismatch
 *   --help         print this usage
 */
import { readdir, readFile, rename, copyFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH_HOME = path.join(os.homedir(), '.dsh')
const args = process.argv.slice(2)
const coldFlag = args.indexOf('--cold')
const coldValue = coldFlag >= 0 ? args[coldFlag + 1] : undefined
const coldRoot = coldValue || path.join(DSH_HOME, 'coldstore')
// A flag's value is not a positional argument, and --cold takes one. Reading
// positionals this way keeps `--cold /x list` from treating /x as the command.
const positional = args.filter((a) => !a.startsWith('--') && a !== coldValue)
const command = positional[0] || 'list'
const ids = positional.slice(1)
const liveRoot = path.join(DSH_HOME, 'sessions')
const projcacheRoot = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')

if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: coldstore.mjs <list|verify|restore> [ids...] [--cold <dir>] [--dry-run] [--force]')
  process.exit(0)
}

const manifestPath = path.join(coldRoot, 'manifest.json')

async function load() {
  try {
    const parsed = JSON.parse(await readFile(path.join(coldRoot, 'manifest.json'), 'utf8'))
    return parsed.entries && typeof parsed.entries === 'object' ? parsed : { version: 1, entries: {} }
  } catch {
    return { version: 1, entries: {} }
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Newest transcript in a cold session directory.
 *
 * A session accumulates one transcript per format generation
 * (`session.jsonl.zstd` < `session.v2` < `session.v3` < `session.v4`). The
 * manifest's digest was taken from the newest one at freeze time, so verifying
 * an arbitrary older file reports a false corruption.
 */
function transcriptVersion(name) {
  const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name)
  if (!match) return name.endsWith('.zstd') ? -1 : -2
  return match[1] ? Number(match[1]) : 0
}

async function transcriptOf(dir) {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.zstd'))
    names.sort((a, b) => transcriptVersion(b) - transcriptVersion(a))
    return names[0]
  } catch {
    return undefined
  }
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

const manifest = await load()
const entries = Object.values(manifest.entries)

if (command === 'list') {
  if (!entries.length) {
    console.log('coldstore: empty')
    process.exit(0)
  }
  const total = entries.reduce((n, e) => n + (e.bytes || 0), 0)
  entries.sort((a, b) => (b.lastPromptAt || 0) - (a.lastPromptAt || 0))
  for (const entry of entries) {
    const when = entry.lastPromptAt ? new Date(entry.lastPromptAt).toISOString().slice(0, 10) : '----------'
    console.log(`${entry.id}  ${when}  ${human(entry.bytes || 0).padStart(9)}  ${entry.title || '(untitled)'}`)
  }
  console.log(`\n${entries.length} cold sessions, ${human(total)}`)
  process.exit(0)
}

if (command === 'verify') {
  let bad = 0
  for (const entry of entries) {
    const dir = path.join(coldRoot, 'sessions', entry.id)
    if (!existsSync(dir)) {
      console.log(`MISSING  ${entry.id}`)
      bad += 1
      continue
    }
    const name = await transcriptOf(dir)
    if (!name) {
      console.log(`NO-LOG   ${entry.id}`)
      bad += 1
      continue
    }
    if (entry.sha256) {
      const digest = await sha256File(path.join(dir, name))
      if (digest !== entry.sha256) {
        console.log(`CORRUPT  ${entry.id}`)
        bad += 1
      }
    }
  }
  console.log(bad ? `\n${bad} problem(s)` : `\nall ${entries.length} cold sessions verify`)
  process.exit(bad ? 1 : 0)
}

if (command === 'restore') {
  const target = args.includes('--all') ? entries.map((e) => e.id) : ids
  if (!target.length) {
    console.error('usage: coldstore.mjs restore <sessionId>... | --all')
    process.exit(1)
  }
  let ok = 0
  let failed = 0
  for (const id of target) {
    const entry = manifest.entries[id]
    if (!entry) {
      console.error(`not cold: ${id}`)
      failed += 1
      continue
    }
    const from = path.join(coldRoot, 'sessions', id)
    const bare = id.startsWith('session-') ? id.slice('session-'.length) : id
    // Migration-era directories may keep the `session-` prefix on disk; the
    // manifest records the real name, so never guess it from the id.
    const to = path.join(liveRoot, entry.projectDir, entry.dirName || bare)
    if (dryRun) {
      console.log(`would restore ${id} -> ${to}`)
      ok += 1
      continue
    }
    try {
      // Verify before moving: a corrupted transcript must not be handed back to
      // DSH as if it were sound. --force is the deliberate override.
      if (entry.sha256 && !force) {
        const name = await transcriptOf(from)
        const digest = name ? await sha256File(path.join(from, name)) : null
        if (digest !== entry.sha256) {
          throw new Error(`sha256 mismatch — refusing to restore (use --force to override)`)
        }
      }
      // Never clobber a populated live directory: the cold copy is the only
      // verified one, and the live copy may be newer.
      if (existsSync(to) && (await readdir(to).catch(() => ['?'])).length) {
        throw new Error(`live directory is not empty: ${to}`)
      }
      await mkdir(path.dirname(to), { recursive: true })
      await rename(from, to)
      const docFrom = path.join(coldRoot, 'projcache', `${id}.json`)
      if (existsSync(docFrom)) {
        await mkdir(projcacheRoot, { recursive: true })
        await rename(docFrom, path.join(projcacheRoot, `${id}.json`))
      }
      delete manifest.entries[id]
      await writeFileAtomic(manifestPath, manifest)
      console.log(`restored ${id}`)
      ok += 1
    } catch (error) {
      console.error(`failed ${id}: ${error.message}`)
      failed += 1
    }
  }
  console.log(dryRun ? `\nwould restore ${ok}, failed ${failed} (dry run — nothing moved)` : `\nrestored ${ok}, failed ${failed}`)
  process.exit(failed ? 1 : 0)
}

async function writeFileAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await copyFile(file, tmp).catch(() => {})
  const { writeFile } = await import('node:fs/promises')
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

console.error(`unknown command: ${command}`)
console.error('commands: list | verify | restore <sessionId>... | restore --all')
process.exit(1)
