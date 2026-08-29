/**
 * POST /api/bulk-download
 *   Body: { memeIds: string[] }  — Supabase meme UUIDs
 *
 * Resolves memeIds → spaces_key via Supabase, then streams a ZIP archive
 * directly to the client using archiver.  The response is streamed — no
 * temp file is written to disk and no polling is required.
 *
 * NOTE: For high-traffic scale, move this to a queued background job
 * (BullMQ + Redis) so large zips don't tie up a request worker.
 * At moderate traffic (<100 concurrent zips), synchronous streaming is fine.
 */

import { Readable } from 'node:stream'
import { Router } from 'express'
import archiver from 'archiver'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { spaces, BUCKET } from '../spacesClient.js'
import { supabase } from '../supabaseClient.js'

const router = Router()
const MAX_ITEMS = 50

router.post('/', async (req, res) => {
  const { memeIds } = req.body ?? {}

  if (!Array.isArray(memeIds) || memeIds.length === 0) {
    return res.status(400).json({ error: 'memeIds must be a non-empty array of UUIDs.' })
  }
  if (memeIds.length > MAX_ITEMS) {
    return res.status(400).json({ error: `Maximum ${MAX_ITEMS} files per zip request.` })
  }
  if (memeIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return res.status(400).json({ error: 'Each memeId must be a non-empty string.' })
  }

  // 1 — Resolve meme IDs → Spaces keys via Supabase (service role bypasses RLS)
  const { data: memes, error: dbErr } = await supabase
    .from('memes')
    .select('id, spaces_key, filename, title')
    .in('id', memeIds)
    .eq('is_published', true)

  if (dbErr) {
    console.error('[bulk-download] Supabase error:', dbErr.message)
    return res.status(500).json({ error: 'Failed to look up files. Please try again.' })
  }
  if (!memes?.length) {
    return res.status(404).json({ error: 'None of the requested memes were found.' })
  }

  // 2 — Set response headers for streaming ZIP download
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename="videsaur-pack.zip"')
  res.setHeader('Transfer-Encoding', 'chunked')

  // 3 — Create archiver and pipe to response
  const archive = archiver('zip', { zlib: { level: 6 } })

  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.error('[bulk-download] archiver warning:', err.message)
  })
  archive.on('error', (err) => {
    console.error('[bulk-download] archiver error:', err.message)
    // If headers already sent, we can only destroy the stream
    if (!res.headersSent) res.status(500).json({ error: 'ZIP generation failed.' })
    else res.destroy(err)
  })

  archive.pipe(res)

  // 4 — Append each file from Spaces sequentially
  for (const meme of memes) {
    try {
      const { Body } = await spaces.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: meme.spaces_key }),
      )
      // AWS SDK v3 returns a Web ReadableStream on Node 18+; convert to Node Readable
      const nodeStream = Readable.fromWeb(Body)
      archive.append(nodeStream, { name: meme.filename ?? meme.spaces_key.split('/').pop() })
    } catch (err) {
      console.error(`[bulk-download] Failed to fetch ${meme.spaces_key}:`, err.message)
      // Skip missing files rather than aborting the whole archive
    }
  }

  // 5 — Finalise — triggers the 'finish' event and closes the response
  archive.finalize()
})

export default router
