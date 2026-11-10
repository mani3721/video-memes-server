/**
 * POST /api/track-download       (body: { memeId })
 * POST /api/track-download/:memeId  (URL param — both forms supported)
 *
 * Fire-and-forget download counter. Responds immediately with 202 and writes
 * to Appwrite in the background — never blocks the user's download.
 */

import { Router } from 'express'
import { createRow, incrementColumn, AppwriteException } from '../db/appwrite.js'

const router = Router()

/** Same thresholds as the old notify_download_milestone SQL function. */
const MILESTONES = [100, 500, 1000, 5000, 10000, 50000, 100000]

/**
 * Notify the uploader once per threshold. The notification row ID is derived
 * from (meme, threshold), so a second attempt hits a 409 instead of creating a
 * duplicate — the same guarantee the SQL ON CONFLICT DO NOTHING gave.
 */
async function notifyMilestone(meme) {
  if (!meme?.uploader_id) return
  // Only fire on the exact download that crosses a threshold.
  const threshold = MILESTONES.find((t) => meme.download_count === t)
  if (!threshold) return

  try {
    await createRow(
      'notifications',
      {
        user_id: meme.uploader_id,
        type: 'milestone',
        title: `Your upload reached ${threshold} downloads!`,
        message: meme.title ?? null,
        link: `${meme.category === 'sounds' ? '/sound/' : '/meme/'}${meme.id}`,
        thumbnail: meme.thumbnail_url ?? null,
        dedupe_key: `milestone:${meme.id}:${threshold}`,
        created_at: new Date().toISOString(),
      },
      `ms${threshold}-${meme.id}`.slice(0, 36),
    )
  } catch (err) {
    if (!(err instanceof AppwriteException && err.code === 409)) throw err
  }
}

router.post('/:memeId?', (req, res) => {
  const memeId = req.params.memeId ?? req.body?.memeId
  if (!memeId || typeof memeId !== 'string') return res.status(400).json({ error: 'memeId required.' })

  res.status(202).json({ success: true })

  ;(async () => {
    try {
      const meme = await incrementColumn('memes', memeId, 'download_count')

      const country = req.headers['cf-ipcountry'] ?? req.headers['x-vercel-ip-country'] ?? null
      await createRow('download_events', {
        meme_id: memeId,
        country: country ? String(country).slice(0, 8) : null,
        created_at: new Date().toISOString(),
      })

      await notifyMilestone(meme)
    } catch (err) {
      if (err instanceof AppwriteException && err.code === 404) return // unknown meme
      console.error('[track-download]', err.message)
    }
  })()
})

export default router
