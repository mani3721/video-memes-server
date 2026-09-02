/**
 * Proactive regeneration.
 *
 * The cache alone is lazy: after an invalidation or a TTL expiry, whichever
 * crawler arrives first pays the full multi-query build cost. On a small
 * instance that can be several seconds, and a slow sitemap fetch is recorded
 * as an error in Search Console.
 *
 * So the files are also rebuilt on a timer, just under the cache TTL, keeping a
 * warm copy ready. Content-change invalidation is still the mechanism that
 * makes updates land quickly — this only removes the latency spike.
 */

import { CACHE_TTL_MS, CONTENT_GROUPS } from './config.js'
import { getOrBuild } from './cache.js'
import { resolveFile } from './generator.js'

/**
 * Files worth keeping warm: the index, the static pages, and page 1 of every
 * content group. Deeper pagination pages are requested rarely and are left to
 * build on demand.
 */
function warmTargets() {
  return ['sitemap.xml', 'sitemap-pages.xml', ...Object.keys(CONTENT_GROUPS).map((g) => `sitemap-${g}.xml`)]
}

async function warmOnce() {
  const started = Date.now()
  let built = 0

  for (const name of warmTargets()) {
    const file = resolveFile(name)
    if (!file) continue
    try {
      // getOrBuild is a no-op when the entry is still fresh, so a warm pass
      // right after a crawler-triggered build costs nothing.
      const entry = await getOrBuild(name, file.build)
      if (entry) built += 1
    } catch (err) {
      console.warn(`[sitemap] warm of ${name} failed:`, err.message)
    }
  }

  return { built, ms: Date.now() - started }
}

/**
 * Start the warmer. Returns a stop function.
 *
 * Set SITEMAP_WARM=false to disable — useful locally, where an idle dev server
 * otherwise queries Supabase on a loop.
 */
export function startSitemapWarmer() {
  if (process.env.SITEMAP_WARM === 'false') {
    console.log('[sitemap] warmer disabled (SITEMAP_WARM=false)')
    return () => {}
  }

  // Just under the TTL, so a rebuild lands before the served copy goes stale.
  const intervalMs = Math.max(60_000, Math.floor(CACHE_TTL_MS * 0.9))

  const run = () => {
    warmOnce()
      .then(({ built, ms }) => {
        if (built) console.log(`[sitemap] warmed ${built} file(s) in ${ms}ms`)
      })
      .catch((err) => console.warn('[sitemap] warm pass failed:', err.message))
  }

  // Delay the first pass so it does not compete with startup, and so a crash
  // loop does not hammer the database.
  const initial = setTimeout(run, 10_000)
  const interval = setInterval(run, intervalMs)

  // unref so neither timer keeps the process alive on shutdown.
  initial.unref?.()
  interval.unref?.()

  console.log(`[sitemap] warmer every ${Math.round(intervalMs / 1000)}s (cache TTL ${Math.round(CACHE_TTL_MS / 1000)}s)`)

  return () => {
    clearTimeout(initial)
    clearInterval(interval)
  }
}
