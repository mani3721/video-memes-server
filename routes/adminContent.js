/**
 * Admin content editor — mounted at /api/admin/content.
 *
 * GET    /            — searchable, filterable, paginated list of all assets
 * GET    /:memeId     — one asset with every editable field
 * PATCH  /:memeId     — edit title, descriptions, category, tags, status
 * POST   /bulk        — apply a status or triage flag to many assets at once
 *
 * Unlike /api/admin/pending, this lists assets in *every* state — the point is
 * to backfill descriptions across published content, not to moderate a queue.
 */

import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../supabaseClient.js'
import { onContentChanged, FEED_PATHS, feedPathForCategory } from '../lib/sitemap/notify.js'
import {
  CATEGORIES,
  CONTENT_STATUSES,
  countWords,
  parseContentPatch,
} from '../lib/contentSchema.js'

const router = Router()
router.use(requireAuth, requireAdmin)

/** Columns the table view needs. description_long is summarised, not sent whole. */
const LIST_COLUMNS =
  'id, title, category, format, thumbnail_url, content_status, needs_description, ' +
  'download_count, file_size_bytes, created_at, updated_at, last_updated_by, description_long'

const MAX_PAGE_SIZE = 100

/** Escape PostgREST's `ilike` wildcards so a literal % or _ in a search does not match everything. */
function escapeLike(term) {
  return term.replace(/[\\%_,()]/g, (c) => `\\${c}`)
}

// ── GET /api/admin/content ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { q, category, status, needsDescription, missingDescription, from, to } = req.query

  const page = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize ?? '25', 10) || 25))

  let query = supabase.from('memes').select(LIST_COLUMNS, { count: 'exact' })

  if (q?.trim()) query = query.ilike('title', `%${escapeLike(q.trim())}%`)
  if (category && CATEGORIES.includes(category)) query = query.eq('category', category)
  if (status && CONTENT_STATUSES.includes(status)) query = query.eq('content_status', status)
  if (needsDescription === 'true') query = query.eq('needs_description', true)
  // Distinct from the triage flag: "no long description written yet" is a fact
  // about the data, whereas needs_description is an admin's judgement call.
  if (missingDescription === 'true') query = query.is('description_long', null)
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)

  const offset = (page - 1) * pageSize
  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1)

  if (error) {
    console.error('[admin/content] list failed:', error.message)
    return res.status(500).json({ error: 'Failed to load content.' })
  }

  // Send a word count instead of the full description: the table only needs to
  // show how complete each row is, and the bodies would dominate the payload.
  const items = (data ?? []).map(({ description_long, ...row }) => ({
    ...row,
    description_words: countWords(description_long),
  }))

  res.json({ items, total: count ?? 0, page, pageSize })
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

  const { data, error } = await supabase
    .from('memes')
    .update(patch)
    .in('id', ids)
    .select('id, title, category, content_status')

  if (error) {
    console.error('[admin/content] bulk failed:', error.message)
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

// ── GET /api/admin/content/:memeId ───────────────────────────────────────────
router.get('/:memeId', async (req, res) => {
  const { data, error } = await supabase
    .from('memes')
    .select('*')
    .eq('id', req.params.memeId)
    .single()

  if (error || !data) return res.status(404).json({ error: 'Content not found.' })
  res.json({ item: { ...data, description_words: countWords(data.description_long) } })
})

// ── PATCH /api/admin/content/:memeId ─────────────────────────────────────────
router.patch('/:memeId', async (req, res) => {
  const parsed = parseContentPatch(req.body ?? {})
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  const { memeId } = req.params

  // The title feeds the canonical slug, so a rename moves the URL. Read the
  // outgoing row first so both URLs can be submitted for recrawl.
  const { data: previous } = await supabase
    .from('memes')
    .select('id, title, category, content_status')
    .eq('id', memeId)
    .single()

  if (!previous) return res.status(404).json({ error: 'Content not found.' })

  const { data, error } = await supabase
    .from('memes')
    .update({ ...parsed.patch, last_updated_by: req.user.id })
    .eq('id', memeId)
    .select('*')
    .single()

  if (error || !data) {
    console.error('[admin/content] update failed:', error?.message)
    return res.status(500).json({ error: 'Failed to save changes.' })
  }

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

export default router
