/**
 * In-process sitemap cache.
 *
 * Three jobs:
 *  1. TTL — a rendered file is reused for CACHE_TTL_MS instead of re-querying
 *     Supabase on every crawler hit. Googlebot alone will pull the index and
 *     every sub-sitemap repeatedly.
 *  2. Single-flight — concurrent misses for the same file share one build.
 *     Without this, a crawler opening 6 parallel connections after a cache
 *     expiry fires 6 identical multi-query builds at the database.
 *  3. Invalidation — publish/update/delete drops the affected entries so the
 *     next request rebuilds, which is what makes the sitemap track content in
 *     near real time rather than on a timer alone.
 *
 * Scope note: this cache is per process. Running more than one server instance
 * means each keeps its own copy, so a publish only invalidates the instance
 * that handled it; the others correct themselves within one TTL. That bounded
 * staleness is the trade-off for not adding a shared cache dependency.
 */

import { createHash } from 'node:crypto'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { CACHE_TTL_MS } from './config.js'

const gzipAsync = promisify(gzip)

/** @type {Map<string, {xml: string, gzipped: Buffer|null, etag: string, builtAt: number, expiresAt: number}>} */
const entries = new Map()

/** @type {Map<string, Promise<object>>} */
const inFlight = new Map()

let lastInvalidatedAt = 0
let invalidations = 0
let builds = 0
let hits = 0
let misses = 0

function etagFor(xml) {
  return `"${createHash('sha1').update(xml).digest('base64url')}"`
}

async function build(name, builder) {
  const xml = await builder()
  if (xml === null || xml === undefined) return null

  // Compressed once per build rather than per request. A full 45,000-URL file
  // with video tags runs to tens of MB, and every crawler sends
  // Accept-Encoding: gzip, so this is the copy that actually gets served.
  // A gzip failure is not worth failing the whole file over.
  let gzipped = null
  try {
    gzipped = await gzipAsync(xml)
  } catch (err) {
    console.warn(`[sitemap] gzip of ${name} failed, serving uncompressed:`, err.message)
  }

  const builtAt = Date.now()
  const entry = {
    xml,
    gzipped,
    etag: etagFor(xml),
    builtAt,
    expiresAt: builtAt + CACHE_TTL_MS,
  }
  entries.set(name, entry)
  builds += 1
  return entry
}

/**
 * Fetch `name`, building it via `builder` on a miss.
 *
 * On a build failure with a stale copy in hand, the stale copy is served: a
 * momentarily out-of-date sitemap is far better for indexing than a 500, which
 * Search Console records as a fetch error against the whole sitemap.
 *
 * @returns {Promise<{xml: string, etag: string, builtAt: number, stale: boolean} | null>}
 */
export async function getOrBuild(name, builder) {
  const cached = entries.get(name)
  if (cached && cached.expiresAt > Date.now()) {
    hits += 1
    return { ...cached, stale: false }
  }

  misses += 1

  const pending = inFlight.get(name)
  if (pending) return pending

  const task = (async () => {
    try {
      const entry = await build(name, builder)
      return entry ? { ...entry, stale: false } : null
    } catch (err) {
      if (cached) {
        console.error(`[sitemap] rebuild of ${name} failed, serving stale copy:`, err.message)
        return { ...cached, stale: true }
      }
      throw err
    } finally {
      inFlight.delete(name)
    }
  })()

  inFlight.set(name, task)
  return task
}

/**
 * Drop cached files.
 *
 * Content changes shift URL membership, per-page counts and the index's file
 * list all at once, so there is no useful partial invalidation — a new upload
 * can add a page to sitemap-memes and change the index. Clearing everything is
 * both simpler and correct.
 */
export function invalidate(reason = 'unspecified') {
  const cleared = entries.size
  entries.clear()
  lastInvalidatedAt = Date.now()
  invalidations += 1
  if (cleared > 0) console.log(`[sitemap] cache invalidated (${reason}) — ${cleared} file(s) dropped`)
  return cleared
}

/** Snapshot for the admin status endpoint. */
export function stats() {
  return {
    ttlMs: CACHE_TTL_MS,
    cachedFiles: [...entries.entries()].map(([name, e]) => ({
      name,
      bytes: Buffer.byteLength(e.xml),
      gzipBytes: e.gzipped?.length ?? null,
      builtAt: new Date(e.builtAt).toISOString(),
      expiresAt: new Date(e.expiresAt).toISOString(),
      expired: e.expiresAt <= Date.now(),
    })),
    inFlight: [...inFlight.keys()],
    counters: { builds, hits, misses, invalidations },
    lastInvalidatedAt: lastInvalidatedAt ? new Date(lastInvalidatedAt).toISOString() : null,
  }
}
