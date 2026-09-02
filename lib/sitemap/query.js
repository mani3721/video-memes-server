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
const COLUMNS =
  'id, title, category, format, public_url, thumbnail_url, duration_seconds, download_count, license, created_at, updated_at'

/**
 * Whether public.memes has the moderation columns from
 * db/migrations/002_sitemap_moderation.sql.
 *
 * Probed once per process instead of assumed, so the sitemap keeps working on a
 * database where the migration has not been applied yet — it just falls back to
 * is_published as the only gate.
 *
 * null = not probed yet, true/false = known.
 */
let moderationColumnsAvailable = null

/**
 * In-flight probe, shared by concurrent callers.
 *
 * Needed because a single sitemap build fans out ~8 parallel queries and every
 * one of them asks about the columns before the first answer arrives. Caching
 * only the resolved value would still fire 8 probes per cold build.
 */
let moderationProbe = null

async function runModerationProbe() {
  const { error } = await supabase.from('memes').select('id').eq('is_flagged', false).limit(1)

  if (!error) return true

  if (error.code === '42703') {
    // PostgreSQL "undefined_column" — the migration has not been run.
    console.warn(
      '[sitemap] memes.is_flagged missing — DMCA/policy exclusion is inactive. Run db/migrations/002_sitemap_moderation.sql.',
    )
    return false
  }

  // Any other error is treated as transient, so a network blip does not
  // permanently disable the filter for the process lifetime. Throwing here
  // clears the memo below and lets the next caller retry.
  throw new Error(`moderation column probe failed: ${error.message}`)
}

async function hasModerationColumns() {
  if (moderationColumnsAvailable !== null) return moderationColumnsAvailable

  moderationProbe ??= runModerationProbe()

  try {
    moderationColumnsAvailable = await moderationProbe
    return moderationColumnsAvailable
  } catch (err) {
    // Retry on the next call rather than caching the failure.
    moderationProbe = null
    console.warn(`[sitemap] ${err.message} — filtering on is_published only for now`)
    return false
  }
}

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
  const rows = []

  while (rows.length < limit) {
    const from = offset + rows.length
    const to = from + Math.min(DB_PAGE_SIZE, limit - rows.length) - 1

    const { data, error } = await applyIndexableFilter(
      supabase.from('memes').select(COLUMNS),
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

/** Test seam — lets a caller reset the cached column probe. */
export function _resetModerationProbe() {
  moderationColumnsAvailable = null
  moderationProbe = null
}
