/**
 * IndexNow — push URL changes to search engines.
 *
 * Why this and not the classic sitemap "ping": both ping endpoints are gone.
 * Google retired https://www.google.com/ping?sitemap= (announced June 2023, now
 * 404) and Bing's https://www.bing.com/ping returns 410 Gone. Calling either
 * would be dead code that quietly logs failures forever.
 *
 * What replaced them:
 *  - Bing and Yandex: IndexNow, implemented here. Submitting a URL invites a
 *    recrawl within minutes, including for URLs that were *deleted* — the
 *    crawler fetches, gets a 404/410, and drops the page.
 *  - Google: no push API. Google discovers the sitemap from robots.txt and
 *    re-fetches the index on its own schedule; a human submits it once in
 *    Search Console. See docs/SITEMAP.md.
 *
 * Setup: set INDEXNOW_KEY to 8-128 hex characters. The key is public by design
 * — it is served at /indexnow.txt to prove control of the host. Without it this
 * module no-ops, so the sitemap works fine unconfigured.
 */

import { SITE_ORIGIN } from './config.js'

const ENDPOINT = 'https://api.indexnow.org/indexnow'

/** IndexNow accepts at most 10,000 URLs per request. */
const MAX_URLS_PER_REQUEST = 10_000

const KEY = process.env.INDEXNOW_KEY ?? ''

/** Keys must be 8-128 hex chars; a malformed one is rejected at submit time. */
const KEY_PATTERN = /^[a-f0-9]{8,128}$/i

export function indexNowKey() {
  return KEY
}

export function indexNowStatus() {
  if (!KEY) return { enabled: false, reason: 'INDEXNOW_KEY not set' }
  if (!KEY_PATTERN.test(KEY)) return { enabled: false, reason: 'INDEXNOW_KEY must be 8-128 hex characters' }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(SITE_ORIGIN)) {
    return { enabled: false, reason: 'SITE_ORIGIN is localhost — nothing to submit' }
  }
  return { enabled: true, keyLocation: `${SITE_ORIGIN}/indexnow.txt` }
}

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Submit absolute URLs for recrawl. Never throws and never blocks a caller's
 * response — a failed notification is a missed optimisation, not a failed
 * upload, so it is logged and dropped.
 *
 * @param {string[]} urls absolute URLs on SITE_ORIGIN
 */
export async function submitToIndexNow(urls) {
  const status = indexNowStatus()
  if (!status.enabled) return { submitted: 0, skipped: status.reason }

  // Guard against a caller passing a foreign origin: IndexNow rejects the whole
  // batch if any URL is off-host.
  const owned = [...new Set(urls.filter((u) => typeof u === 'string' && u.startsWith(`${SITE_ORIGIN}/`)))]
  if (!owned.length) return { submitted: 0, skipped: 'no URLs on SITE_ORIGIN' }

  const host = new URL(SITE_ORIGIN).host
  let submitted = 0

  for (const batch of chunk(owned, MAX_URLS_PER_REQUEST)) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host,
          key: KEY,
          keyLocation: status.keyLocation,
          urlList: batch,
        }),
        signal: AbortSignal.timeout(10_000),
      })

      if (res.ok) {
        submitted += batch.length
      } else {
        // 403 = key not verifiable at keyLocation, 422 = URLs not on host.
        console.warn(`[indexnow] ${res.status} ${res.statusText} for ${batch.length} URL(s)`)
      }
    } catch (err) {
      console.warn('[indexnow] submit failed:', err.message)
    }
  }

  return { submitted }
}
