/**
 * Helpers for naming files inside a bulk-download ZIP.
 *
 * Kept free of I/O so they can be unit-tested without Spaces or Supabase.
 */

/** Strip path separators and control characters so an entry can never escape the archive root. */
export function sanitizeEntryName(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'file'
}

/** Best available filename for a meme row: stored filename → Spaces key basename → id. */
export function entryNameFor(meme) {
  const fromKey = meme?.spaces_key ? String(meme.spaces_key).split('/').pop() : ''
  return sanitizeEntryName(meme?.filename || fromKey || meme?.id)
}

/**
 * Returns `name`, or `name (2).ext`, `name (3).ext`… so two assets that share a
 * filename don't silently overwrite each other when the ZIP is extracted.
 * Mutates `used` (a Set of lower-cased names already in the archive).
 */
export function uniqueEntryName(name, used) {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  let candidate = name
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base} (${n})${ext}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}
