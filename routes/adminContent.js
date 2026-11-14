/**
 * Admin content editor — mounted at /api/admin/content.
 *
 * GET    /            — searchable, filterable, paginated list of all assets
 * GET    /:memeId     — one asset with every editable field
 * PATCH  /:memeId     — edit title, descriptions, category, tags, status
 * POST   /bulk        — apply a status or triage flag to many assets at once
 * POST   /download    — stream a ZIP of selected (or all matching) assets
 *
 * Unlike /api/admin/pending, this lists assets in *every* state — the point is
 * to backfill descriptions across published content, not to moderate a queue.
 */

import { Readable } from 'node:stream'
import { Router } from 'express'
import archiver from 'archiver'
import { DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { GoogleGenAI } from '@google/genai'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { Query, getRow, updateRow, deleteRow, listRows, listAllRows } from '../db/d1.js'
import { spaces, BUCKET } from '../spacesClient.js'
import { onContentChanged, FEED_PATHS, feedPathForCategory } from '../lib/sitemap/notify.js'
import {
  CATEGORIES,
  CONTENT_STATUSES,
  countWords,
  parseContentPatch,
} from '../lib/contentSchema.js'
import { entryNameFor, folderFor, uniqueEntryName } from '../lib/zipEntries.js'

const router = Router()
router.use(requireAuth, requireAdmin)

/** Columns the table view needs. description_long is summarised, not sent whole. */
const LIST_COLUMNS = [
  '$id', 'title', 'category', 'format', 'thumbnail_url', 'content_status', 'needs_description',
  'download_count', 'file_size_bytes', 'created_at', 'updated_at', 'last_updated_by', 'description_long',
]

const MAX_PAGE_SIZE = 100

/**
 * The table's filter set as Appwrite queries. Shared by the list endpoint and
 * the "download all matching" ZIP so both always agree on what "all" means.
 */
function listFilters({ q, category, status, needsDescription, missingDescription, from, to } = {}) {
  const out = []
  // Uses the fulltext index on title.
  if (typeof q === 'string' && q.trim()) out.push(Query.search('title', q.trim()))
  if (category && CATEGORIES.includes(category)) out.push(Query.equal('category', category))
  if (status && CONTENT_STATUSES.includes(status)) out.push(Query.equal('content_status', status))
  if (String(needsDescription) === 'true') out.push(Query.equal('needs_description', true))
  // Distinct from the triage flag: "no long description written yet" is a fact.
  if (String(missingDescription) === 'true') out.push(Query.isNull('description_long'))
  if (from) out.push(Query.greaterThanEqual('created_at', from))
  if (to) out.push(Query.lessThanEqual('created_at', to))
  return out
}

// ── GET /api/admin/content ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize ?? '25', 10) || 25))

  try {
    const { rows, total } = await listRows('memes', [
      ...listFilters(req.query),
      Query.select(LIST_COLUMNS),
      Query.orderDesc('created_at'),
      Query.limit(pageSize),
      Query.offset((page - 1) * pageSize),
    ])

    // Send a word count instead of the full description.
    const items = rows.map(({ description_long, ...row }) => ({
      ...row,
      description_words: countWords(description_long),
    }))

    res.json({ items, total, page, pageSize })
  } catch (err) {
    console.error('[admin/content] list failed:', err.message)
    res.status(500).json({ error: 'Failed to load content.' })
  }
})

// ── POST /api/admin/content/bulk ─────────────────────────────────────────────
/**
 * Declared before /:memeId so "bulk" is never parsed as an id.
 *
 * Accepts only the two fields that make sense to set en masse. Bulk-editing
 * prose would be meaningless, and bulk-editing titles is how you destroy a
 * catalogue by accident.
 */
