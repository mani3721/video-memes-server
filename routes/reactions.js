/**
 * POST /api/reactions        (body: { memeId, reaction })
 * GET  /api/reactions/mine   (query: ?memeIds=id1,id2,…)
 *
 * Reactions are open to guests. There is no requireAuth here and that is
 * deliberate — a reaction is a one-tap signal on public content, so putting an
 * account in front of it would cost far more participation than the spam it
 * prevents. Abuse is contained three ways instead:
 *
 *   1. Identity-free de-duplication. Every caller is assigned an opaque
 *      HttpOnly session cookie; the DB holds a UNIQUE (meme_id, reaction,
 *      actor_key) constraint, so a given browser's second tap toggles its own
 *      reaction off rather than adding a second one. Replaying the request
 *      cannot inflate a count.
 *   2. A per-IP rate limit (mounted in index.js) that is far tighter than the
 *      global /api limiter.
 *   3. Signed-in users are keyed by user ID, so clearing cookies does not let
 *      them re-react — the stricter treatment falls on accounts, not guests.
 *
 * The cookie is the trust anchor rather than any client-supplied ID: the
 * client cannot choose its own actor_key, so it cannot mint unlimited
 * identities by rewriting localStorage.
 */

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { supabase } from '../db/supabaseClient.js'
import { optionalAuth } from '../middleware/auth.js'

const router = Router()

const REACTIONS = new Set(['laugh', 'fire', 'skull'])

const COOKIE_NAME = 'videsaur_sid'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2 // 2 years in seconds

/**
 * Read the guest session ID from the cookie header, minting one if absent.
 *
 * Reuses the videsaur_sid cookie name so a browser carries one anonymous
 * session, not one per feature. (routes/favorites.js also mints this cookie,
 * but that route is dead against the current favorites schema — the client
 * syncs favorites through Supabase directly, so treat this route as the only
 * live writer of the cookie.)
 */
function getOrCreateSession(req, res) {
  const match = (req.headers.cookie ?? '').match(/videsaur_sid=([^;]+)/)
  if (match) return match[1]

  const sid = randomUUID()
  // append rather than set: favorites may already have queued a Set-Cookie,
  // and SameSite=Lax keeps the cookie working for top-level navigations while
  // still being sent on our own same-site XHR.
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${sid}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`,
  )
  return sid
}

/**
 * The dedupe key. Signed-in users are namespaced under 'user:' so that signing
 * in does not hand someone a second vote on content they already reacted to
 * as a guest, and so clearing cookies does not reset an account's history.
 */
function actorKeyFor(req, res) {
  if (req.user?.id) return `user:${req.user.id}`
  return `guest:${getOrCreateSession(req, res)}`
}

// ── POST /api/reactions ───────────────────────────────────────────────────────
router.post('/', optionalAuth, async (req, res) => {
  const { memeId, reaction } = req.body ?? {}

  if (!memeId) return res.status(400).json({ error: 'memeId required.' })
  if (!REACTIONS.has(reaction)) {
    return res.status(400).json({ error: `reaction must be one of: ${[...REACTIONS].join(', ')}` })
  }

  const actorKey = actorKeyFor(req, res)

  // toggle_reaction moves the counter and writes the event row in one
  // transaction, so the count can never drift from the event log.
  const { data, error } = await supabase.rpc('toggle_reaction', {
    p_meme_id: memeId,
    p_reaction: reaction,
    p_actor_key: actorKey,
  })

  if (error) {
    // A bad UUID or unknown meme is the caller's problem, not a server fault.
    const isBadInput = /invalid input syntax|meme not found|unsupported reaction/i.test(error.message)
    if (isBadInput) return res.status(400).json({ error: 'Unknown meme or reaction.' })

    console.error('[reactions]', error.message)
    return res.status(500).json({ error: 'Could not record reaction.' })
  }

  // The RPC returns a single row: { total, reacted }
  const row = Array.isArray(data) ? data[0] : data
  res.json({ reaction, total: Number(row?.total ?? 0), reacted: Boolean(row?.reacted) })
})

// ── GET /api/reactions/mine ───────────────────────────────────────────────────
// Lets a returning visitor see which reactions they already hold. Without this
// the buttons would render unreacted on every cold load and invite a duplicate
// tap that silently toggles the reaction off.
router.get('/mine', optionalAuth, async (req, res) => {
  const ids = String(req.query.memeIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (ids.length === 0) return res.json({ reactions: {} })
  // Bound the IN list so a hand-crafted query string cannot ask for the world.
  if (ids.length > 100) return res.status(400).json({ error: 'Too many memeIds (max 100).' })

  const actorKey = actorKeyFor(req, res)

  const { data, error } = await supabase
    .from('reaction_events')
    .select('meme_id, reaction')
    .eq('actor_key', actorKey)
    .in('meme_id', ids)

  if (error) {
    // Non-critical: the UI degrades to "not yet reacted" rather than erroring.
    console.error('[reactions/mine]', error.message)
    return res.json({ reactions: {} })
  }

  const reactions = {}
  for (const { meme_id, reaction } of data ?? []) {
    ;(reactions[meme_id] ??= []).push(reaction)
  }

  res.json({ reactions })
})

export default router
