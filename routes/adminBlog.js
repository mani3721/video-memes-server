/**
 * Blog management — mounted at /api/admin/blog.
 *
 * GET    /         — every post, any status
 * POST   /         — create
 * PATCH  /:postId  — edit
 * DELETE /:postId  — soft-remove (status = 'removed'); ?hard=true to really delete
 *
 * Blog posts are a separate content type from meme pages: editorial articles
 * that carry their own unique long-form copy and link internally to meme pages.
 * Public reads do not come through here — the client queries Supabase directly
 * and RLS exposes only published posts.
 */

import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../supabaseClient.js'
import { onContentChanged } from '../lib/sitemap/notify.js'

const router = Router()
router.use(requireAuth, requireAdmin)

const STATUSES = ['draft', 'published', 'removed']

/** Matches the slug CHECK constraint in migration 003. */
function slugify(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

/** @returns {{ patch: object } | { error: string }} */
function parsePostPatch(body, { requireTitle = false } = {}) {
  const patch = {}

  if ('title' in body || requireTitle) {
    const title = String(body.title ?? '').trim()
    if (!title) return { error: 'title is required.' }
    if (title.length > 200) return { error: 'title must be 200 characters or fewer.' }
    patch.title = title
  }

  if ('slug' in body) {
    const slug = slugify(body.slug)
    if (!slug) return { error: 'slug must contain at least one letter or digit.' }
    patch.slug = slug
  }

  if ('excerpt' in body) {
    const excerpt = String(body.excerpt ?? '').trim()
    if (excerpt.length > 400) return { error: 'excerpt must be 400 characters or fewer.' }
    patch.excerpt = excerpt || null
  }

  if ('body' in body) {
    const text = String(body.body ?? '')
    if (text.length > 100_000) return { error: 'body is too long.' }
    patch.body = text
  }

  if ('cover_url' in body) {
    const url = String(body.cover_url ?? '').trim()
    if (url && !/^https:\/\//.test(url)) return { error: 'cover_url must be an https URL.' }
    patch.cover_url = url || null
  }

  if ('status' in body) {
    if (!STATUSES.includes(body.status)) {
      return { error: `status must be one of: ${STATUSES.join(', ')}.` }
    }
    patch.status = body.status
  }

  if (!Object.keys(patch).length) return { error: 'No editable fields supplied.' }
  return { patch }
}

/**
 * Publishing or unpublishing a post changes the blog sitemap, so the cache has
 * to drop. Editing a draft changes nothing public.
 */
function notifyIfPublic(post, previousStatus, reason) {
  const wasPublic = previousStatus === 'published'
  const isPublic = post?.status === 'published'
  if (!wasPublic && !isPublic) return

  onContentChanged({
    reason,
    paths: ['/blog', ...(post?.slug ? [`/blog/${post.slug}`] : [])],
  })
}

// ── GET /api/admin/blog ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  // `body` is included so the manager can open a post for editing without a
  // second round-trip. Without it, saving an existing post would blank the body.
  let query = supabase
    .from('blog_posts')
    .select('id, slug, title, excerpt, body, cover_url, status, published_at, created_at, updated_at')

  if (STATUSES.includes(req.query.status)) query = query.eq('status', req.query.status)

  const { data, error } = await query.order('created_at', { ascending: false })

  if (error) {
    console.error('[admin/blog] list failed:', error.message)
    return res.status(500).json({ error: 'Failed to load blog posts.' })
  }
  res.json({ posts: data ?? [] })
})

// ── POST /api/admin/blog ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const parsed = parsePostPatch(req.body ?? {}, { requireTitle: true })
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  // Derive the slug from the title when the author has not set one.
  const slug = parsed.patch.slug ?? slugify(parsed.patch.title)
  if (!slug) return res.status(400).json({ error: 'Could not derive a slug from the title — set one explicitly.' })

  const { data, error } = await supabase
    .from('blog_posts')
    .insert({
      ...parsed.patch,
      slug,
      body: parsed.patch.body ?? '',
      author_id: req.user.id,
      last_updated_by: req.user.id,
    })
    .select('*')
    .single()

  if (error) {
    // 23505 = unique_violation on slug.
    if (error.code === '23505') return res.status(409).json({ error: `The slug "${slug}" is already taken.` })
    console.error('[admin/blog] create failed:', error.message)
    return res.status(500).json({ error: 'Failed to create post.' })
  }

  notifyIfPublic(data, null, 'blog create')
  res.status(201).json({ ok: true, post: data })
})

// ── PATCH /api/admin/blog/:postId ────────────────────────────────────────────
router.patch('/:postId', async (req, res) => {
  const parsed = parsePostPatch(req.body ?? {})
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  const { data: previous } = await supabase
    .from('blog_posts')
    .select('id, slug, status')
    .eq('id', req.params.postId)
    .single()

  if (!previous) return res.status(404).json({ error: 'Post not found.' })

  const { data, error } = await supabase
    .from('blog_posts')
    .update({ ...parsed.patch, last_updated_by: req.user.id })
    .eq('id', req.params.postId)
    .select('*')
    .single()

  if (error || !data) {
    if (error?.code === '23505') return res.status(409).json({ error: 'That slug is already taken.' })
    console.error('[admin/blog] update failed:', error?.message)
    return res.status(500).json({ error: 'Failed to save post.' })
  }

  notifyIfPublic(data, previous.status, 'blog edit')
  // A slug change leaves the old URL dead, so it needs a recrawl too.
  if (previous.slug !== data.slug && previous.status === 'published') {
    onContentChanged({ reason: 'blog slug change', paths: [`/blog/${previous.slug}`] })
  }

  res.json({ ok: true, post: data })
})

// ── DELETE /api/admin/blog/:postId ───────────────────────────────────────────
/**
 * Soft-removes by default so a mistaken delete is recoverable and the audit
 * trail survives — the same reasoning as content_status on memes.
 */
router.delete('/:postId', async (req, res) => {
  const hard = req.query.hard === 'true'

  const { data: previous } = await supabase
    .from('blog_posts')
    .select('id, slug, status')
    .eq('id', req.params.postId)
    .single()

  if (!previous) return res.status(404).json({ error: 'Post not found.' })

  const { error } = hard
    ? await supabase.from('blog_posts').delete().eq('id', req.params.postId)
    : await supabase
        .from('blog_posts')
        .update({ status: 'removed', last_updated_by: req.user.id })
        .eq('id', req.params.postId)

  if (error) {
    console.error('[admin/blog] delete failed:', error.message)
    return res.status(500).json({ error: 'Failed to delete post.' })
  }

  notifyIfPublic({ slug: previous.slug, status: 'removed' }, previous.status, 'blog delete')
  res.json({ ok: true, hard })
})

export default router