router.post('/bulk', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === 'string') : []
  if (!ids.length) return res.status(400).json({ error: 'ids must be a non-empty array.' })
  if (ids.length > 500) return res.status(400).json({ error: 'A bulk edit is limited to 500 items.' })

  const patch = {}
  if ('content_status' in (req.body ?? {})) {
    if (!CONTENT_STATUSES.includes(req.body.content_status)) {
      return res.status(400).json({ error: `content_status must be one of: ${CONTENT_STATUSES.join(', ')}.` })
    }
    patch.content_status = req.body.content_status
  }
  if ('needs_description' in (req.body ?? {})) {
    patch.needs_description = Boolean(req.body.needs_description)
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Supply content_status and/or needs_description.' })
  }

  patch.last_updated_by = req.user.id
  patch.updated_at = new Date().toISOString()

  let data
  try {
    const updated = await Promise.all(ids.map((id) => updateRow('memes', id, patch)))
    data = updated.filter(Boolean).map(({ id, title, category, content_status }) => ({ id, title, category, content_status }))
  } catch (err) {
    console.error('[admin/content] bulk failed:', err.message)
    return res.status(500).json({ error: 'Bulk edit failed.' })
  }

  // Only a status change alters which URLs are indexable.
  if ('content_status' in patch) {
    const categories = [...new Set((data ?? []).map((m) => m.category))]
    onContentChanged({
      reason: `bulk ${patch.content_status}`,
      memes: data ?? [],
      paths: [...FEED_PATHS, ...categories.map(feedPathForCategory)].filter(Boolean),
    })
  }

  res.json({ ok: true, updated: data?.length ?? 0, items: data ?? [] })
})

// ── POST /api/admin/content/download ─────────────────────────────────────────
/**
 * Streams a ZIP of the original files for admin bulk download.
 * Declared before /:memeId for the same reason as /bulk.
 *
 * Body is one of:
 *   { ids: string[] }          — explicit selection
 *   { all: true, filters: {} } — every asset matching the table's filters
 *
 * Unlike the public /api/bulk-download this includes unpublished assets and
 * has a higher cap. Files are fetched from Spaces one at a time (the next
 * GetObject only starts once the previous entry is written), so a large
 * archive never holds hundreds of open upstream sockets.
 */
const MAX_ZIP_ITEMS = 500

/** Appends one stream and resolves once archiver has fully written that entry. */
function appendAndWait(archive, stream, name) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      archive.off('entry', onEntry)
      stream.off('error', onError)
    }
    const onEntry = () => { cleanup(); resolve() }
    const onError = (err) => { cleanup(); reject(err) }
    archive.on('entry', onEntry)
    stream.on('error', onError)
    archive.append(stream, { name })
  })
}

