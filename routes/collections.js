/**
 * Collections — organise favorites into named folders (Appwrite).
 *
 * All routes require a signed-in user. The server API key bypasses row
 * permissions, so every query is manually scoped to req.user.id — this is the
 * IDOR boundary.
 *
 * GET    /api/collections                     — list user's collections (+ items)
 * POST   /api/collections                     — create a new collection
 * PATCH  /api/collections/:id                 — rename or change icon
 * DELETE /api/collections/:id                 — delete collection and its items
 * GET    /api/collections/:id/items           — list memes in a collection
 * POST   /api/collections/:id/items           — add a meme to a collection
 * DELETE /api/collections/:id/items/:memeId   — remove a meme from a collection
 */

import { Router } from 'express'
import {
  Query, AppwriteException, getRow, createRow, updateRow, deleteRow, deleteRowsWhere,
  listRows, listAllRows, stableId,
} from '../db/appwrite.js'
import { requireAuth } from '../middleware/auth.js'
import { addFavorite } from './favorites.js'

const router = Router()
router.use(requireAuth)

const MAX_NAME_LENGTH = 40
const MAX_COLLECTIONS = 50

const itemId = (collectionId, memeId) => stableId('ci', collectionId, memeId)

function parseName(body) {
  const raw = body?.name
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'name is required.', status: 400 }
  }
  const name = raw.trim()
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `name must be ${MAX_NAME_LENGTH} characters or fewer.`, status: 400 }
  }
  return { ok: true, name }
}

function parseEmoji(raw) {
  return typeof raw === 'string' ? raw.trim() || null : null
}

const shape = (col, items) => ({
  id: col.id,
  name: col.name,
  emoji: col.emoji ?? null,
  isDefault: Boolean(col.is_default),
  itemCount: items?.length ?? 0,
  items: items ?? [],
  createdAt: col.created_at,
  updatedAt: col.updated_at,
})

/** Returns the collection if owned by userId, otherwise sends 404 and returns null. */
async function fetchOwned(res, collectionId, userId) {
  try {
    const col = await getRow('collections', collectionId)
    if (!col || col.user_id !== userId) {
      res.status(404).json({ error: 'Collection not found.' })
      return null
    }
    return col
  } catch (err) {
    console.error('[collections] fetchOwned:', err.message)
    res.status(500).json({ error: 'Could not look up collection.' })
    return null
  }
}

// ── GET /api/collections ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const userId = req.user.id
  try {
    const [cols, items] = await Promise.all([
      listAllRows('collections', [Query.equal('user_id', userId)]),
      listAllRows('collection_items', [Query.equal('user_id', userId)]),
    ])

    const byCol = new Map()
    for (const it of items) {
      if (!byCol.has(it.collection_id)) byCol.set(it.collection_id, [])
      byCol.get(it.collection_id).push({ meme_id: it.meme_id, added_at: it.added_at })
    }

    cols.sort((a, b) =>
      Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)) ||
      String(a.created_at).localeCompare(String(b.created_at)))

    res.json({ collections: cols.map((c) => shape(c, byCol.get(c.id))) })
  } catch (err) {
    console.error('[collections] GET /', err.message)
    res.status(500).json({ error: 'Could not load collections.' })
  }
})

// ── POST /api/collections ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const userId = req.user.id

  const { ok, name, error: nameError, status: nameStatus } = parseName(req.body)
  if (!ok) return res.status(nameStatus).json({ error: nameError })

  try {
    const { total } = await listRows('collections', [Query.equal('user_id', userId), Query.limit(1)])
    if (total >= MAX_COLLECTIONS) {
      return res.status(422).json({ error: `You have reached the maximum of ${MAX_COLLECTIONS} collections.` })
    }

    const now = new Date().toISOString()
    const col = await createRow('collections', {
      user_id: userId,
      name,
      emoji: parseEmoji(req.body.emoji),
      is_default: false,
      created_at: now,
      updated_at: now,
    })
    res.status(201).json({ collection: shape(col, []) })
  } catch (err) {
    console.error('[collections] POST:', err.message)
    res.status(500).json({ error: 'Could not create collection.' })
  }
})

