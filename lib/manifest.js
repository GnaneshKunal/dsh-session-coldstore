/**
 * Paths, on-disk state, and durability helpers for the session coldstore.
 *
 * Every write here is atomic (temp file + rename) so a crash mid-sweep can
 * never leave a half-written manifest that would strand frozen sessions.
 *
 * @module @gnanesh/dsh-session-coldstore/manifest
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DSH_HOME = path.join(os.homedir(), '.dsh')
export const LIVE_ROOT = path.join(DSH_HOME, 'sessions')
export const PROJCACHE_ROOT = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
export const DEFAULT_COLD_ROOT = path.join(DSH_HOME, 'coldstore')

/** Canonical registry id: directory names may omit the `session-` prefix. */
export function normalizeId(name) {
  return name.startsWith('session-') ? name : `session-${name}`
}

/** Bare on-disk directory name for a canonical id. */
export function dirName(sessionId) {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
}

/** Read JSON, returning `fallback` for a missing or unparseable file. */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write JSON atomically: a sibling temp file, then rename. */
export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

/** SHA-256 of a file's bytes, streamed. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Size in bytes, or 0 when the file is gone. */
export async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

/** Move a path, falling back to copy-free rename only (same device expected). */
export async function movePath(from, to) {
  await mkdir(path.dirname(to), { recursive: true })
  await rm(to, { recursive: true, force: true })
  await rename(from, to)
}

/** Coldstore layout for one root. */
export function layout(coldRoot) {
  const root = coldRoot || DEFAULT_COLD_ROOT
  return {
    root,
    manifest: path.join(root, 'manifest.json'),
    stars: path.join(root, 'stars.json'),
    ledger: path.join(root, 'read.json'),
    index: path.join(root, 'index.sqlite'),
    sessions: path.join(root, 'sessions'),
    projcache: path.join(root, 'projcache'),
    trash: path.join(root, 'trash'),
  }
}
