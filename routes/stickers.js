import { Router } from 'express'

/**
 * KLIPY Sticker API proxy.
 *
 * The app key never reaches the browser: every KLIPY call originates here and
 * the client only ever talks to /api/stickers/*. KLIPY payloads are passed
 * through verbatim — media URLs, their query parameters, and result order are
 * theirs to control (see the Integration Requirements note in docs/KLIPY.md),
 * so this file normalises nothing and re-hosts nothing. It only decides
 * *whether* to make an upstream call.
 *
 * Endpoints:
 *   GET  /api/stickers/trending?page&per_page&locale&customer_id
 *   GET  /api/stickers/search?q=&page&per_page&locale&customer_id
 *   POST /api/stickers/share/:slug   (share analytics ping, fire-and-forget)
 *
 * Docs: https://docs.klipy.com/stickers-api/stickers-trending-api
 */

const router = Router()

const KLIPY_BASE = 'https://api.klipy.com/api/v1'
const APP_KEY    = process.env.KLIPY_API_KEY

// Trending shifts slowly and is the same for everyone, so it absorbs almost
// all of the traffic on one upstream call per locale/page. Search terms vary
// per user, so a short window only collapses bursts of the same query
// (autocomplete retries, a term going round a group chat).
const TRENDING_TTL_MS = Number(process.env.KLIPY_TRENDING_TTL_MS ?? 20 * 60 * 1000)
const SEARCH_TTL_MS   = Number(process.env.KLIPY_SEARCH_TTL_MS   ??  5 * 60 * 1000)

// A fresh entry is served from cache; an expired one is still kept around this
// long as a fallback for when KLIPY errors or the hourly budget is spent.
// Better a 40-minute-old trending grid than an empty page.
const STALE_MAX_MS = 6 * 60 * 60 * 1000

// Bounded so a spray of unique search terms cannot grow the heap unchecked.
// Insertion-ordered Map == oldest key first, which is the eviction victim.
const MAX_ENTRIES = 400

// KLIPY test keys allow 100 requests/hour (production access lifts this).
// Budget below the cap so a burst can never trip it — the remainder is
// headroom for the share pings, which are not worth failing a page over.
const MAX_CALLS_PER_HOUR = Number(process.env.KLIPY_MAX_CALLS_PER_HOUR ?? 80)
const HOUR_MS = 60 * 60 * 1000

const cache    = new Map()
const inflight = new Map()
const callLog  = []   // ms timestamps of upstream calls inside the rolling hour

