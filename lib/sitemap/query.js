/**
 * Appwrite reads for sitemap generation.
 *
 * Everything here runs with the server API key, so the exclusion rules are
 * enforced explicitly in each query rather than inherited from permissions.
 *
 * The Appwrite tables were built from the full schema (moderation columns,
 * description_long and blog_posts all exist), so the old Supabase "is this
 * migration applied yet?" probes are gone; featureAvailability() still reports
 * them for the admin status endpoint.
 */

import { listRows, listAllRows, Query } from '../../db/appwrite.js'
import {
  DB_PAGE_SIZE,
  PRIORITY,
  RECENT_WINDOW_DAYS,
  TRENDING_DOWNLOADS,
} from './config.js'

/** Columns the generator needs. Selecting explicitly keeps payloads small. */
const MEME_COLUMNS = [
  '$id', 'title', 'category', 'format', 'public_url', 'thumbnail_url', 'duration_seconds',
  'download_count', 'license', 'created_at', 'updated_at', 'description_long',
]

/** Appwrite caps a page at 5000 rows; stay well under it. */
const PAGE = Math.min(DB_PAGE_SIZE, 1000)

/**
 * A URL belongs in the sitemap only if it renders a live, canonical, indexable
 * page: published, not flagged for DMCA/policy, and in a requested category.
 * `is_flagged` was imported as nullable, so "not true" rather than "= false".
 */
function indexableFilter(categories) {
  return [
    Query.equal('is_published', true),
    Query.equal('category', categories),
    Query.notEqual('is_flagged', true),
  ]
}

/** Number of indexable rows in the given categories. */
export async function countIndexable(categories) {
  try {
    const { total } = await listRows('memes', [...indexableFilter(categories), Query.limit(1)])
    // Appwrite caps total at 5000; count exactly above that.
    if (total < 5000) return total
    const ids = await listAllRows('memes', [...indexableFilter(categories), Query.select(['$id'])])
    return ids.length
  } catch (err) {
    throw new Error(`sitemap count failed: ${err.message}`)
  }
}

/**
 * Fetch one sitemap file's worth of rows, ordered by created_at ASC ($id as a
 * tiebreak). Ascending order keeps pages 1..n-1 byte-stable as uploads append
 * to the last page.
 */
export async function fetchIndexablePage(categories, offset, limit) {
  const rows = []
  try {
    while (rows.length < limit) {
      const size = Math.min(PAGE, limit - rows.length)
      const { rows: data } = await listRows('memes', [
        ...indexableFilter(categories),
        Query.select(MEME_COLUMNS),
        Query.orderAsc('created_at'),
        Query.orderAsc('$id'),
        Query.offset(offset + rows.length),
        Query.limit(size),
      ])
      if (!data.length) break
      rows.push(...data)
      if (data.length < size) break // short page — end of the table
    }
  } catch (err) {
    throw new Error(`sitemap fetch failed: ${err.message}`)
  }
  return rows
}

/** Most recent updated_at across the given categories, for <lastmod> on the index. */
export async function latestChangeAt(categories) {
  try {
    const { rows } = await listRows('memes', [
      ...indexableFilter(categories),
      Query.select(['$id', 'updated_at', 'created_at']),
      Query.orderDesc('updated_at'),
      Query.limit(1),
    ])
    return rows[0] ? lastModifiedOf(rows[0]) : null
  } catch (err) {
    throw new Error(`sitemap lastmod failed: ${err.message}`)
  }
}

// ── Blog posts ───────────────────────────────────────────────────────────────
// Only `published` posts are ever indexable; `draft` and `removed` are excluded.

const BLOG_COLUMNS = ['$id', 'slug', 'title', 'excerpt', 'published_at', 'created_at', 'updated_at']
const PUBLISHED = Query.equal('status', 'published')

/** Number of indexable blog posts. */
export async function countBlogPosts() {
  try {
    const { total } = await listRows('blog_posts', [PUBLISHED, Query.limit(1)])
    return total
  } catch (err) {
    throw new Error(`sitemap blog count failed: ${err.message}`)
  }
}

/** One sitemap file's worth of blog posts, oldest first for page stability. */
export async function fetchBlogPage(offset, limit) {
  const rows = []
  try {
    while (rows.length < limit) {
      const size = Math.min(PAGE, limit - rows.length)
      const { rows: data } = await listRows('blog_posts', [
        PUBLISHED,
        Query.select(BLOG_COLUMNS),
        Query.orderAsc('published_at'),
        Query.orderAsc('$id'),
        Query.offset(offset + rows.length),
        Query.limit(size),
      ])
      if (!data.length) break
      rows.push(...data)
      if (data.length < size) break
    }
  } catch (err) {
    throw new Error(`sitemap blog fetch failed: ${err.message}`)
  }
  return rows
}

/** Most recent blog change, for <lastmod> on the index and the /blog page. */
export async function latestBlogChangeAt() {
  try {
    const { rows } = await listRows('blog_posts', [
      PUBLISHED,
      Query.select(['$id', 'updated_at', 'created_at']),
      Query.orderDesc('updated_at'),
      Query.limit(1),
    ])
    return rows[0] ? lastModifiedOf(rows[0]) : null
  } catch (err) {
    throw new Error(`sitemap blog lastmod failed: ${err.message}`)
  }
}

// ── Per-URL metadata rules ───────────────────────────────────────────────────

/**
 * <lastmod> for a row.
 *
 * updated_at is maintained by the memes_updated_at trigger, so an admin
 * retitling an asset moves its lastmod forward and prompts a recrawl. It can
 * legitimately trail created_at on rows written before the trigger existed,
 * hence the max().
 */
export function lastModifiedOf(row) {
  const created = row.created_at ? Date.parse(row.created_at) : NaN
  const updated = row.updated_at ? Date.parse(row.updated_at) : NaN
  const best = Math.max(Number.isNaN(created) ? 0 : created, Number.isNaN(updated) ? 0 : updated)
  return best > 0 ? new Date(best).toISOString() : null
}

function ageInDays(row, now) {
  const created = row.created_at ? Date.parse(row.created_at) : NaN
  if (Number.isNaN(created)) return Number.POSITIVE_INFINITY
  return (now - created) / 86_400_000
}

/**
 * changefreq / priority.
 *
 * Both are hints Google largely ignores for scheduling, but they cost nothing
 * and Bing still uses priority as a relative-importance signal within a site.
 *
 *   trending (high download_count) → daily / 0.9
 *   recently uploaded              → daily / 0.8
 *   everything else                → weekly / 0.5
 */
export function crawlHintsFor(row, now = Date.now()) {
  const isTrending = (row.download_count ?? 0) >= TRENDING_DOWNLOADS
  const isRecent = ageInDays(row, now) <= RECENT_WINDOW_DAYS

  if (isTrending) return { changefreq: 'daily', priority: PRIORITY.trending }
  if (isRecent) return { changefreq: 'daily', priority: PRIORITY.recent }
  return { changefreq: 'weekly', priority: PRIORITY.standard }
}

/** Exposed for the admin status endpoint and for diagnostics. */
export async function featureAvailability() {
  return { moderationColumns: true, longDescription: true, blogTable: true }
}
