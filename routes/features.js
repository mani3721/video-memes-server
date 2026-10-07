/**
 * Public read-only feature flags.
 * GET /api/features  — no auth required; returns public feature flags.
 */
import { Router } from 'express'
import { supabase } from '../supabaseClient.js'

const router = Router()

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('feature_flags')
    .select('key, enabled')

  if (error) return res.status(500).json({ error: error.message })

  const flags = Object.fromEntries((data ?? []).map(({ key, enabled }) => [key, enabled]))

  // Ensure defaults are present even if DB rows are missing.
  const result = {
    feed_tab:     flags.feed_tab     ?? true,
    stickers_tab: flags.stickers_tab ?? true,
    ai_chat_tab:  flags.ai_chat_tab  ?? true,
  }

  res.json(result)
})

export default router
