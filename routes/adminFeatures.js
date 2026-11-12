/**
 * Admin feature-flag management.
 *
 * GET   /api/admin/features        — list all flags
 * PATCH /api/admin/features/:key   — toggle one flag { enabled: boolean }
 */
import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { Query, listRows, createRow, updateRow } from '../db/appwrite.js'

const VALID_KEYS = new Set(['feed_tab', 'stickers_tab', 'ai_chat_tab'])

const router = Router()
router.use(requireAuth, requireAdmin)

const shape = ({ key, enabled, updated_at }) => ({ key, enabled, updated_at })

router.get('/', async (_req, res) => {
  try {
    const { rows } = await listRows('feature_flags', [Query.orderAsc('key'), Query.limit(100)])
    res.json({ flags: rows.map(shape) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:key', async (req, res) => {
  const { key } = req.params
  const { enabled } = req.body ?? {}

  if (!VALID_KEYS.has(key)) {
    return res.status(400).json({ error: `Unknown feature flag: ${key}` })
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` must be a boolean.' })
  }

  try {
    const data = { key, enabled, updated_at: new Date().toISOString() }
    const { rows } = await listRows('feature_flags', [Query.equal('key', key), Query.limit(1)])
    const flag = rows[0] ? await updateRow('feature_flags', rows[0].id, data) : await createRow('feature_flags', data)
    res.json({ flag: shape(flag) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
