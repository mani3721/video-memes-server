/**
 * XML serialisation for sitemaps.
 *
 * Titles and descriptions come from user input, so every interpolated value
 * goes through escapeXml(). A single unescaped "&" makes the whole file
 * unparseable and Google rejects it wholesale, not just the offending URL.
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/**
 * Characters XML 1.0 forbids *even as numeric entities*: the C0 controls other
 * than tab/LF/CR, plus U+FFFE/U+FFFF. Titles pasted out of other apps do
 * occasionally carry these, and one of them would poison the entire file.
 *
 * Built via the RegExp constructor so the source file itself stays free of
 * literal control characters.
 *
 * Note the surrogate range is deliberately *not* stripped: in UTF-16 every
 * emoji is a surrogate pair, so removing D800-DFFF would silently delete emoji
 * from titles. Lone (unpaired) surrogates are the only illegal case, and
 * toWellFormed() below replaces those with U+FFFD.
 */
const ILLEGAL_XML_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]', 'g')

export function escapeXml(value) {
  const str = String(value ?? '')
  return (str.toWellFormed ? str.toWellFormed() : str)
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/** Trim to `max` characters, preferring a word boundary. */
function truncate(value, max) {
  const str = String(value ?? '').trim()
  if (str.length <= max) return str
  const cut = str.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()
}

/** One `<tag>escaped</tag>` line, or '' when the value is empty. */
function tag(name, value, indent) {
  if (value === null || value === undefined || value === '') return ''
  return `${indent}<${name}>${escapeXml(value)}</${name}>`
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>'

// ── Sitemap index ────────────────────────────────────────────────────────────

/**
 * @param {{loc: string, lastmod?: string}[]} sitemaps
 */
export function buildSitemapIndex(sitemaps) {
  const body = sitemaps
    .map(({ loc, lastmod }) =>
      ['  <sitemap>', tag('loc', loc, '    '), tag('lastmod', lastmod, '    '), '  </sitemap>']
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n')

  return `${XML_DECL}
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>
`
}

// ── URL set ──────────────────────────────────────────────────────────────────

/**
 * Video sitemap extension.
 *
 * Child order follows Google's schema sequence — thumbnail_loc, title,
 * description, content_loc, player_loc, duration, … — because the XSD declares
 * a sequence rather than a choice, and validators reject reordered children.
 *
 * The constraints Google enforces, and how they are handled:
 *  - thumbnail_loc, title and description are all required
 *  - exactly one of content_loc / player_loc is required. content_loc must be a
 *    raw fetchable stream, never the HTML page, so callers pass the CDN object
 *    URL; player_loc is omitted because there is no embed page to point at
 *  - title caps at 100 chars, description at 2048
 *  - duration must be 1..28800s or the entry is dropped, so an unknown duration
 *    is omitted rather than sent as 0
 */
function buildVideoBlock(video) {
  const duration =
    Number.isFinite(video.duration) && video.duration >= 1 && video.duration <= 28800
      ? String(Math.round(video.duration))
      : null

  return [
    '    <video:video>',
    tag('video:thumbnail_loc', video.thumbnailLoc, '      '),
    tag('video:title', truncate(video.title, 100), '      '),
    tag('video:description', truncate(video.description, 2048), '      '),
    tag('video:content_loc', video.contentLoc, '      '),
    tag('video:player_loc', video.playerLoc, '      '),
    tag('video:duration', duration, '      '),
    tag('video:publication_date', video.publicationDate, '      '),
    tag('video:family_friendly', video.familyFriendly, '      '),
    tag('video:requires_subscription', 'no', '      '),
    tag('video:live', 'no', '      '),
    '    </video:video>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Image sitemap extension.
 *
 * Only <image:loc> is emitted: Google deprecated image:title, image:caption,
 * image:geo_location and image:license in 2022 and ignores them now, so
 * shipping them would only inflate a size-capped file.
 */
function buildImageBlock(image) {
  return ['    <image:image>', tag('image:loc', image.loc, '      '), '    </image:image>']
    .filter(Boolean)
    .join('\n')
}

/**
 * @param {{
 *   loc: string,
 *   lastmod?: string,
 *   changefreq?: string,
 *   priority?: string,
 *   video?: object,
 *   image?: object,
 * }[]} urls
 */
export function buildUrlSet(urls) {
  let needsVideoNs = false
  let needsImageNs = false

  const body = urls
    .map((url) => {
      if (url.video) needsVideoNs = true
      if (url.image) needsImageNs = true

      return [
        '  <url>',
        tag('loc', url.loc, '    '),
        tag('lastmod', url.lastmod, '    '),
        tag('changefreq', url.changefreq, '    '),
        tag('priority', url.priority, '    '),
        url.video ? buildVideoBlock(url.video) : '',
        url.image ? buildImageBlock(url.image) : '',
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  // Only declare namespaces the file actually uses. An unused xmlns is legal
  // but costs bytes in every file, and these files are size-capped.
  const ns = ['xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"']
  if (needsVideoNs) ns.push('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"')
  if (needsImageNs) ns.push('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"')

  return `${XML_DECL}
<urlset ${ns.join('\n        ')}>
${body}
</urlset>
`
}
