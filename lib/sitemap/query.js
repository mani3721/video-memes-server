/**
 * Supabase reads for sitemap generation.
 *
 * Everything here runs through the service-role client, so the exclusion rules
 * are enforced explicitly in each query rather than inherited from RLS.
 */

import { supabase } from '../../supabaseClient.js'
import {
  DB_PAGE_SIZE,
  PRIORITY,
  RECENT_WINDOW_DAYS,
  TRENDING_DOWNLOADS,
} from './config.js'

/** Columns the generator needs. Selecting explicitly keeps payloads small. */
const BASE_COLUMNS =
  'id, title, category, format, public_url, thumbnail_url, duration_seconds, ' +
  'download_count, license, created_at, updated_at'

/**
 * Selecting a column that does not exist fails the whole query, so the
 * long-description column is only requested once it has been confirmed present.
 */
async function selectColumns() {
  return (await hasLongDescription()) ? `${BASE_COLUMNS}, description_long` : BASE_COLUMNS
}

/**
 * Feature probes.
 *
 * The sitemap must keep serving on a database where a migration has not been
 * applied yet, because the server and the SQL are deployed independently. A
 * missing column or table degrades that one feature instead of 503-ing every
 * file — an unapplied migration taking down a working sitemap would be a far
 * worse failure than a temporarily incomplete one.
 *
 * Each probe caches its answer, and shares the in-flight promise: a single
 * sitemap build fans out ~8 parallel queries that all ask the same question
 * before the first answer returns, so caching only the resolved value would
 * still fire one probe per query.
 */

/** PostgreSQL undefined_column, plus PostgREST's own missing-table codes. */
const MISSING_COLUMN_CODES = new Set(['42703'])
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205', 'PGRST200'])

function makeProbe({ name, run, missingCodes, missingMessage }) {
  let available = null
  let inFlight = null

  return async function probe() {
    if (available !== null) return available

    inFlight ??= (async () => {
      const { error } = await run()
      if (!error) return true
      if (missingCodes.has(error.code)) {
        console.warn(`[sitemap] ${missingMessage}`)
        return false
      }
      // Anything else is treated as transient so a network blip does not
      // permanently disable the feature for the process lifetime.
      throw new Error(`${name} probe failed: ${error.message}`)
    })()

    try {
      available = await inFlight
      return available
    } catch (err) {
      inFlight = null // retry on the next call rather than caching the failure
      console.warn(`[sitemap] ${err.message} — treating ${name} as unavailable for now`)
      return false
    }
  }
}

/**
 * Whether public.memes has the moderation columns from
 * db/migrations/002_sitemap_moderation.sql. False means the DMCA/policy filter
 * is inactive and only is_published gates the sitemap.
 */
const hasModerationColumns = makeProbe({
  name: 'moderation column',
  run: () => supabase.from('memes').select('id').eq('is_flagged', false).limit(1),
  missingCodes: MISSING_COLUMN_CODES,
  missingMessage:
    'memes.is_flagged missing — DMCA/policy exclusion is inactive. Run db/migrations/002_sitemap_moderation.sql.',
})

/**
 * Whether memes.description_long exists (db/migrations/003_content_depth.sql).
 * False makes video:description fall back to the spec-derived sentence rather
 * than failing every content query with an undefined-column error.
 */
const hasLongDescription = makeProbe({
  name: 'long description column',
  run: () => supabase.from('memes').select('description_long').limit(1),
  missingCodes: MISSING_COLUMN_CODES,
  missingMessage:
    'memes.description_long missing — sitemap descriptions fall back to the template. Run db/migrations/003_content_depth.sql.',
})

/**
 * Whether public.blog_posts exists (db/migrations/003_content_depth.sql).
 * False makes the blog group behave as empty rather than failing the build.
 */
const hasBlogTable = makeProbe({
  name: 'blog table',
  run: () => supabase.from('blog_posts').select('id').limit(1),
  missingCodes: MISSING_TABLE_CODES,
  missingMessage:
    'public.blog_posts missing — blog sitemap will be empty. Run db/migrations/003_content_depth.sql.',
})

/**
 * Apply the indexability rules shared by every content query.
 *
 * A URL belongs in the sitemap only if it renders a live, canonical, indexable
 * page. That means published, not flagged for DMCA/policy, and in one of the
 * requested categories.
 */
