/**
 * Collections — organise favorites into named folders.
 *
 * All routes require a signed-in user (router.use(requireAuth)).
 * The service-role Supabase client bypasses RLS, so every query is manually
 * scoped to req.user.id — this is the IDOR boundary.
 *
 * GET    /api/collections                     — list user's collections + counts
 * POST   /api/collections                     — create a new collection
 * PATCH  /api/collections/:id                 — rename or change icon
 * DELETE /api/collections/:id                 — delete collection (items cascade)
 * GET    /api/collections/:id/items           — list memes in a collection
 * POST   /api/collections/:id/items           — add a meme to a collection
 * DELETE /api/collections/:id/items/:memeId   — remove a meme from a collection
 */

import { Router } from 'express'
import { supabase } from '../db/supabaseClient.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const MAX_NAME_LENGTH = 40
const MAX_COLLECTIONS = 50

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate and sanitise a collection name from request body.
 * Returns { ok, name } or { ok: false, error, status }.
 */
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

/**
 * Find or create the default ("Uncategorized") collection for a user.
 * Called before any write that needs a fallback collection.
 */
async function getOrCreateDefault(userId) {
  const { data: existing } = await supabase
    .from('collections')
    .select('id')
    .eq('user_id', userId)
    .eq('is_default', true)
    .limit(1)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('collections')
    .insert({ user_id: userId, name: 'Uncategorized', is_default: true })
    .select('id')
    .single()

  if (error) {
    console.error('[collections] failed to create default collection:', error.message)
    return null
  }
  return created.id
}

/**
 * Assert that a collection belongs to req.user.id.
 * Returns the collection row on success, or sends a 404 and returns null.
 */
async function fetchOwned(res, collectionId, userId, select = 'id, name, emoji, is_default') {
  const { data: col, error } = await supabase
    .from('collections')
    .select(select)
    .eq('id', collectionId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[collections] fetchOwned:', error.message)
    res.status(500).json({ error: 'Could not look up collection.' })
    return null
  }
  if (!col) {
    res.status(404).json({ error: 'Collection not found.' })
    return null
  }
  return col
}

// ── GET /api/collections ──────────────────────────────────────────────────────
// Returns all collections for the caller, each with an item_count field.
router.get('/', async (req, res) => {
  const userId = req.user.id

  // Fetch collections with a count of their items in one round-trip using
  // Supabase's aggregate syntax: select('*, collection_items(count)').
  const { data, error } = await supabase
    .from('collections')
    .select('id, name, emoji, is_default, created_at, updated_at, collection_items(count)')
    .eq('user_id', userId)
    .order('is_default', { ascending: false }) // default collection first
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[collections] GET /', error.message)
    return res.status(500).json({ error: 'Could not load collections.' })
  }

  const collections = (data ?? []).map((col) => ({
    id: col.id,
    name: col.name,
    emoji: col.emoji ?? null,
    isDefault: col.is_default,
    itemCount: col.collection_items?.[0]?.count ?? 0,
    createdAt: col.created_at,
    updatedAt: col.updated_at,
  }))

  res.json({ collections })
})

// ── POST /api/collections ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const userId = req.user.id

  const { ok, name, error: nameError, status: nameStatus } = parseName(req.body)
  if (!ok) return res.status(nameStatus).json({ error: nameError })

  const emoji = typeof req.body.emoji === 'string' ? req.body.emoji.trim() || null : null

  // Enforce the per-user cap
  const { count, error: countErr } = await supabase
    .from('collections')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)

  if (countErr) {
    console.error('[collections] POST count:', countErr.message)
    return res.status(500).json({ error: 'Could not create collection.' })
  }
  if ((count ?? 0) >= MAX_COLLECTIONS) {
    return res.status(422).json({
      error: `You have reached the maximum of ${MAX_COLLECTIONS} collections.`,
    })
  }

  const { data, error } = await supabase
    .from('collections')
    .insert({ user_id: userId, name, emoji })
    .select('id, name, emoji, is_default, created_at, updated_at')
    .single()

  if (error) {
    console.error('[collections] POST insert:', error.message)
    return res.status(500).json({ error: 'Could not create collection.' })
  }

  res.status(201).json({
    collection: {
      id: data.id,
      name: data.name,
      emoji: data.emoji ?? null,
      isDefault: data.is_default,
      itemCount: 0,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    },
  })
})

