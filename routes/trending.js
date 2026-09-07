/**
 * GET /api/trending/today?limit=10&excludeCategory=sounds
 *
 * Today's most-downloaded memes, ranked by download events since midnight UTC.
 *
 * Public on purpose — this is a ranking of public content and it is one of the
 * first things a guest sees, so there is no auth here.
 *
 * Why this lives on the server at all: download_events carries a
 * "Service role only" RLS policy (USING (FALSE)), so the browser's anon key
 * reads it as an empty set — no error, just zero rows. The client used to
 * query it directly and count in JS, which meant the "today" ranking silently
 * fell back to the all-time list every single time while labelling itself
 * "All-time ranking". Aggregating here is the only way to see the data without
 * exposing a per-download audit log (which includes country) to the public.
 */

import { Router } from 'express'
import { supabase } from '../db/supabaseClient.js'

const router = Router()

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/** Minimum distinct memes with activity before "today" is meaningful. */
const MIN_TODAY_MEMES = 3

/**
 * Rankings are identical for every visitor and shift slowly, so a short
 * in-memory cache turns a burst of page loads into one aggregation. Per
 * process, which is fine: a stale-by-a-minute ranking is not a correctness
 * problem, and the cost of a cache miss is one indexed query.
 */
const CACHE_TTL_MS = 60_000
const cache = new Map() // key -> { at: number, payload: object }

/** Midnight UTC today, matching the countdown the client renders. */
function windowStart() {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/**
 * Counting in JS rather than SQL GROUP BY because the Supabase client cannot
 * express aggregation without a database function, and adding one would mean
 * another migration to apply before this works at all. Only meme_id is
 * selected, so the payload stays small — today's ~1.5k events are a few tens
 * of kilobytes. If daily volume reaches the cap below, move this to an RPC.
 */
const EVENT_SCAN_CAP = 100_000

async function countTodayDownloads(since) {
  const { data, error } = await supabase
    .from('download_events')
    .select('meme_id')
    .gte('created_at', since.toISOString())
    .limit(EVENT_SCAN_CAP)

  if (error) throw new Error(`download_events read failed: ${error.message}`)

  const counts = new Map()
  for (const { meme_id } of data ?? []) {
    if (meme_id) counts.set(meme_id, (counts.get(meme_id) ?? 0) + 1)
  }
  return counts
}

async function buildPayload({ limit, excludeCategory }) {
  const since = windowStart()
  const counts = await countTodayDownloads(since)

  // Over-fetch candidates so that filtering out a category (or unpublished
  // rows) still leaves a full list rather than a short one.
  const candidateIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 4)
    .map(([id]) => id)

  if (candidateIds.length >= MIN_TODAY_MEMES) {
    let q = supabase.from('memes').select('*').in('id', candidateIds).eq('is_published', true)
    if (excludeCategory) q = q.neq('category', excludeCategory)

    const { data, error } = await q
    if (error) throw new Error(`memes read failed: ${error.message}`)

    const ranked = (data ?? [])
      .map((m) => ({ ...m, today_downloads: counts.get(m.id) ?? 0 }))
      .sort((a, b) => b.today_downloads - a.today_downloads)
      .slice(0, limit)

    if (ranked.length >= MIN_TODAY_MEMES) {
      return {
        memes: ranked,
        isFallback: false,
        windowStart: since.toISOString(),
        generatedAt: new Date().toISOString(),
      }
    }
  }

  // Too early in the day (or a quiet category) — show the all-time ranking and
  // say so, rather than presenting a two-item list as "today's top 10".
  let fq = supabase
    .from('memes')
    .select('*')
    .eq('is_published', true)
    .order('download_count', { ascending: false })
    .limit(limit)
  if (excludeCategory) fq = fq.neq('category', excludeCategory)

  const { data: fallback, error: fErr } = await fq
  if (fErr) throw new Error(`fallback read failed: ${fErr.message}`)

  return {
    memes: fallback ?? [],
    isFallback: true,
    windowStart: since.toISOString(),
    generatedAt: new Date().toISOString(),
  }
}

// ── GET /api/trending/today ──────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(req.query.limit, 10) || DEFAULT_LIMIT))
  const excludeCategory = typeof req.query.excludeCategory === 'string' && req.query.excludeCategory
    ? req.query.excludeCategory
    : null

  const key = `${limit}:${excludeCategory ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.json({ ...hit.payload, cached: true })
  }

  try {
    const payload = await buildPayload({ limit, excludeCategory })
    cache.set(key, { at: Date.now(), payload })
    res.json({ ...payload, cached: false })
  } catch (err) {
    console.error('[trending/today]', err.message)
    // Serve a stale entry rather than an empty page if one is around.
    if (hit) return res.json({ ...hit.payload, cached: true, stale: true })
    res.status(500).json({ error: 'Could not load trending.' })
  }
})

export default router
