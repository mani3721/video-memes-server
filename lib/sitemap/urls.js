/**
 * Canonical URL construction for meme pages.
 *
 * ⚠  This MUST stay byte-identical to toSlug/toMemeSlug/toMemeUrl in
 *    client/src/utils/seo.js. The client renders <link rel="canonical"> from
 *    its copy; the sitemap emits <loc> from this one. If the two ever drift,
 *    Google sees a sitemap URL whose page points somewhere else and drops the
 *    URL as a duplicate.
 *
 *    The duplication is forced by the repo layout: client/ and server/ are
 *    separate git repos with separate deploys and no shared package.
 */

import { SITE_ORIGIN } from './config.js'

/** "Cat Slams Laptop Shut" → "cat-slams-laptop-shut" */
export function toSlug(str) {
  return String(str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Path segment for a meme: "cat-slams-laptop-shut-<uuid>".
 *
 * Titles with no latin characters at all (e.g. pure Devanagari) slugify to an
 * empty string, so fall back to "meme" rather than emitting a bare "-<uuid>".
 * MemePage resolves the row from the trailing UUID, so the prefix is cosmetic.
 */
export function toMemeSlug(meme) {
  const slug = toSlug(meme.title)
  return `${slug || 'meme'}-${meme.id}`
}

/** Root-relative canonical path for a meme page. */
export function toMemePath(meme) {
  return `/meme/${toMemeSlug(meme)}`
}

/** Absolute canonical URL for a meme page. */
export function toMemeUrl(meme) {
  return `${SITE_ORIGIN}${toMemePath(meme)}`
}

/** Absolute URL for any root-relative site path. */
export function absolute(path) {
  return `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`
}
