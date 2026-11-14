/**
 * Public read-only feature flags.
 * GET /api/features  — no auth required; returns public feature flags.
 */
import { Router } from 'express'
import { listRows, Query } from '../db/d1.js'

const router = Router()

router.get('/', async (_req, res) => {
  let data
  try {
    ;({ rows: data } = await listRows('feature_flags', [Query.select(['$id', 'key', 'enabled']), Query.limit(100)]))
  } catch (err) {
    console.error('[features]', err.message)
    return res.status(500).json({ error: 'Could not load features.' })
  }

  const flags = Object.fromEntries(data.map(({ key, enabled }) => [key, enabled]))

  // Ensure defaults are present even if DB rows are missing.
  const result = {
    feed_tab:     flags.feed_tab     ?? true,
    stickers_tab: flags.stickers_tab ?? true,
    ai_chat_tab:  flags.ai_chat_tab  ?? true,
  }

  res.json(result)
})

export default router
