import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../db/supabaseClient.js'

const router = Router()

const COOKIE_NAME = 'videsaur_sid'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2 // 2 years in seconds

/** Read session ID from cookie header, or create + set a new one. */
function getOrCreateSession(req, res) {
  const raw = req.headers.cookie ?? ''
  const match = raw.match(/videsaur_sid=([^;]+)/)
  if (match) return match[1]

  const sid = uuidv4()
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${sid}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`,
  )
  return sid
}

// GET /api/favorites — return all favorited asset IDs for this session
router.get('/', async (req, res) => {
  const sid = getOrCreateSession(req, res)

  const { data, error } = await supabase
    .from('favorites')
    .select('asset_id')
    .eq('session_id', sid)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ids: data.map((r) => r.asset_id) })
})

// POST /api/favorites — add a favorite
router.post('/', async (req, res) => {
  const { asset_id } = req.body
  if (!asset_id) return res.status(400).json({ error: 'asset_id required' })

  const sid = getOrCreateSession(req, res)

  const { error } = await supabase
    .from('favorites')
    .upsert({ session_id: sid, asset_id }, { onConflict: 'session_id,asset_id' })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// DELETE /api/favorites — remove a favorite
router.delete('/', async (req, res) => {
  const { asset_id } = req.body
  if (!asset_id) return res.status(400).json({ error: 'asset_id required' })

  const sid = getOrCreateSession(req, res)

  const { error } = await supabase
    .from('favorites')
    .delete()
    .eq('session_id', sid)
    .eq('asset_id', asset_id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

export default router