function applyIndexableFilter(query, categories, moderated) {
  let q = query.eq('is_published', true).in('category', categories)
  if (moderated) q = q.eq('is_flagged', false)
  return q
}

/** Number of indexable rows in the given categories. */
export async function countIndexable(categories) {
  const moderated = await hasModerationColumns()
  const { count, error } = await applyIndexableFilter(
    supabase.from('memes').select('id', { count: 'exact', head: true }),
    categories,
    moderated,
  )

  if (error) throw new Error(`sitemap count failed: ${error.message}`)
  return count ?? 0
}

/**
 * Fetch one sitemap file's worth of rows.
 *
 * Ordered by created_at ASC (id ASC as a tiebreak for rows sharing a
 * timestamp). Ascending order is deliberate: new uploads append to the *last*
 * page, so page 1..n-1 stay byte-stable as the catalogue grows. Descending
 * order would reshuffle every page on every upload and force crawlers to
 * re-fetch the whole set.
 *
 * PostgREST caps rows per response, so a file is assembled from successive
 * DB_PAGE_SIZE slices.
 */
export async function fetchIndexablePage(categories, offset, limit) {
  const moderated = await hasModerationColumns()
  const columns = await selectColumns()
  const rows = []

  while (rows.length < limit) {
    const from = offset + rows.length
    const to = from + Math.min(DB_PAGE_SIZE, limit - rows.length) - 1

    const { data, error } = await applyIndexableFilter(
      supabase.from('memes').select(columns),
      categories,
      moderated,
    )
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)

    if (error) throw new Error(`sitemap fetch failed: ${error.message}`)
    if (!data?.length) break

    rows.push(...data)
    if (data.length < to - from + 1) break // short page — end of the table
  }

  return rows
}

/** Most recent updated_at across the given categories, for <lastmod> on the index. */
export async function latestChangeAt(categories) {
  const moderated = await hasModerationColumns()
  const { data, error } = await applyIndexableFilter(
    supabase.from('memes').select('updated_at, created_at'),
    categories,
    moderated,
  )
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) throw new Error(`sitemap lastmod failed: ${error.message}`)
  const row = data?.[0]
  return row ? lastModifiedOf(row) : null
}

// ── Blog posts ───────────────────────────────────────────────────────────────
// A separate table with its own publication rule, so it does not share
// applyIndexableFilter. Only `published` posts are ever indexable; `draft` and
// `removed` are excluded, matching the RLS policy on blog_posts.

const BLOG_COLUMNS = 'id, slug, title, excerpt, published_at, created_at, updated_at'

function publishedBlogPosts(query) {
  return query.eq('status', 'published')
}

/** Number of indexable blog posts. */
export async function countBlogPosts() {
  if (!(await hasBlogTable())) return 0
  const { count, error } = await publishedBlogPosts(
    supabase.from('blog_posts').select('id', { count: 'exact', head: true }),
  )
  if (error) throw new Error(`sitemap blog count failed: ${error.message}`)
  return count ?? 0
}

/** One sitemap file's worth of blog posts, oldest first for page stability. */
export async function fetchBlogPage(offset, limit) {
  if (!(await hasBlogTable())) return []
  const rows = []

  while (rows.length < limit) {
    const from = offset + rows.length
    const to = from + Math.min(DB_PAGE_SIZE, limit - rows.length) - 1

    const { data, error } = await publishedBlogPosts(supabase.from('blog_posts').select(BLOG_COLUMNS))
      .order('published_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)

    if (error) throw new Error(`sitemap blog fetch failed: ${error.message}`)
    if (!data?.length) break

    rows.push(...data)
    if (data.length < to - from + 1) break
  }

  return rows
}

/** Most recent blog change, for <lastmod> on the index and the /blog page. */
export async function latestBlogChangeAt() {
  if (!(await hasBlogTable())) return null
  const { data, error } = await publishedBlogPosts(
    supabase.from('blog_posts').select('updated_at, created_at'),
  )
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) throw new Error(`sitemap blog lastmod failed: ${error.message}`)
  return data?.[0] ? lastModifiedOf(data[0]) : null
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
  return {
    moderationColumns: await hasModerationColumns(),
    longDescription: await hasLongDescription(),
    blogTable: await hasBlogTable(),
  }
}
