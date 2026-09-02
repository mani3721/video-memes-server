/**
 * The single hook content routes call when the catalogue changes.
 *
 * Keeping this as one function means upload/admin routes do not need to know
 * anything about caching, pagination or IndexNow — they just say what changed.
 */

import { invalidate } from './cache.js'
import { submitToIndexNow } from './indexnow.js'
import { absolute, toMemeUrl } from './urls.js'

/**
 * Record a content change.
 *
 * Fire-and-forget by design: it is called from request handlers that must not
 * wait on an outbound HTTP call, and a failed notification never invalidates
 * the write that triggered it.
 *
 * @param {object}   change
 * @param {string}   change.reason  short label for the logs, e.g. 'upload'
 * @param {object[]} [change.memes] rows (needs id + title) whose pages changed
 * @param {string[]} [change.paths] extra site-relative paths that changed
 * @returns {number} how many cached sitemap files were dropped
 */
export function onContentChanged({ reason, memes = [], paths = [] }) {
  // Synchronous so the very next sitemap request already rebuilds, even if the
  // IndexNow call below is still in flight.
  const cleared = invalidate(reason)

  const urls = [
    ...memes.filter((m) => m?.id).map(toMemeUrl),
    ...paths.map(absolute),
  ]

  if (!urls.length) return cleared

  submitToIndexNow(urls)
    .then((result) => {
      if (result.submitted) console.log(`[sitemap] IndexNow: ${result.submitted} URL(s) after ${reason}`)
    })
    .catch((err) => console.warn('[sitemap] IndexNow notify failed:', err.message))

  return cleared
}

/**
 * Listing pages whose contents change whenever any asset is added or removed.
 *
 * Only real content URLs belong here — IndexNow takes pages to recrawl, not
 * sitemap files, so the sitemap index is deliberately absent.
 */
export const FEED_PATHS = ['/', '/trending']

/** Listing page for a category, so a new upload also nudges its feed. */
export function feedPathForCategory(category) {
  return { videos: '/videos', gifs: '/gifs', images: '/templates', sounds: '/sounds' }[category] ?? null
}