// ── PATCH /api/collections/:id ────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const col = await fetchOwned(res, id, userId)
  if (!col) return

  const updates = {}
  if (req.body?.name !== undefined) {
    const { ok, name, error: nameError, status: nameStatus } = parseName(req.body)
    if (!ok) return res.status(nameStatus).json({ error: nameError })
    updates.name = name
  }
  if (req.body?.emoji !== undefined) updates.emoji = parseEmoji(req.body.emoji)

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update. Provide name and/or emoji.' })
  }

  try {
    const data = await updateRow('collections', id, { ...updates, updated_at: new Date().toISOString() })
    res.json({ collection: shape(data) })
  } catch (err) {
    console.error('[collections] PATCH:', err.message)
    res.status(500).json({ error: 'Could not update collection.' })
  }
})

// ── DELETE /api/collections/:id ───────────────────────────────────────────────
// Removes the collection and its items. Never touches memes or favorites.
router.delete('/:id', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const col = await fetchOwned(res, id, userId)
  if (!col) return

  if (col.is_default) {
    return res.status(403).json({ error: 'The default Uncategorized collection cannot be deleted.' })
  }

  try {
    await deleteRowsWhere('collection_items', [Query.equal('collection_id', id), Query.equal('user_id', userId)])
    await deleteRow('collections', id)
    res.json({ ok: true })
  } catch (err) {
    console.error('[collections] DELETE:', err.message)
    res.status(500).json({ error: 'Could not delete collection.' })
  }
})

// ── GET /api/collections/:id/items ───────────────────────────────────────────
router.get('/:id/items', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const col = await fetchOwned(res, id, userId)
  if (!col) return

  try {
    const rows = await listAllRows('collection_items', [
      Query.equal('collection_id', id),
      Query.equal('user_id', userId),
      Query.orderDesc('added_at'),
    ])

    const memeIds = [...new Set(rows.map((r) => r.meme_id))]
    const memes = new Map()
    for (let i = 0; i < memeIds.length; i += 100) {
      const { rows: page } = await listRows('memes', [
        Query.equal('$id', memeIds.slice(i, i + 100)),
        Query.select(['$id', 'title', 'public_url', 'thumbnail_url', 'format', 'category', 'download_count', 'is_hot', 'created_at']),
        Query.limit(100),
      ])
      for (const m of page) memes.set(m.id, m)
    }

    const items = rows
      .filter((r) => memes.has(r.meme_id)) // guard against orphaned rows
      .map((r) => ({ addedAt: r.added_at, ...memes.get(r.meme_id) }))

    res.json({ items })
  } catch (err) {
    console.error('[collections] GET items:', err.message)
    res.status(500).json({ error: 'Could not load collection items.' })
  }
})

// ── POST /api/collections/:id/items ──────────────────────────────────────────
// Adds a meme to a collection; also favorites it so "All Favorites" stays consistent.
router.post('/:id/items', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const memeId = req.body?.memeId
  if (!memeId || typeof memeId !== 'string') {
    return res.status(400).json({ error: 'memeId is required.' })
  }

  const col = await fetchOwned(res, id, userId)
  if (!col) return

  try {
    const meme = await getRow('memes', memeId)
    if (!meme || !meme.is_published) return res.status(404).json({ error: 'Meme not found.' })

    await addFavorite(userId, memeId)

    try {
      await createRow(
        'collection_items',
        { collection_id: id, meme_id: memeId, user_id: userId, added_at: new Date().toISOString() },
        itemId(id, memeId),
      )
    } catch (err) {
      if (!(err instanceof AppwriteException && err.code === 409)) throw err
    }

    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('[collections] POST items:', err.message)
    res.status(500).json({ error: 'Could not add meme to collection.' })
  }
})

// ── DELETE /api/collections/:id/items/:memeId ────────────────────────────────
// Removes a meme from a collection. Does NOT un-favorite or delete the meme.
router.delete('/:id/items/:memeId', async (req, res) => {
  const userId = req.user.id
  const { id, memeId } = req.params

  const col = await fetchOwned(res, id, userId)
  if (!col) return

  try {
    const removed = await deleteRow('collection_items', itemId(id, memeId))
    // Rows created before the stable-ID scheme: fall back to a query delete.
    if (!removed) {
      await deleteRowsWhere('collection_items', [
        Query.equal('collection_id', id),
        Query.equal('meme_id', memeId),
        Query.equal('user_id', userId),
      ])
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[collections] DELETE item:', err.message)
    res.status(500).json({ error: 'Could not remove meme from collection.' })
  }
})

export default router
