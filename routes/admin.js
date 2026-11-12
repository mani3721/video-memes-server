/**
 * Admin-only routes — all require a valid Appwrite JWT with role = 'admin'.
 *
 * GET  /api/admin/pending          — list memes awaiting approval
 * POST /api/admin/approve/:memeId  — publish a meme
 * DELETE /api/admin/reject/:memeId — remove a meme (Spaces + Appwrite)
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
import { Query, getRow, updateRow, deleteRow, listAllRows } from '../db/appwrite.js'
import { notifyNewContent } from '../lib/notifyNewContent.js'
import { spaces, BUCKET } from '../spacesClient.js'
import { onContentChanged, FEED_PATHS, feedPathForCategory } from '../lib/sitemap/notify.js'
import { stats as sitemapStats } from '../lib/sitemap/cache.js'
import { indexNowStatus } from '../lib/sitemap/indexnow.js'
import { featureAvailability } from '../lib/sitemap/query.js'

const router = Router()

// Apply auth + admin check to every route in this file
router.use(requireAuth, requireAdmin)

const pick = (m) => m && { id: m.id, title: m.title, category: m.category }

// ── GET /api/admin/pending ────────────────────────────────────────────────────
router.get('/pending', async (_req, res) => {
  try {
    const memes = await listAllRows('memes', [
      Query.equal('is_published', false),
      Query.orderDesc('created_at'),
      Query.select(['$id', 'title', 'category', 'thumbnail_url', 'public_url', 'created_at', 'uploader_id', 'format', 'file_size_bytes']),
    ], { cap: 1000 })
    res.json({ memes })
  } catch (err) {
    console.error('[admin/pending]', err.message)
    res.status(500).json({ error: 'Failed to fetch pending memes.' })
  }
})

// ── POST /api/admin/approve/:memeId ──────────────────────────────────────────
router.post('/approve/:memeId', async (req, res) => {
  const { memeId } = req.params

  // safety: only approve actually-pending memes
  const existing = await getRow('memes', memeId).catch(() => null)
  if (!existing || existing.is_published) {
    return res.status(404).json({ error: 'Meme not found or already published.' })
  }
  const data = pick(await updateRow('memes', memeId, { is_published: true }).catch(() => null))
  if (!data) return res.status(404).json({ error: 'Meme not found or already published.' })

  onContentChanged({
    reason: 'approve',
    memes: [data],
    paths: [...FEED_PATHS, feedPathForCategory(data.category)].filter(Boolean),
  })

  // Fire-and-forget fan-out; idempotent per (user, meme).
  notifyNewContent(memeId).catch((notifyErr) =>
    console.error('[admin/approve] notify_new_content:', notifyErr.message))

  res.json({ ok: true, meme: data })
})

// ── DELETE /api/admin/reject/:memeId ─────────────────────────────────────────
router.delete('/reject/:memeId', async (req, res) => {
  const { memeId } = req.params

  // Fetch keys before deleting so we can remove from Spaces too
  const meme = await getRow('memes', memeId).catch(() => null)
  if (!meme) return res.status(404).json({ error: 'Meme not found.' })

  try {
    await deleteRow('memes', memeId)
  } catch (delErr) {
    console.error('[admin/reject] Appwrite delete error:', delErr.message)
    return res.status(500).json({ error: 'Failed to delete meme record.' })
  }

  onContentChanged({
    reason: 'reject',
    memes: [pick(meme)],
    paths: [...FEED_PATHS, feedPathForCategory(meme.category)].filter(Boolean),
  })

  const keys = [meme.spaces_key, meme.thumbnail_spaces_key].filter(Boolean)
  if (keys.length) {
    spaces
      .send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }))
      .catch((err) => console.error('[admin/reject] Spaces delete error:', err.message))
  }

  res.json({ ok: true })
})

// ── PATCH /api/admin/rename/:memeId ──────────────────────────────────────────
router.patch('/rename/:memeId', async (req, res) => {
  const { memeId } = req.params
  const title = (req.body?.title ?? '').trim()

  if (!title) return res.status(400).json({ error: 'title is required.' })
  if (title.length > 200) return res.status(400).json({ error: 'title must be 200 chars or fewer.' })

  // The title is part of the canonical slug; keep the old row to resubmit its URL.
  const previous = pick(await getRow('memes', memeId).catch(() => null))
  if (!previous) return res.status(404).json({ error: 'Meme not found.' })

  let data
  try {
    data = pick(await updateRow('memes', memeId, { title }))
  } catch (err) {
    console.error('[admin/rename]', err.message)
  }
  if (!data) return res.status(404).json({ error: 'Meme not found.' })

  onContentChanged({
    reason: 'rename',
    memes: previous.title !== data.title ? [data, previous] : [data],
    paths: [...FEED_PATHS, feedPathForCategory(data.category)].filter(Boolean),
  })

  res.json({ ok: true, meme: data })
})

// ── GET /api/admin/sitemap/status ────────────────────────────────────────────
router.get('/sitemap/status', async (_req, res) => {
  res.json({
    cache: sitemapStats(),
    indexNow: indexNowStatus(),
    migrations: await featureAvailability(),
  })
})

// ── POST /api/admin/sitemap/refresh ──────────────────────────────────────────
router.post('/sitemap/refresh', (_req, res) => {
  const cleared = onContentChanged({ reason: 'manual refresh' })
  res.json({ ok: true, cleared: cleared ?? null, cache: sitemapStats() })
})

export default router
