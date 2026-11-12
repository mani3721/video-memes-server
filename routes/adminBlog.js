/**
 * Blog management — mounted at /api/admin/blog (Appwrite `blog_posts`).
 *
 * GET    /         — every post, any status
 * POST   /         — create
 * PATCH  /:postId  — edit
 * DELETE /:postId  — soft-remove (status = 'removed'); ?hard=true to really delete
 *
 * Public reads go through routes/blog.js, which only returns published posts.
 */

import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { Query, getRow, createRow, updateRow, deleteRow, listRows, listAllRows } from '../db/appwrite.js'
import { onContentChanged } from '../lib/sitemap/notify.js'

const router = Router()
router.use(requireAuth, requireAdmin)

const STATUSES = ['draft', 'published', 'removed']

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

/** Replaces the old UNIQUE(slug) constraint. */
async function slugTaken(slug, exceptId) {
  const { rows } = await listRows('blog_posts', [Query.equal('slug', slug), Query.limit(2)])
  return rows.some((r) => r.id !== exceptId)
}

/** Mirrors the old published_at trigger: stamp it the first time a post goes live. */
function withPublishedAt(patch, previous) {
  if (patch.status === 'published' && !previous?.published_at) {
    return { ...patch, published_at: new Date().toISOString() }
  }
  return patch
}

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
  try {
    const queries = [Query.orderDesc('created_at')]
    if (STATUSES.includes(req.query.status)) queries.push(Query.equal('status', req.query.status))
    const posts = await listAllRows('blog_posts', queries, { cap: 2000 })
    res.json({ posts })
  } catch (err) {
    console.error('[admin/blog] list failed:', err.message)
    res.status(500).json({ error: 'Failed to load blog posts.' })
  }
})

// ── POST /api/admin/blog ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const parsed = parsePostPatch(req.body ?? {}, { requireTitle: true })
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  const slug = parsed.patch.slug ?? slugify(parsed.patch.title)
  if (!slug) return res.status(400).json({ error: 'Could not derive a slug from the title — set one explicitly.' })

  try {
    if (await slugTaken(slug)) return res.status(409).json({ error: `The slug "${slug}" is already taken.` })

    const now = new Date().toISOString()
    const data = await createRow('blog_posts', {
      status: 'draft',
      ...withPublishedAt(parsed.patch, null),
      slug,
      body: parsed.patch.body ?? '',
      author_id: req.user.id,
      last_updated_by: req.user.id,
      created_at: now,
      updated_at: now,
    })

    notifyIfPublic(data, null, 'blog create')
    res.status(201).json({ ok: true, post: data })
  } catch (err) {
    console.error('[admin/blog] create failed:', err.message)
    res.status(500).json({ error: 'Failed to create post.' })
  }
})

// ── PATCH /api/admin/blog/:postId ────────────────────────────────────────────
router.patch('/:postId', async (req, res) => {
  const parsed = parsePostPatch(req.body ?? {})
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  try {
    const previous = await getRow('blog_posts', req.params.postId)
    if (!previous) return res.status(404).json({ error: 'Post not found.' })

    if (parsed.patch.slug && parsed.patch.slug !== previous.slug && await slugTaken(parsed.patch.slug, previous.id)) {
      return res.status(409).json({ error: 'That slug is already taken.' })
    }

    const data = await updateRow('blog_posts', req.params.postId, {
      ...withPublishedAt(parsed.patch, previous),
      last_updated_by: req.user.id,
      updated_at: new Date().toISOString(),
    })

    notifyIfPublic(data, previous.status, 'blog edit')
    if (previous.slug !== data.slug && previous.status === 'published') {
      onContentChanged({ reason: 'blog slug change', paths: [`/blog/${previous.slug}`] })
    }

    res.json({ ok: true, post: data })
  } catch (err) {
    console.error('[admin/blog] update failed:', err.message)
    res.status(500).json({ error: 'Failed to save post.' })
  }
})

// ── DELETE /api/admin/blog/:postId ───────────────────────────────────────────
router.delete('/:postId', async (req, res) => {
  const hard = req.query.hard === 'true'

  try {
    const previous = await getRow('blog_posts', req.params.postId)
    if (!previous) return res.status(404).json({ error: 'Post not found.' })

    if (hard) {
      await deleteRow('blog_posts', req.params.postId)
    } else {
      await updateRow('blog_posts', req.params.postId, {
        status: 'removed',
        last_updated_by: req.user.id,
        updated_at: new Date().toISOString(),
      })
    }

    notifyIfPublic({ slug: previous.slug, status: 'removed' }, previous.status, 'blog delete')
    res.json({ ok: true, hard })
  } catch (err) {
    console.error('[admin/blog] delete failed:', err.message)
    res.status(500).json({ error: 'Failed to delete post.' })
  }
})

export default router
