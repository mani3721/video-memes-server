/**
 * POST /api/track-download
 *
 * Fire-and-forget download counter. The frontend calls this after triggering a
 * file download — it never blocks the actual file transfer.
 *
 * Body: { memeId: string }
 */

import { Router } from 'express'
import { supabase } from '../db/supabaseClient.js'

const router = Router()

router.post('/', async (req, res) => {
  const { memeId, country } = req.body ?? {}
  if (!memeId) return res.status(400).json({ error: 'memeId required.' })

  // Respond immediately — don't make the client wait for the DB write
  res.status(202).json({ ok: true })

  try {
    // Increment counter; ignore errors (non-critical path)
    await supabase.rpc('increment_download_count', { meme_id: memeId })

    // Optional audit log row (for analytics dashboards)
    await supabase.from('download_events').insert({
      meme_id: memeId,
      country: country ?? null,
    })
  } catch (err) {
    console.error('[track-download]', err.message)
  }
})

export default router
