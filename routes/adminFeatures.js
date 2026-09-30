/**
 * Admin feature-flag management.
 *
 * GET   /api/admin/features        — list all flags
 * PATCH /api/admin/features/:key   — toggle one flag { enabled: boolean }
 */
import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../supabaseClient.js'

const VALID_KEYS = new Set(['feed_tab', 'stickers_tab', 'amazon_affiliate', 'ai_chat_tab'])

const router = Router()
router.use(requireAuth, requireAdmin)

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('feature_flags')
    .select('key, enabled, updated_at')
    .order('key')

  if (error) return res.status(500).json({ error: error.message })
  res.json({ flags: data ?? [] })
})

router.patch('/:key', async (req, res) => {
  const { key } = req.params
  const { enabled } = req.body

  if (!VALID_KEYS.has(key)) {
    return res.status(400).json({ error: `Unknown feature flag: ${key}` })
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` must be a boolean.' })
  }

  const { data, error } = await supabase
    .from('feature_flags')
    .upsert({ key, enabled, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key, enabled, updated_at')
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ flag: data })
})

export default router
