/**
 * Paths, on-disk state, and durability helpers for the session coldstore.
 *
 * Every write here is atomic (temp file + rename) so a crash mid-sweep can
 * never leave a half-written manifest that would strand frozen sessions.
 *
 * @module @gnanesh/dsh-session-coldstore/manifest
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/**
 * Move a path into place, refusing to destroy a non-empty destination.
 *
 * rename() cannot replace a populated directory, and the earlier version
 * `rm -rf`'d the destination first — which turns a stale copy into silent data
 * loss. An empty destination is safe to replace; a populated one is reported
 * so the caller can surface it instead of deleting a transcript.
 */
export async function movePath(from, to) {
  await mkdir(path.dirname(to), { recursive: true })
  let entries = null
  try {
    entries = await readdir(to)
  } catch (error) {
    if (error?.code === 'ENOENT') entries = null
    // A file at the destination is never an empty directory.
    else if (error?.code === 'ENOTDIR') throw new Error(`refusing to overwrite an existing file: ${to}`)
    else throw error
  }
  if (entries && entries.length) {
    throw new Error(`refusing to overwrite a non-empty path: ${to}`)
  }
  if (entries) await rm(to, { recursive: true, force: true })
  await rename(from, to)
}

/**
 * Report why `to` cannot receive a move, or null when it is free.
 *
 * Freeze and restore touch two paths (the session directory and its projection
 * cache document), so they preflight both before the first move. Refusing late
 * is what strands a session: the transcript is already somewhere the manifest
 * does not describe.
 */
export async function destinationRefusal(to) {
  try {
    const entries = await readdir(to)
    return entries.length ? `destination is not empty: ${to}` : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    // A file at the destination is not a free directory.
    if (error?.code === 'ENOTDIR') return `destination is a file: ${to}`
    throw error
  }
}

/**
 * Move a file over an existing file (never over a directory).
 *
 * The projection cache is a derived document: at freeze the live copy is the
 * authoritative one, at restore the cold copy is. Replacing it is intended,
 * while replacing a transcript directory never is.
 */
export async function moveFileReplace(from, to) {
  await mkdir(path.dirname(to), { recursive: true })
  await rm(to, { force: true })
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
