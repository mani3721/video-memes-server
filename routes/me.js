/**
 * Per-user data for the signed-in caller.
 *
 * GET  /api/me                   — { user, profile } (profile is created on first call)
 * PUT  /api/me/consent           — { status: 'granted' | 'denied' }
 * GET  /api/me/download-history  — { history: [] }
 */

import { Router } from 'express'
import { Query, getRow, createRow, upsertRow, listRows, DbError } from '../db/d1.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const CONSENT_VERSION = 'v1'

router.get('/', async (req, res) => {
  try {
    let profile = await getRow('profiles', req.user.id)
    if (!profile) {
      try {
        profile = await createRow(
          'profiles',
          {
            email: req.user.email ?? null,
            display_name: req.user.name || null,
            role: 'user',
            created_at: new Date().toISOString(),
          },
          req.user.id,
        )
      } catch (err) {
        if (!(err instanceof DbError && err.code === 409)) throw err
        profile = await getRow('profiles', req.user.id)
      }
    }
    res.json({
      user: req.user,
      profile: profile && { role: profile.role, display_name: profile.display_name, email: profile.email },
    })
  } catch (err) {
    console.error('[me]', err.message)
    res.status(500).json({ error: 'Could not load profile.' })
  }
})

router.put('/consent', async (req, res) => {
  const status = req.body?.status
  if (!['granted', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'status must be granted or denied.' })
  }
  try {
    // One row per user, keyed by user ID.
    await upsertRow('user_consent', req.user.id, {
      user_id: req.user.id,
      consent_status: status,
      consent_version: CONSENT_VERSION,
      updated_at: new Date().toISOString(),
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('[me/consent]', err.message)
    res.status(500).json({ error: 'Could not save consent.' })
  }
})

router.get('/download-history', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50))
  try {
    const { rows } = await listRows('download_history', [Query.equal('user_id', req.user.id), Query.limit(limit)])
    res.json({ history: rows })
  } catch {
    // The download_history table has no columns yet — degrade to empty.
    res.json({ history: [] })
  }
})

export default router
