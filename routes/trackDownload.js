/**
 * POST /api/track-download       (body: { memeId })
 * POST /api/track-download/:memeId  (URL param — both forms supported)
 *
 * Fire-and-forget download counter.  Responds immediately with 202 and
 * writes to Supabase in the background — never blocks the user's download.
 *
 * SQL for the RPC used here:
 *
 *   create or replace function increment_download_count(meme_id uuid)
 *   returns void as $$
 *     update memes set download_count = download_count + 1 where id = meme_id;
 *   $$ language sql;
 */

import { Router } from 'express'
import { supabase } from '../supabaseClient.js'

const router = Router()

router.post('/:memeId?', (req, res) => {
  // Support both URL param and request body
  const memeId = req.params.memeId ?? req.body?.memeId
  if (!memeId) return res.status(400).json({ error: 'memeId required.' })

  // Respond immediately — the user's download must not wait on this
  res.status(202).json({ success: true })

  // Async write — errors are logged only, never thrown
  ;(async () => {
    try {
      await supabase.rpc('increment_download_count', { meme_id: memeId })

      // Optional analytics row (useful for country-level dashboards)
      const country = req.headers['cf-ipcountry'] ?? null
      await supabase.from('download_events').insert({ meme_id: memeId, country })
    } catch (err) {
      console.error('[track-download]', err.message)
    }
  })()
})

export default router
