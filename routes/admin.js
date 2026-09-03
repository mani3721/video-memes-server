/**
 * Admin-only routes — all require a valid JWT with role = 'admin'.
 *
 * GET  /api/admin/pending          — list memes awaiting approval
 * POST /api/admin/approve/:memeId  — publish a meme
 * DELETE /api/admin/reject/:memeId — remove a meme (Spaces + Supabase)
 * PATCH /api/admin/rename/:memeId  — retitle a meme
 * GET  /api/admin/sitemap/status   — sitemap cache state
 * POST /api/admin/sitemap/refresh  — purge the sitemap cache by hand
 *
 * Every route that changes published content calls onContentChanged() so the
 * sitemap reflects the change on the next request instead of at TTL expiry.
 */

import { Router } from 'express'
import { DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../supabaseClient.js'
import { spaces, BUCKET } from '../spacesClient.js'
import { onContentChanged, FEED_PATHS, feedPathForCategory } from '../lib/sitemap/notify.js'
import { stats as sitemapStats } from '../lib/sitemap/cache.js'
import { indexNowStatus } from '../lib/sitemap/indexnow.js'
import { featureAvailability } from '../lib/sitemap/query.js'

const router = Router()

// Apply auth + admin check to every route in this file
router.use(requireAuth, requireAdmin)

// ── GET /api/admin/pending ────────────────────────────────────────────────────
router.get('/pending', async (req, res) => {
  const { data, error } = await supabase
    .from('memes')
    .select('id, title, category, thumbnail_url, public_url, created_at, uploader_id, format, file_size_bytes')
    .eq('is_published', false)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[admin/pending]', error.message)
    return res.status(500).json({ error: 'Failed to fetch pending memes.' })
  }
  res.json({ memes: data ?? [] })
})

// ── POST /api/admin/approve/:memeId ──────────────────────────────────────────
router.post('/approve/:memeId', async (req, res) => {
  const { memeId } = req.params

  const { data, error } = await supabase
    .from('memes')
    .update({ is_published: true })
    .eq('id', memeId)
    .eq('is_published', false) // safety: only approve actually-pending memes
    .select('id, title, category')
    .single()

  if (error || !data) {
    return res.status(404).json({ error: 'Meme not found or already published.' })
  }

  // Publishing is what makes the page indexable, so this is the moment the URL
  // must enter the sitemap.
  onContentChanged({
    reason: 'approve',
    memes: [data],
    paths: [...FEED_PATHS, feedPathForCategory(data.category)].filter(Boolean),
  })

  res.json({ ok: true, meme: data })
})

// ── DELETE /api/admin/reject/:memeId ─────────────────────────────────────────
router.delete('/reject/:memeId', async (req, res) => {
  const { memeId } = req.params

  // Fetch keys before deleting so we can remove from Spaces too
  const { data: meme, error: fetchErr } = await supabase
    .from('memes')
    .select('id, title, category, spaces_key, thumbnail_spaces_key')
    .eq('id', memeId)
    .single()

  if (fetchErr || !meme) {
    return res.status(404).json({ error: 'Meme not found.' })
  }

  // Delete from Supabase first
  const { error: delErr } = await supabase
    .from('memes')
    .delete()
    .eq('id', memeId)

  if (delErr) {
    console.error('[admin/reject] Supabase delete error:', delErr.message)
    return res.status(500).json({ error: 'Failed to delete meme record.' })
  }

  // Drop the URL from the sitemap immediately — leaving a deleted page listed
  // earns crawl budget spent on 404s and "submitted URL not found" errors in
  // Search Console. The IndexNow submission is what prompts a recrawl that
  // sees the 404 and deindexes the page.
  onContentChanged({
    reason: 'reject',
    memes: [meme],
    paths: [...FEED_PATHS, feedPathForCategory(meme.category)].filter(Boolean),
  })

  // Delete files from Spaces (fire-and-forget — don't block response on this)
  const keys = [meme.spaces_key, meme.thumbnail_spaces_key].filter(Boolean)
  if (keys.length) {
    spaces
      .send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      )
      .catch((err) => console.error('[admin/reject] Spaces delete error:', err.message))
  }

  res.json({ ok: true })
})

// ── PATCH /api/admin/rename/:memeId ──────────────────────────────────────────
router.patch('/rename/:memeId', async (req, res) => {
  const { memeId } = req.params
  const title = (req.body.title ?? '').trim()

  if (!title) return res.status(400).json({ error: 'title is required.' })
  if (title.length > 200) return res.status(400).json({ error: 'title must be 200 chars or fewer.' })

  // The title is part of the canonical slug, so a rename moves the page's URL.
  // Read the old row first to keep a reference to the outgoing URL.
  const { data: previous } = await supabase
    .from('memes')
    .select('id, title, category')
    .eq('id', memeId)
    .single()

  const { data, error } = await supabase
    .from('memes')
    .update({ title })
    .eq('id', memeId)
    .select('id, title, category')
    .single()

  if (error || !data) {
    console.error('[admin/rename]', error?.message)
    return res.status(404).json({ error: 'Meme not found.' })
  }

  // Submit both URLs. MemePage resolves a row from the trailing UUID, so the
  // old slug still renders — but it now advertises the new slug as canonical,
  // and a recrawl is what tells the engine to follow that.
  onContentChanged({
    reason: 'rename',
    memes: previous && previous.title !== data.title ? [data, previous] : [data],
    paths: [...FEED_PATHS, feedPathForCategory(data.category)].filter(Boolean),
  })

  res.json({ ok: true, meme: data })
})

// ── GET /api/admin/sitemap/status ────────────────────────────────────────────
router.get('/sitemap/status', async (_req, res) => {
  // `migrations` reports which optional DB features the generator detected, so
  // an unapplied migration is visible here rather than only in the server log.
  res.json({
    cache: sitemapStats(),
    indexNow: indexNowStatus(),
    migrations: await featureAvailability(),
  })
})

// ── POST /api/admin/sitemap/refresh ──────────────────────────────────────────
/**
 * Manual purge. Regeneration is automatic on publish/update/delete, so this is
 * an operational escape hatch — useful after editing STATIC_PAGES, or after a
 * direct database change that bypassed these routes.
 */
router.post('/sitemap/refresh', (_req, res) => {
  const cleared = onContentChanged({ reason: 'manual refresh' })
  res.json({ ok: true, cleared: cleared ?? null, cache: sitemapStats() })
})

export default router
