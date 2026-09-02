/**
 * Renders each sitemap file. Pure assembly: reads via query.js, serialises via
 * xml.js, and knows nothing about HTTP or caching.
 */

import {
  CONTENT_GROUPS,
  MAX_URLS_PER_FILE,
  POLICY_LASTMOD,
  STATIC_PAGES,
  VIDEO_FORMATS,
} from './config.js'
import { buildSitemapIndex, buildUrlSet } from './xml.js'
import {
  countIndexable,
  crawlHintsFor,
  fetchIndexablePage,
  lastModifiedOf,
  latestChangeAt,
} from './query.js'
import { absolute, toMemeUrl } from './urls.js'

export const GROUP_NAMES = Object.keys(CONTENT_GROUPS)

/** Filename for a group's page. Page 1 of a single-page group drops the suffix. */
export function contentFileName(group, page, totalPages) {
  return totalPages <= 1 ? `sitemap-${group}.xml` : `sitemap-${group}-${page}.xml`
}

/** How many files a group needs. Always at least 1 so the index stays stable. */
export function pageCountFor(total) {
  return Math.max(1, Math.ceil(total / MAX_URLS_PER_FILE))
}

// ── Per-row media tags ───────────────────────────────────────────────────────

/**
 * The description Google shows alongside a video result. Kept word-for-word in
 * sync with the meta description MemePage renders, so the sitemap and the page
 * do not disagree about what the asset is.
 */
function describe(row) {
  return `Download ${row.title} meme free in HD. ${row.format} format, no watermark. Perfect for WhatsApp status, Reels, Shorts, and editing.`
}

/**
 * Decide which media extension a row gets.
 *
 * The group's declared `media` is an intent, not a guarantee — category and
 * format are independent columns, so a GIF can legitimately sit in the
 * 'videos' category. Emitting <video:video> for a GIF would get the entry
 * rejected (content_loc must be a real video stream), so the format is
 * re-checked per row and the entry degrades to <image:image> instead.
 */
function mediaFor(row, media) {
  if (media === 'none') return {}

  const canBeVideo = media === 'video' && VIDEO_FORMATS.has(row.format) && row.public_url && row.thumbnail_url

  if (canBeVideo) {
    return {
      video: {
        thumbnailLoc: row.thumbnail_url,
        title: row.title,
        description: describe(row),
        contentLoc: row.public_url,
        duration: row.duration_seconds ?? null,
        publicationDate: row.created_at ? new Date(row.created_at).toISOString() : null,
        familyFriendly: 'yes',
      },
    }
  }

  const imageLoc = row.public_url ?? row.thumbnail_url
  return imageLoc ? { image: { loc: imageLoc } } : {}
}

/** Row → sitemap URL entry. */
function toUrlEntry(row, media, now) {
  return {
    loc: toMemeUrl(row),
    lastmod: lastModifiedOf(row),
    ...crawlHintsFor(row, now),
    ...mediaFor(row, media),
  }
}

// ── File builders ────────────────────────────────────────────────────────────

/**
 * One page of a content group, e.g. ('memes', 2).
 * Returns null when the page is out of range so the route can 404 rather than
 * serve an empty urlset that would look like every URL was removed.
 */
export async function buildContentSitemap(group, page = 1) {
  const config = CONTENT_GROUPS[group]
  if (!config) return null

  const total = await countIndexable(config.categories)
  const totalPages = pageCountFor(total)
  if (page < 1 || page > totalPages) return null

  const offset = (page - 1) * MAX_URLS_PER_FILE
  const rows = await fetchIndexablePage(config.categories, offset, MAX_URLS_PER_FILE)

  const now = Date.now()
  return buildUrlSet(rows.map((row) => toUrlEntry(row, config.media, now)))
}

/** The static-pages sitemap. */
export async function buildPagesSitemap() {
  // Listing pages report the newest asset in the categories they show, so a
  // fresh upload also nudges a recrawl of the feed that surfaces it.
  const feedCategories = [...new Set(STATIC_PAGES.flatMap((p) => p.feedOf ?? []))]
  const latestByCategory = new Map(
    await Promise.all(
      feedCategories.map(async (category) => [category, await latestChangeAt([category])]),
    ),
  )

  const urls = STATIC_PAGES.map((page) => {
    const feedLastmod = (page.feedOf ?? [])
      .map((category) => latestByCategory.get(category))
      .filter(Boolean)
      .sort()
      .pop()

    return {
      loc: absolute(page.path),
      lastmod: feedLastmod ?? POLICY_LASTMOD,
      changefreq: page.changefreq,
      priority: page.priority,
    }
  })

  return buildUrlSet(urls)
}

/**
 * The sitemap index.
 *
 * Enumerates every group page, including groups that are currently empty: a
 * stable file list means a group's first upload does not change the index's
 * shape, and an empty urlset is valid.
 */
export async function buildIndexSitemap() {
  const entries = [{ loc: absolute('/sitemap-pages.xml'), lastmod: null }]

  const groups = await Promise.all(
    GROUP_NAMES.map(async (group) => {
      const { categories } = CONTENT_GROUPS[group]
      const [total, lastmod] = await Promise.all([
        countIndexable(categories),
        latestChangeAt(categories),
      ])
      return { group, totalPages: pageCountFor(total), lastmod }
    }),
  )

  for (const { group, totalPages, lastmod } of groups) {
    for (let page = 1; page <= totalPages; page += 1) {
      entries.push({
        loc: absolute(`/${contentFileName(group, page, totalPages)}`),
        lastmod,
      })
    }
  }

  // The pages sitemap tracks the newest content across every group, since the
  // listing pages it contains are driven by that content.
  const newest = groups
    .map((g) => g.lastmod)
    .filter(Boolean)
    .sort()
    .pop()
  entries[0].lastmod = newest ?? POLICY_LASTMOD

  return buildSitemapIndex(entries)
}

/**
 * Resolve a requested filename to a builder.
 * Returns null for anything unrecognised so the route can 404 cleanly.
 */
export function resolveFile(name) {
  if (name === 'sitemap.xml') return { kind: 'index', build: buildIndexSitemap }
  if (name === 'sitemap-pages.xml') return { kind: 'pages', build: buildPagesSitemap }

  const match = name.match(/^sitemap-([a-z]+)(?:-(\d+))?\.xml$/)
  if (!match) return null

  const [, group, rawPage] = match
  if (!CONTENT_GROUPS[group]) return null

  const page = rawPage ? Number.parseInt(rawPage, 10) : 1
  if (!Number.isSafeInteger(page) || page < 1) return null

  return { kind: 'content', build: () => buildContentSitemap(group, page) }
}