router.post('/download', async (req, res) => {
  const body = req.body ?? {}
  let filters

  if (body.all === true) {
    filters = listFilters(body.filters ?? {})
  } else {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id.trim()) : []
    if (!ids.length) return res.status(400).json({ error: 'Supply ids (non-empty array) or all: true.' })
    if (ids.length > MAX_ZIP_ITEMS) {
      return res.status(400).json({ error: `A ZIP download is limited to ${MAX_ZIP_ITEMS} items.` })
    }
    filters = [Query.equal('$id', ids)]
  }

  // Fetch one row past the cap so an oversized "all" request is rejected up
  // front rather than silently truncated.
  let memes
  try {
    memes = await listAllRows('memes', [
      ...filters,
      Query.select(['$id', 'title', 'spaces_key', 'filename', 'format', 'category']),
      Query.orderDesc('created_at'),
    ], { pageSize: 100, cap: MAX_ZIP_ITEMS + 1 })
  } catch (err) {
    console.error('[admin/content] download lookup failed:', err.message)
    return res.status(500).json({ error: 'Failed to look up files.' })
  }
  const total = memes.length
  if (total > MAX_ZIP_ITEMS) {
    return res.status(400).json({
      error: `${total} items match — a ZIP download is limited to ${MAX_ZIP_ITEMS}. Narrow the filters and try again.`,
    })
  }

  const downloadable = (memes ?? []).filter((m) => m.spaces_key)
  if (!downloadable.length) return res.status(404).json({ error: 'No downloadable files found.' })

  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="videsaur-admin-${stamp}.zip"`)

  // Media is already compressed; deflate would burn CPU for ~0% gain.
  const archive = archiver('zip', { store: true })
  let aborted = false
  res.on('close', () => {
    if (!res.writableFinished) {
      aborted = true
      archive.abort()
    }
  })
  archive.on('warning', (err) => console.warn('[admin/content] archiver warning:', err.message))
  archive.on('error', (err) => {
    console.error('[admin/content] archiver error:', err.message)
    res.destroy(err)
  })
  archive.pipe(res)

  const used = new Set()
  const failed = []

  for (const meme of downloadable) {
    if (aborted) return
    try {
      const { Body } = await spaces.send(new GetObjectCommand({ Bucket: BUCKET, Key: meme.spaces_key }))
      const stream = typeof Body?.pipe === 'function' ? Body : Readable.fromWeb(Body)
      // gifs/, images/, sounds/, videos/ — de-duplicated per folder, since `used` holds full paths.
      const entryPath = uniqueEntryName(`${folderFor(meme)}/${entryNameFor(meme)}`, used)
      await appendAndWait(archive, stream, entryPath)
    } catch (err) {
      console.error(`[admin/content] download skip ${meme.spaces_key}:`, err.message)
      failed.push(`${meme.id}\t${meme.title ?? ''}\t${err.message}`)
    }
  }

  if (aborted) return

  // Tell the admin which files are missing instead of silently shipping a short archive.
  if (failed.length) {
    archive.append(`Files that could not be fetched (${failed.length}):\n\n${failed.join('\n')}\n`, {
      name: uniqueEntryName('_failed.txt', used),
    })
  }

  archive.finalize()
})

// ── GET /api/admin/content/:memeId ───────────────────────────────────────────
router.get('/:memeId', async (req, res) => {
  const data = await getRow('memes', req.params.memeId).catch(() => null)
  if (!data) return res.status(404).json({ error: 'Content not found.' })
  res.json({ item: { ...data, description_words: countWords(data.description_long) } })
})

// ── PATCH /api/admin/content/:memeId ─────────────────────────────────────────
router.patch('/:memeId', async (req, res) => {
  const parsed = parseContentPatch(req.body ?? {})
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  const { memeId } = req.params

  // The title feeds the canonical slug, so a rename moves the URL. Read the
  // outgoing row first so both URLs can be submitted for recrawl.
  const previous = await getRow('memes', memeId).catch(() => null)
  if (!previous) return res.status(404).json({ error: 'Content not found.' })

  let data
  try {
    data = await updateRow('memes', memeId, {
      ...parsed.patch,
      last_updated_by: req.user.id,
      updated_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[admin/content] update failed:', err.message)
  }
  if (!data) return res.status(500).json({ error: 'Failed to save changes.' })

  // Descriptions are page content, not sitemap membership — but updated_at
  // moves either way, so lastmod advances and the page gets recrawled.
  const titleChanged = previous.title !== data.title
  onContentChanged({
    reason: 'content edit',
    memes: titleChanged ? [data, previous] : [data],
    paths: [...FEED_PATHS, feedPathForCategory(data.category)].filter(Boolean),
  })

  res.json({ ok: true, item: { ...data, description_words: countWords(data.description_long) } })
})

// ── POST /api/admin/content/:memeId/generate ─────────────────────────────────
const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? 'https://www.videsaur.co.in').replace(/\/+$/, '')

function toSlug(str) {
  return String(str ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

function memePageUrl(meme) {
  const prefix = meme.category === 'sounds' ? '/sound' : '/meme'
  const slug = toSlug(meme.title) || 'meme'
  return `${SITE_ORIGIN}${prefix}/${slug}-${meme.id}`
}

router.post('/:memeId/generate', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' })
  }

  const meme = await getRow('memes', req.params.memeId).catch(() => null)
  if (!meme) return res.status(404).json({ error: 'Content not found.' })

  const selfUrl    = memePageUrl(meme)
  const categoryUrl = `${SITE_ORIGIN}/${meme.category ?? 'videos'}`
  const trendingUrl = `${SITE_ORIGIN}/trending`
  const moods = Array.isArray(meme.mood_tags) && meme.mood_tags.length
    ? meme.mood_tags.join(', ')
    : 'funny, relatable'

  const prompt = `You are an expert SEO content writer. Write a unique, engaging, Google AdSense-friendly meme description for the video meme titled: "${meme.title}".

REQUIREMENTS:
- Minimum 450 words, maximum 550 words
- Unique content — never generic; every sentence must be specific to THIS meme
- Optimised for Google search ranking: use the title naturally 3–4 times as a keyword phrase
- Mood / tone: ${moods}
- Format: ${meme.format ?? 'MP4 video'}
- Category: ${meme.category ?? 'videos'}
- Include EXACTLY 2 internal links using <a href="..."> tags:
    1. Link text related to browsing more memes → href="${categoryUrl}"
    2. Link text related to what's trending → href="${trendingUrl}"
- Include EXACTLY 1 external backlink to a real, relevant, authoritative source (Wikipedia, Know Your Meme, YouTube, IMDb, or a news article) that contextualises this meme's origin or cultural reference. Use a real, correct URL.
- DO NOT invent facts. If you are unsure of the real origin, write confidently about the cultural/emotional context instead.

Return ONLY clean HTML — no markdown, no code fences, no backticks. Allowed tags: <h3>, <p>, <strong>, <em>, <a href="..." target="_blank" rel="noopener noreferrer">.

Structure exactly:

<h3>What Is This Meme</h3>
<p>3–4 sentences. Explain the real origin, who is in the clip, what happens, and why it went viral. Mention the title "${meme.title}" naturally. Include the external backlink here where it adds context.</p>

<h3>Why People Use It</h3>
<p>3–4 sentences. Describe the specific emotion — sarcasm, shock, joy, frustration — and the exact situations people drop this meme into: arguments, group chats, reactions to news, etc.</p>

<h3>How to Use This Meme</h3>
<p>3–4 sentences. Practical usage: WhatsApp status, Instagram Reels captions, YouTube Shorts overlays, video editing reaction cuts. Give concrete example scenarios.</p>

<h3>Format & Quality</h3>
<p>2–3 sentences. Describe the video format (${meme.format ?? 'MP4'}), resolution quality, that it is watermark-free and ready to download. Include the first internal link naturally here — e.g. "Browse more ${meme.category ?? 'video'} memes on <a href="${categoryUrl}" ...>Videsaur ${meme.category ?? 'videos'}</a>."</p>

<h3>Related Memes & Trending Content</h3>
<p>3–4 sentences. Connect this meme thematically to similar viral trends and cultural moments. Include the second internal link — e.g. "Check out the latest <a href="${trendingUrl}" ...>trending memes</a> on Videsaur." End with a sentence encouraging the reader to download and share.</p>`

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    const response = await ai.models.generateContent({
      model: 'gemma-4-26b-a4b-it',
      contents: prompt,
    })
    let html = response.text ?? ''
    // Strip any markdown code fences Gemini might accidentally wrap output in
    html = html.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim()
    res.json({ html })
  } catch (err) {
    console.error('[generate-description]', err.message)
    res.status(500).json({ error: 'Gemini request failed: ' + err.message })
  }
})

// ── DELETE /api/admin/content/:memeId ────────────────────────────────────────
router.delete('/:memeId', async (req, res) => {
  const { memeId } = req.params

  const meme = await getRow('memes', memeId).catch(() => null)
  if (!meme) return res.status(404).json({ error: 'Content not found.' })

  try {
    await deleteRow('memes', memeId)
  } catch (delErr) {
    console.error('[admin/content] delete failed:', delErr.message)
    return res.status(500).json({ error: 'Failed to delete meme.' })
  }

  onContentChanged({
    reason: 'delete',
    memes: [meme],
    paths: [...FEED_PATHS, feedPathForCategory(meme.category)].filter(Boolean),
  })

  const keys = [meme.spaces_key, meme.thumbnail_spaces_key].filter(Boolean)
  if (keys.length) {
    spaces
      .send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }))
      .catch((err) => console.error('[admin/content] Spaces delete error:', err.message))
  }

  res.json({ ok: true })
})

export default router
