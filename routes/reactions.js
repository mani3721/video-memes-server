/**
 * POST /api/reactions        (body: { memeId, reaction })
 * GET  /api/reactions/mine   (query: ?memeIds=id1,id2,…)
 *
 * Reactions are open to guests (no requireAuth, deliberately). Abuse is
 * contained by:
 *   1. De-duplication: each (meme, reaction, actor) maps to ONE deterministic
 *      reaction_events row ID, so a second tap toggles instead of adding.
 *   2. A per-IP rate limit (mounted in index.js).
 *   3. Signed-in users are keyed by user ID, not cookie.
 *
 * The actor key comes from an HttpOnly cookie the server mints, so the client
 * cannot choose its own identity.
 */

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import {
  Query, DbError, createRow, deleteRowsWhere, getRow, incrementColumn, decrementColumn, listRows,
} from '../db/d1.js'
import { optionalAuth } from '../middleware/auth.js'

const router = Router()

const REACTIONS = new Set(['laugh', 'fire', 'skull'])

const COOKIE_NAME = 'videsaur_sid'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2 // 2 years in seconds

function getOrCreateSession(req, res) {
  const match = (req.headers.cookie ?? '').match(/videsaur_sid=([^;]+)/)
  if (match) return match[1]

  const sid = randomUUID()
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${sid}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`,
  )
  return sid
}

function actorKeyFor(req, res) {
  if (req.user?.id) return `user:${req.user.id}`
  return `guest:${getOrCreateSession(req, res)}`
}

// ── POST /api/reactions ───────────────────────────────────────────────────────
router.post('/', optionalAuth, async (req, res) => {
  const { memeId, reaction } = req.body ?? {}

  if (!memeId || typeof memeId !== 'string') return res.status(400).json({ error: 'memeId required.' })
  if (!REACTIONS.has(reaction)) {
    return res.status(400).json({ error: `reaction must be one of: ${[...REACTIONS].join(', ')}` })
  }

  const actorKey = actorKeyFor(req, res)
  const column = `${reaction}_count`

  try {
    const meme = await getRow('memes', memeId)
    if (!meme) return res.status(400).json({ error: 'Unknown meme or reaction.' })

    let reacted
    try {
      await createRow(
        'reaction_events',
        { meme_id: memeId, reaction, actor_key: actorKey, created_at: new Date().toISOString() },
      )
      reacted = true
    } catch (err) {
      if (!(err instanceof DbError && err.code === 409)) throw err
      await deleteRowsWhere('reaction_events', [
        Query.equal('meme_id', memeId), Query.equal('reaction', reaction), Query.equal('actor_key', actorKey),
      ])
      reacted = false
    }

    const updated = reacted
      ? await incrementColumn('memes', memeId, column)
      : await decrementColumn('memes', memeId, column)

    res.json({ reaction, total: Number(updated?.[column] ?? 0), reacted })
  } catch (err) {
    console.error('[reactions]', err.message)
    res.status(500).json({ error: 'Could not record reaction.' })
  }
})

// ── GET /api/reactions/mine ───────────────────────────────────────────────────
router.get('/mine', optionalAuth, async (req, res) => {
  const ids = String(req.query.memeIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (ids.length === 0) return res.json({ reactions: {} })
  if (ids.length > 100) return res.status(400).json({ error: 'Too many memeIds (max 100).' })

  const actorKey = actorKeyFor(req, res)

  try {
    const { rows } = await listRows('reaction_events', [
      Query.equal('actor_key', actorKey),
      Query.equal('meme_id', ids),
      Query.limit(300),
    ])
    const reactions = {}
    for (const { meme_id, reaction } of rows) {
      ;(reactions[meme_id] ??= []).push(reaction)
    }
    res.json({ reactions })
  } catch (err) {
    // Non-critical: the UI degrades to "not yet reacted".
    console.error('[reactions/mine]', err.message)
    res.json({ reactions: {} })
  }
})

export default router
