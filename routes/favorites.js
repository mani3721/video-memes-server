/**
 * Favorites for signed-in users (Appwrite `favorites` table).
 * Guests keep favorites in localStorage on the client.
 *
 * GET    /api/favorites            — { ids: string[] }
 * POST   /api/favorites            — { memeId }          add one
 * POST   /api/favorites/merge      — { memeIds: [] }     add many (guest → account)
 * DELETE /api/favorites/:memeId    — remove one
 */

import { Router } from 'express'
import { Query, AppwriteException, createRow, deleteRow, listAllRows, stableId } from '../db/appwrite.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

export const favoriteId = (userId, memeId) => stableId('fav', userId, memeId)

/** Insert-if-absent; 409 means it already exists. */
export async function addFavorite(userId, memeId) {
  try {
    await createRow(
      'favorites',
      { user_id: userId, meme_id: memeId, created_at: new Date().toISOString() },
      favoriteId(userId, memeId),
    )
  } catch (err) {
    if (!(err instanceof AppwriteException && err.code === 409)) throw err
  }
}

router.get('/', async (req, res) => {
  try {
    const rows = await listAllRows('favorites', [Query.equal('user_id', req.user.id), Query.orderDesc('created_at')])
    res.json({ ids: rows.map((r) => r.meme_id) })
  } catch (err) {
    console.error('[favorites] list', err.message)
    res.status(500).json({ error: 'Could not load favorites.' })
  }
})

router.post('/merge', async (req, res) => {
  const ids = Array.isArray(req.body?.memeIds)
    ? [...new Set(req.body.memeIds.filter((id) => typeof id === 'string' && id))].slice(0, 500)
    : []
  try {
    await Promise.all(ids.map((id) => addFavorite(req.user.id, id)))
    res.json({ ok: true, merged: ids.length })
  } catch (err) {
    console.error('[favorites] merge', err.message)
    res.status(500).json({ error: 'Could not merge favorites.' })
  }
})

router.post('/', async (req, res) => {
  const memeId = req.body?.memeId
  if (!memeId || typeof memeId !== 'string') return res.status(400).json({ error: 'memeId required.' })
  try {
    await addFavorite(req.user.id, memeId)
    res.json({ ok: true })
  } catch (err) {
    console.error('[favorites] add', err.message)
    res.status(500).json({ error: 'Could not add favorite.' })
  }
})

router.delete('/:memeId', async (req, res) => {
  try {
    await deleteRow('favorites', favoriteId(req.user.id, req.params.memeId))
    res.json({ ok: true })
  } catch (err) {
    console.error('[favorites] delete', err.message)
    res.status(500).json({ error: 'Could not remove favorite.' })
  }
})

export default router
