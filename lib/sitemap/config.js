/**
 * Sitemap configuration — single source of truth for the whole subsystem.
 *
 * Everything here is env-overridable so the same code serves staging and
 * production without a rebuild.
 */

/** Coerce an env string to an int inside [min, max], falling back to `dflt`. */
function envInt(raw, dflt, min, max) {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(n, min), max)
}

/**
 * Public origin of the *site*, not the API.
 *
 * Every <loc> must point at the origin a crawler actually fetches pages from,
 * and must byte-match the <link rel="canonical"> the page renders — otherwise
 * Google treats the sitemap URL as a duplicate of the canonical and drops it.
 * Keep this in sync with BASE_URL in client/src/utils/seo.js.
 */
export const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? 'https://www.videsaur.co.in').replace(/\/+$/, '')

/**
 * The sitemaps protocol caps one file at 50,000 URLs / 50 MB uncompressed.
 * 45,000 leaves headroom so a file can never straddle the limit between the
 * COUNT query and the row fetch (content can be inserted in between).
 */
export const MAX_URLS_PER_FILE = envInt(process.env.SITEMAP_MAX_URLS, 45_000, 1, 50_000)

/**
 * PostgREST caps rows returned per request (1,000 by default), so a single
 * sitemap file is assembled from several sequential page queries.
 */
export const DB_PAGE_SIZE = 1000

/** How long a rendered file is served before it is regenerated. */
export const CACHE_TTL_MS = envInt(process.env.SITEMAP_CACHE_TTL_MS, 20 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000)

/** Content newer than this counts as "recently uploaded" for changefreq/priority. */
export const RECENT_WINDOW_DAYS = envInt(process.env.SITEMAP_RECENT_DAYS, 30, 1, 365)

/** download_count at or above this counts as "trending" regardless of age. */
export const TRENDING_DOWNLOADS = envInt(process.env.SITEMAP_TRENDING_DOWNLOADS, 500, 1, 10_000_000)

/**
 * <priority> is only meaningful *relative to other URLs on the same site*.
 * 1.0 is reserved for the homepage so the strongest content still ranks below
 * the entry point.
 */
export const PRIORITY = {
  trending: '0.9',
  recent: '0.8',
  standard: '0.5',
}

/**
 * Content sitemap groups. `categories` maps to memes.category values.
 *
 * `media` selects which sitemap extension namespace gets emitted per URL:
 *   'video' — <video:video>, for files Google can fetch as a raw video stream
 *   'image' — <image:image>, for stills and animated GIFs
 *   'none'  — plain <url>. Used for sounds, where there is no audio sitemap
 *             schema so discovery relies on schema.org AudioObject on the page
 *             (see buildAudioSchema in client/src/utils/seo.js), and for blog
 *             posts, which are prose rather than media.
 */
export const CONTENT_GROUPS = {
  memes: { source: 'memes', categories: ['videos'], media: 'video' },
  gifs: { source: 'memes', categories: ['gifs'], media: 'image' },
  audio: { source: 'memes', categories: ['sounds'], media: 'none' },
  templates: { source: 'memes', categories: ['images'], media: 'image' },
  // Editorial posts from public.blog_posts — a different table and a different
  // URL shape (/blog/:slug), so it reads through its own query functions.
  blog: { source: 'blog', media: 'none' },
}

/** Formats Google will accept as <video:content_loc> (raw, fetchable streams). */
export const VIDEO_FORMATS = new Set(['MP4', 'WebM'])

/**
 * Date to report for pages whose content is hand-written copy (policies, about,
 * help). Bump this when that copy actually changes — reporting "today" on every
 * request would tell crawlers the terms page changes daily, which trains them
 * to ignore lastmod entirely.
 */
export const POLICY_LASTMOD = process.env.SITEMAP_POLICY_LASTMOD ?? '2026-09-01'

/**
 * Static routes worth indexing, mirroring the <Route> table in client/src/App.jsx.
 *
 * `feedOf` marks a listing page whose content genuinely changes with the
 * catalogue: its <lastmod> is derived from the newest asset in those
 * categories. Pages without it are fixed copy and use POLICY_LASTMOD.
 *
 * Deliberately excluded (see docs/SITEMAP.md): /admin, /login, /upload and
 * /favorites — admin surfaces, auth screens and per-user pages. Search result
 * pages (/?q=...) are excluded as thin duplicates of the feed and are already
 * Disallow'd in robots.txt.
 */
export const STATIC_PAGES = [
  { path: '/',                priority: '1.0', changefreq: 'daily',   feedOf: ['videos', 'gifs', 'images', 'sounds'] },
  { path: '/trending',        priority: '0.9', changefreq: 'daily',   feedOf: ['videos', 'gifs', 'images', 'sounds'] },
  { path: '/videos',          priority: '0.8', changefreq: 'daily',   feedOf: ['videos'] },
  { path: '/gifs',            priority: '0.8', changefreq: 'daily',   feedOf: ['gifs'] },
  { path: '/templates',       priority: '0.8', changefreq: 'weekly',  feedOf: ['images'] },
  { path: '/sounds',          priority: '0.7', changefreq: 'weekly',  feedOf: ['sounds'] },
  { path: '/ai-sound',        priority: '0.7', changefreq: 'weekly'  },
  { path: '/blog',            priority: '0.7', changefreq: 'weekly',  feedOf: ['blog'] },
  { path: '/help',            priority: '0.6', changefreq: 'monthly' },
  { path: '/about',           priority: '0.5', changefreq: 'monthly' },
  { path: '/contact',         priority: '0.5', changefreq: 'monthly' },
  { path: '/content-policy',  priority: '0.4', changefreq: 'monthly' },
  { path: '/privacy',         priority: '0.4', changefreq: 'monthly' },
  { path: '/terms',           priority: '0.4', changefreq: 'monthly' },
  { path: '/disclaimer',      priority: '0.3', changefreq: 'yearly'  },
  { path: '/cookie-policy',   priority: '0.3', changefreq: 'yearly'  },
]
