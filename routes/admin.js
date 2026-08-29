/**
 * Admin-only routes — all require a valid JWT with role = 'admin'.
 *
 * GET  /api/admin/pending          — list memes awaiting approval
 * POST /api/admin/approve/:memeId  — publish a meme
 * DELETE /api/admin/reject/:memeId — remove a meme (Spaces + Supabase)
 */

import { Router } from 'express'
import { DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../supabaseClient.js'
import { spaces, BUCKET } from '../spacesClient.js'

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
    .select('id, title')
    .single()

  if (error || !data) {
    return res.status(404).json({ error: 'Meme not found or already published.' })
  }
  res.json({ ok: true, meme: data })
})

// ── DELETE /api/admin/reject/:memeId ─────────────────────────────────────────
router.delete('/reject/:memeId', async (req, res) => {
  const { memeId } = req.params

  // Fetch keys before deleting so we can remove from Spaces too
  const { data: meme, error: fetchErr } = await supabase
    .from('memes')
    .select('id, spaces_key, thumbnail_spaces_key')
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

export default router