// ── PATCH /api/collections/:id ────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const col = await fetchOwned(res, id, userId)
  if (!col) return

  const updates = {}

  if (req.body.name !== undefined) {
    const { ok, name, error: nameError, status: nameStatus } = parseName(req.body)
    if (!ok) return res.status(nameStatus).json({ error: nameError })
    updates.name = name
  }

  if (req.body.emoji !== undefined) {
    updates.emoji = typeof req.body.emoji === 'string' ? req.body.emoji.trim() || null : null
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update. Provide name and/or emoji.' })
  }

  const { data, error } = await supabase
    .from('collections')
    .update(updates)
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, name, emoji, is_default, updated_at')
    .single()

  if (error) {
    console.error('[collections] PATCH:', error.message)
    return res.status(500).json({ error: 'Could not update collection.' })
  }

  res.json({
    collection: {
      id: data.id,
      name: data.name,
      emoji: data.emoji ?? null,
      isDefault: data.is_default,
      updatedAt: data.updated_at,
    },
  })
})

// ── DELETE /api/collections/:id ───────────────────────────────────────────────
// Removes the collection and its collection_items rows via DB cascade.
// Never touches the memes table or the favorites table.
router.delete('/:id', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const col = await fetchOwned(res, id, userId)
  if (!col) return

  if (col.is_default) {
    return res.status(403).json({
      error: 'The default Uncategorized collection cannot be deleted.',
    })
  }

  const { error } = await supabase
    .from('collections')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) {
    console.error('[collections] DELETE:', error.message)
    return res.status(500).json({ error: 'Could not delete collection.' })
  }

  res.json({ ok: true })
})

// ── GET /api/collections/:id/items ───────────────────────────────────────────
// Returns the memes inside a collection, joined with their core meme data.
router.get('/:id/items', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const col = await fetchOwned(res, id, userId, 'id')
  if (!col) return

  const { data, error } = await supabase
    .from('collection_items')
    .select(`
      added_at,
      memes (
        id, title, public_url, thumbnail_url, format, category,
        download_count, is_hot, created_at
      )
    `)
    .eq('collection_id', id)
    .eq('user_id', userId)
    .order('added_at', { ascending: false })

  if (error) {
    console.error('[collections] GET items:', error.message)
    return res.status(500).json({ error: 'Could not load collection items.' })
  }

  const items = (data ?? [])
    .filter((row) => row.memes) // guard against orphaned rows
    .map((row) => ({
      addedAt: row.added_at,
      ...row.memes,
    }))

  res.json({ items })
})

// ── POST /api/collections/:id/items ──────────────────────────────────────────
// Adds a meme to a collection. Also upserts into favorites so "All Favorites"
// stays consistent — a meme in any collection is always a favorite.
router.post('/:id/items', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const memeId = req.body?.memeId
  if (!memeId || typeof memeId !== 'string') {
    return res.status(400).json({ error: 'memeId is required.' })
  }

  // Confirm caller owns the target collection
  const col = await fetchOwned(res, id, userId, 'id')
  if (!col) return

  // Confirm meme exists and is published
  const { data: meme, error: memeErr } = await supabase
    .from('memes')
    .select('id')
    .eq('id', memeId)
    .eq('is_published', true)
    .maybeSingle()

  if (memeErr) {
    console.error('[collections] POST items meme check:', memeErr.message)
    return res.status(500).json({ error: 'Could not verify meme.' })
  }
  if (!meme) return res.status(404).json({ error: 'Meme not found.' })

  // Upsert into favorites — ensures "All Favorites" stays consistent
  await supabase
    .from('favorites')
    .upsert({ user_id: userId, meme_id: memeId }, { onConflict: 'user_id,meme_id', ignoreDuplicates: true })

  // Insert into collection_items (idempotent)
  const { error } = await supabase
    .from('collection_items')
    .upsert(
      { collection_id: id, meme_id: memeId, user_id: userId },
      { onConflict: 'collection_id,meme_id', ignoreDuplicates: true },
    )

  if (error) {
    console.error('[collections] POST items insert:', error.message)
    return res.status(500).json({ error: 'Could not add meme to collection.' })
  }

  res.status(201).json({ ok: true })
})

// ── DELETE /api/collections/:id/items/:memeId ────────────────────────────────
// Removes a meme from a collection. Does NOT un-favorite or delete the meme.
router.delete('/:id/items/:memeId', async (req, res) => {
  const userId = req.user.id
  const { id, memeId } = req.params

  const col = await fetchOwned(res, id, userId, 'id')
  if (!col) return

  const { error } = await supabase
    .from('collection_items')
    .delete()
    .eq('collection_id', id)
    .eq('meme_id', memeId)
    .eq('user_id', userId)

  if (error) {
    console.error('[collections] DELETE item:', error.message)
    return res.status(500).json({ error: 'Could not remove meme from collection.' })
  }

  res.json({ ok: true })
})

export default router