function budgetRemaining() {
  const cutoff = Date.now() - HOUR_MS
  while (callLog.length && callLog[0] < cutoff) callLog.shift()
  return MAX_CALLS_PER_HOUR - callLog.length
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  // Refresh recency so a hot key survives eviction.
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cacheSet(key, payload) {
  cache.set(key, { payload, ts: Date.now() })
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
}

// ── Parameter validation ─────────────────────────────────────────────────────
// Anything unrecognised is dropped rather than forwarded: the query string is
// user-controlled and lands in an outbound request against our own API key.

function clampInt(raw, { min, max, fallback }) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** ISO 3166-1 alpha-2, per the KLIPY `locale` parameter. */
function cleanLocale(raw) {
  return typeof raw === 'string' && /^[a-zA-Z]{2}$/.test(raw) ? raw.toLowerCase() : null
}

/** Stable anonymous per-browser id; KLIPY uses it to personalise and dedupe. */
function cleanCustomerId(raw) {
  return typeof raw === 'string' && /^[\w-]{1,64}$/.test(raw) ? raw : null
}

function buildUpstreamUrl(path, params) {
  const url = new URL(`${KLIPY_BASE}/${APP_KEY}/${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v))
  }
  return url
}

/**
 * Cache-aware upstream fetch.
 *
 * Three things guard the hourly budget, in order: a fresh cache entry, an
 * in-flight promise for the same key (so N simultaneous cold requests make one
 * upstream call, not N), and the rolling-hour counter. When the counter is
 * spent the request degrades to stale rather than failing, and only 429s if
 * there is nothing at all to serve.
 */
async function fetchCached(key, url, ttlMs) {
  const hit = cacheGet(key)
  const age = hit ? Date.now() - hit.ts : Infinity

  if (hit && age < ttlMs) return { payload: hit.payload, status: 'HIT', age }

  const pending = inflight.get(key)
  if (pending) return { ...(await pending), status: 'COALESCED' }

  const usable = hit && age < STALE_MAX_MS ? hit : null

  if (budgetRemaining() <= 0) {
    if (usable) return { payload: usable.payload, status: 'STALE-BUDGET', age }
    const err = new Error('Sticker service is at its hourly upstream limit — try again shortly.')
    err.status = 429
    err.code = 'BUDGET_EXHAUSTED'
    throw err
  }

  const task = (async () => {
    callLog.push(Date.now())
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })

    if (!upstream.ok) {
      const err = new Error(
        upstream.status === 429
          ? 'KLIPY rate limit reached — try again shortly.'
          : `KLIPY returned ${upstream.status}`,
      )
      err.status = upstream.status === 429 ? 429 : 502
      err.code = upstream.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_ERROR'
      throw err
    }

    const payload = await upstream.json()
    // KLIPY signals application-level failure with result:false and HTTP 200.
    if (payload?.result === false) {
      const err = new Error(payload?.message ?? 'KLIPY rejected the request')
      err.status = 502
      err.code = 'UPSTREAM_REJECTED'
      throw err
    }

    cacheSet(key, payload)
    return { payload, age: 0 }
  })()

  inflight.set(key, task)
  try {
    const result = await task
    return { ...result, status: 'MISS' }
  } catch (err) {
    if (usable) return { payload: usable.payload, status: 'STALE-ERROR', age }
    throw err
  } finally {
    inflight.delete(key)
  }
}

function send(res, { payload, status, age }) {
  res.set('X-Cache', status)
  res.set('X-Cache-Age', String(Number.isFinite(age) ? Math.floor(age / 1000) : 0))
  res.set('X-Klipy-Budget-Remaining', String(Math.max(0, budgetRemaining())))
  res.json(payload)
}

// Every route needs the key; fail loudly and identically rather than sending
// `undefined` into the URL path and getting a confusing 404 from KLIPY.
router.use((_req, res, next) => {
  if (!APP_KEY) {
    return res.status(503).json({
      error: 'Sticker search is not configured on this server.',
      code: 'KLIPY_NOT_CONFIGURED',
    })
  }
  next()
})

// ── GET /api/stickers/trending ───────────────────────────────────────────────
router.get('/trending', async (req, res, next) => {
  try {
    const page     = clampInt(req.query.page,     { min: 1, max: 200, fallback: 1 })
    const perPage  = clampInt(req.query.per_page, { min: 1, max: 50,  fallback: 24 })
    const locale   = cleanLocale(req.query.locale)
    const customer = cleanCustomerId(req.query.customer_id)

    // customer_id is deliberately out of the cache key: it only personalises
    // KLIPY's own analytics, and keying on it would give every visitor a
    // private cache and multiply upstream calls by the audience size.
    const key = `trending:${locale ?? '-'}:${page}:${perPage}`
    const url = buildUpstreamUrl('stickers/trending', {
      page,
      per_page: perPage,
      locale,
      customer_id: customer,
      content_filter: process.env.KLIPY_CONTENT_FILTER ?? 'high',
    })

    send(res, await fetchCached(key, url, TRENDING_TTL_MS))
  } catch (err) {
    next(err)
  }
})

// ── GET /api/stickers/search?q= ──────────────────────────────────────────────
router.get('/search', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
    if (!q) {
      return res.status(400).json({ error: 'Missing search term', code: 'MISSING_QUERY' })
    }

    const page     = clampInt(req.query.page,     { min: 1, max: 200, fallback: 1 })
    const perPage  = clampInt(req.query.per_page, { min: 1, max: 50,  fallback: 24 })
    const locale   = cleanLocale(req.query.locale)
    const customer = cleanCustomerId(req.query.customer_id)

    // Case- and whitespace-insensitive key so "Vadivelu" and "vadivelu " share
    // one entry; the original `q` is what actually goes upstream.
    const normalised = q.toLowerCase().replace(/\s+/g, ' ')
    const key = `search:${normalised}:${locale ?? '-'}:${page}:${perPage}`
    const url = buildUpstreamUrl('stickers/search', {
      q,
      page,
      per_page: perPage,
      locale,
      customer_id: customer,
      content_filter: process.env.KLIPY_CONTENT_FILTER ?? 'high',
    })

    send(res, await fetchCached(key, url, SEARCH_TTL_MS))
  } catch (err) {
    next(err)
  }
})

// ── POST /api/stickers/share/:slug ───────────────────────────────────────────
/**
 * Share analytics. KLIPY ranks trending partly on share signal, so dropping
 * this would quietly degrade the results we get back. Never cached, never
 * retried, and it answers 202 regardless of the upstream result — a failed
 * analytics ping must not surface as a failed share to the user.
 */
router.post('/share/:slug', async (req, res) => {
  res.status(202).json({ ok: true })

  if (!/^[\w-]{1,120}$/.test(req.params.slug)) return
  if (budgetRemaining() <= 0) return

  const body = new URLSearchParams()
  const customer = cleanCustomerId(req.body?.customer_id)
  if (customer) body.set('customer_id', customer)
  if (typeof req.body?.q === 'string' && req.body.q.trim()) {
    body.set('q', req.body.q.trim().slice(0, 100))
  }

  try {
    callLog.push(Date.now())
    await fetch(`${KLIPY_BASE}/${APP_KEY}/stickers/share/${req.params.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Analytics only — the user already has their link.
  }
})

export default router
