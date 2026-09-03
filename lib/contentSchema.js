/**
 * Shared validation for admin content edits.
 *
 * Kept out of the route files so the content editor and the bulk endpoint
 * cannot drift apart on what counts as a valid status or a valid description.
 */

export const CATEGORIES = ['videos', 'gifs', 'images', 'sounds']
export const CONTENT_STATUSES = ['draft', 'published', 'flagged', 'removed']

/**
 * The five subsections of description_long, in render order.
 *
 * Order matters: the meme page emits one <h3> per section in this sequence, so
 * this array is the single definition of the page's content structure.
 */
export const DESCRIPTION_SECTIONS = [
  { key: 'what', heading: 'What is this meme', hint: 'Origin and context of the clip, who is in it, what made it spread.' },
  { key: 'why', heading: 'Why people use it', hint: 'The emotion or reaction it conveys, and the situations it fits.' },
  { key: 'how', heading: 'How to use this meme', hint: 'WhatsApp status, Instagram Reels, YouTube Shorts, editing projects.' },
  { key: 'quality', heading: 'Format & quality', hint: 'Format, resolution and watermark-free status in natural language.' },
  { key: 'related', heading: 'Related memes', hint: 'A thematic lead-in to the You Might Also Like row.' },
]

export const SECTION_KEYS = DESCRIPTION_SECTIONS.map((s) => s.key)

/** Per-section cap. Five sections at this limit comfortably exceed 400 words. */
const MAX_SECTION_CHARS = 2000

/** Rough word count over every populated section. */
export function countWords(descriptionLong) {
  if (!descriptionLong || typeof descriptionLong !== 'object') return 0
  return SECTION_KEYS.reduce((total, key) => {
    const text = descriptionLong[key]
    if (typeof text !== 'string') return total
    const words = text.trim().split(/\s+/).filter(Boolean).length
    return total + words
  }, 0)
}

/**
 * Normalise a description_long payload.
 *
 * Unknown keys are dropped rather than rejected: the section list is expected
 * to grow, and an admin client running an older build should not have its save
 * fail because it omitted a key it has never heard of.
 *
 * @returns {{ value: object|null } | { error: string }}
 */
export function parseDescriptionLong(input) {
  if (input === null || input === undefined) return { value: null }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'description_long must be an object keyed by section.' }
  }

  const value = {}
  for (const key of SECTION_KEYS) {
    const raw = input[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') return { error: `description_long.${key} must be a string.` }

    const text = raw.trim()
    if (!text) continue
    if (text.length > MAX_SECTION_CHARS) {
      return { error: `description_long.${key} must be ${MAX_SECTION_CHARS} characters or fewer.` }
    }
    value[key] = text
  }

  // An object with every section blank is stored as NULL, so "has a long
  // description" stays a simple NOT NULL check everywhere downstream.
  return { value: Object.keys(value).length ? value : null }
}

/**
 * Validate a partial content edit. Only keys present in `body` are touched, so
 * the same function serves a full form save and a one-field toggle.
 *
 * @returns {{ patch: object } | { error: string }}
 */
export function parseContentPatch(body) {
  const patch = {}

  if ('title' in body) {
    const title = String(body.title ?? '').trim()
    if (!title) return { error: 'title is required.' }
    if (title.length > 200) return { error: 'title must be 200 characters or fewer.' }
    patch.title = title
  }

  if ('category' in body) {
    if (!CATEGORIES.includes(body.category)) {
      return { error: `category must be one of: ${CATEGORIES.join(', ')}.` }
    }
    patch.category = body.category
  }

  if ('content_status' in body) {
    if (!CONTENT_STATUSES.includes(body.content_status)) {
      return { error: `content_status must be one of: ${CONTENT_STATUSES.join(', ')}.` }
    }
    patch.content_status = body.content_status
  }

  if ('mood_tags' in body) {
    const tags = body.mood_tags
    if (!Array.isArray(tags)) return { error: 'mood_tags must be an array.' }
    const clean = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    if (clean.length > 12) return { error: 'mood_tags is limited to 12 tags.' }
    if (clean.some((t) => t.length > 40)) return { error: 'each mood tag must be 40 characters or fewer.' }
    patch.mood_tags = clean
  }

  if ('needs_description' in body) {
    patch.needs_description = Boolean(body.needs_description)
  }

  if ('description_long' in body) {
    const parsed = parseDescriptionLong(body.description_long)
    if (parsed.error) return { error: parsed.error }
    patch.description_long = parsed.value
  }

  if (!Object.keys(patch).length) return { error: 'No editable fields supplied.' }
  return { patch }
}
