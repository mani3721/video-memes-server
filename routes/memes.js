/**
 * Public meme reads, backed by Appwrite.
 *
 * The browser used to query Supabase directly with the anon key. The Appwrite
 * memes table has no public read permission (turning one on would also expose
 * unpublished rows, since row-level permissions are off), so public reads go
 * through this server instead and `is_published = true` is enforced here.
 *
 *   GET  /api/memes                 list (sort, filters, pagination)
 *   GET  /api/memes/count           number of published memes
 *   GET  /api/memes/by-ids?ids=a,b  batch lookup (favorites, collections)
 *   GET  /api/memes/:id             single published meme
 *   GET  /api/memes/:id/similar     same category, mood-overlap first
 *   POST /api/memes/:id/view        fire-and-forget view counter
 */

import { Router } from 'express'
import { listRows, getRow, incrementColumn, Query } from '../db/d1.js'

const router = Router()

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100
const MAX_IDS = 100
const SORTS = new Set(['hot', 'popular', 'recent', 'downloads'])

const csv = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const clampInt = (v, def, min, max) => Math.min(max, Math.max(min, Number.parseInt(v, 10) || def))

/** Filters shared by every list query; `is_published` is always enforced. */
function filterQueries({ category, excludeCategory, mood, q, since }) {
  const out = [Query.equal('is_published', true)]
  if (category) out.push(Query.equal('category', category))
  for (const c of csv(excludeCategory)) out.push(Query.notEqual('category', c))
  if (mood) out.push(Query.contains('mood_tags', [mood]))
  if (q?.trim()) out.push(Query.contains('title', q.trim()))
  if (since && !Number.isNaN(Date.parse(since))) {
    out.push(Query.greaterThanEqual('created_at', new Date(since).toISOString()))
  }
  return out
}

function sortQueries(sort) {
  if (sort === 'recent') return [Query.orderDesc('created_at')]
  if (sort === 'downloads') return [Query.orderDesc('download_count')]
  // 'hot' and 'popular' both match the old Supabase order: hot first, then downloads.
  return [Query.orderDesc('is_hot'), Query.orderDesc('download_count')]
}

function sendError(res, label, err) {
  console.error(`[memes${label}]`, err.message)
  res.status(500).json({ error: 'Could not load memes.' })
}

// ── GET /api/memes ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(req.query.offset, 0, 0, 1_000_000)
  const sort = SORTS.has(req.query.sort) ? req.query.sort : 'hot'

  try {
    const { rows, total } = await listRows('memes', [
      ...filterQueries(req.query),
      ...sortQueries(sort),
      Query.limit(limit),
      Query.offset(offset),
    ])
    res.set('Cache-Control', 'public, max-age=30')
    res.json({ memes: rows, total })
  } catch (err) {
    sendError(res, '', err)
  }
})

// ── GET /api/memes/count ─────────────────────────────────────────────────────
router.get('/count', async (_req, res) => {
  try {
    const { total } = await listRows('memes', [Query.equal('is_published', true), Query.limit(1)])
    res.set('Cache-Control', 'public, max-age=300')
    res.json({ count: total })
  } catch (err) {
    sendError(res, '/count', err)
  }
})

// ── GET /api/memes/by-ids ────────────────────────────────────────────────────
router.get('/by-ids', async (req, res) => {
  const ids = csv(req.query.ids)
  if (ids.length === 0) return res.json({ memes: [] })
  if (ids.length > MAX_IDS) return res.status(400).json({ error: `Too many ids (max ${MAX_IDS}).` })

  try {
    const { rows } = await listRows('memes', [
      Query.equal('$id', ids),
      Query.equal('is_published', true),
      Query.limit(ids.length),
    ])
    res.json({ memes: rows })
  } catch (err) {
    sendError(res, '/by-ids', err)
  }
})

// ── GET /api/memes/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const meme = await getRow('memes', req.params.id)
    if (!meme || meme.is_published !== true) return res.status(404).json({ error: 'Not found.' })
    res.json({ meme })
  } catch (err) {
    sendError(res, '/:id', err)
  }
})

// ── GET /api/memes/:id/similar ───────────────────────────────────────────────
router.get('/:id/similar', async (req, res) => {
  const limit = clampInt(req.query.limit, 14, 1, 50)
  const { category } = req.query
  const moods = csv(req.query.moods)
  if (!category) return res.json({ memes: [] })

  const base = [
    Query.equal('is_published', true),
    Query.equal('category', category),
    Query.notEqual('$id', req.params.id),
    Query.orderDesc('download_count'),
    Query.limit(limit),
  ]

  try {
    // Prefer memes sharing at least one mood tag, then fill with the category.
    let rows = []
    if (moods.length) {
      ;({ rows } = await listRows('memes', [...base, Query.containsAny('mood_tags', moods)]))
    }
    if (rows.length < 6) {
      const used = new Set(rows.map((r) => r.id))
      const { rows: extra } = await listRows('memes', base)
      rows = [...rows, ...extra.filter((r) => !used.has(r.id))].slice(0, limit)
    }
    res.json({ memes: rows })
  } catch (err) {
    sendError(res, '/:id/similar', err)
  }
})

// ── POST /api/memes/:id/view ─────────────────────────────────────────────────
router.post('/:id/view', (req, res) => {
  res.status(202).json({ ok: true })
  incrementColumn('memes', req.params.id, 'view_count').catch((err) => {
    if (err.code !== 404) console.error('[memes/view]', err.message)
  })
})

export default router
