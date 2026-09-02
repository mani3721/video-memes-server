/**
 * Public sitemap endpoints.
 *
 * GET /sitemap.xml            — sitemap index
 * GET /sitemap-pages.xml      — static pages
 * GET /sitemap-<group>.xml    — content, auto-paginated as -1, -2, … past 45k URLs
 * GET /indexnow.txt           — IndexNow key file (host-ownership proof)
 *
 * Mounted at the server root, not under /api, because crawlers fetch these from
 * the site origin: client/vercel.json rewrites /sitemap*.xml here so the files
 * appear on the canonical domain rather than on the API host.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { CACHE_TTL_MS } from '../lib/sitemap/config.js'
import { getOrBuild } from '../lib/sitemap/cache.js'
import { resolveFile } from '../lib/sitemap/generator.js'
import { indexNowKey } from '../lib/sitemap/indexnow.js'

const router = Router()

/**
 * Generous by crawler standards but still a ceiling on abuse. Responses come
 * from the in-process cache, so a legitimate crawl is cheap; this only exists
 * to stop a single IP from forcing repeated rebuilds.
 */
const sitemapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many sitemap requests.',
})

const MAX_AGE_SECONDS = Math.floor(CACHE_TTL_MS / 1000)

/** Serve a cached entry, honouring conditional requests and gzip. */
function sendXml(req, res, entry) {
  res.set({
    'Content-Type': 'application/xml; charset=utf-8',
    // s-maxage keeps Vercel's edge in step with the origin TTL so a publish is
    // not masked by a CDN copy that outlives the invalidation.
    'Cache-Control': `public, max-age=${MAX_AGE_SECONDS}, s-maxage=${MAX_AGE_SECONDS}, stale-while-revalidate=86400`,
    ETag: entry.etag,
    Vary: 'Accept-Encoding',
    // Deliberately no `X-Robots-Tag: noindex` here. It looks tidy — a sitemap
    // has no business ranking — but Search Console has a documented failure
    // mode where a noindex header on the sitemap itself makes it report
    // "Sitemap could not be read". Sitemap files effectively never rank on
    // their own, so the header is all downside.
  })

  // Crawlers do send If-None-Match; a 304 saves them the transfer entirely.
  if (req.headers['if-none-match'] === entry.etag) return res.status(304).end()

  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
  if (acceptsGzip && entry.gzipped) {
    res.set('Content-Encoding', 'gzip')
    return res.send(entry.gzipped)
  }
  return res.send(entry.xml)
}

// ── /indexnow.txt ────────────────────────────────────────────────────────────

/**
 * IndexNow verifies host ownership by fetching the key from this path, so it
 * must be served from the site origin (hence the matching Vercel rewrite).
 * The key is public by design — it proves control of the host, it is not a
 * secret.
 */
router.get('/indexnow.txt', sitemapLimiter, (_req, res) => {
  const key = indexNowKey()
  if (!key) return res.status(404).type('text/plain').send('IndexNow is not configured.\n')
  res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(key)
})

// ── /sitemap*.xml ────────────────────────────────────────────────────────────

/**
 * A native RegExp route rather than a path pattern: this is the one place the
 * accepted filenames are defined, and an explicit regex says exactly which
 * ones reach the generator.
 */
router.get(/^\/(sitemap(?:-[a-z]+(?:-\d+)?)?\.xml)$/, sitemapLimiter, async (req, res) => {
  const name = req.params[0]
  const file = resolveFile(name)

  if (!file) return res.status(404).type('text/plain').send('Not found\n')

  try {
    const entry = await getOrBuild(name, file.build)

    // null means the group exists but the requested page is out of range.
    // A 404 is right here: an empty urlset would read as "every URL was
    // removed" and could deindex the group.
    if (!entry) return res.status(404).type('text/plain').send('Not found\n')

    return sendXml(req, res, entry)
  } catch (err) {
    // Surface as 503 rather than 500 so Search Console records a retryable
    // fetch error instead of treating the sitemap as permanently broken.
    console.error(`[sitemap] ${name} failed:`, err.message)
    return res
      .status(503)
      .type('text/plain')
      .set('Retry-After', '600')
      .send('Sitemap temporarily unavailable\n')
  }
})

export default router
