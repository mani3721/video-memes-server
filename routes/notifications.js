/**
 * GET   /api/notifications              — paginated feed (?type=&page=&limit=)
 * GET   /api/notifications/unread-count — badge probe, polled by the client
 * POST  /api/notifications/read-all     — mark everything visible as read
 * POST  /api/notifications/:id/read     — mark one as read
 *
 * Every route requires a signed-in user. This is deliberate and is the one
 * place on the site where that is the right call: read/unread state has to
 * hang off a durable identity, and a guest has none. Guests are not shown the
 * bell at all rather than being shown one that prompts them to sign in.
 *
 * Reads and writes go through the service-role client, scoped to req.user.id
 * on every query. The "which notifications can this user see?" rule lives in
 * one place — the visible_notifications() SQL function — so the feed, the
 * unread count and mark-all-read cannot disagree about it.
 */

import { Router } from 'express'
import { supabase } from '../db/supabaseClient.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.use(requireAuth)

const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

/**
 * Filter tabs → stored types.
 *
 * 'system' covers milestones too: from a reader's point of view "your upload
 * hit 100 downloads" is the site talking to them about their account, which
 * is the same bucket as a maintenance notice. Keeping them as distinct stored
 * types leaves room to split the tabs later without a data migration.
 */
const TYPE_FILTERS = {
  all: null,
  new_content: ['new_content'],
  announcement: ['announcement'],
  system: ['system', 'milestone'],
}

// ── GET /api/notifications ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const userId = req.user.id

  const filter = String(req.query.type ?? 'all')
  if (!(filter in TYPE_FILTERS)) {
    return res.status(400).json({ error: `type must be one of: ${Object.keys(TYPE_FILTERS).join(', ')}` })
  }

  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE_SIZE))
  const from = (page - 1) * limit

  // visible_notifications() is a set-returning function, so it is queryable
  // like a view — .rpc() with a chained range/order pushes paging into SQL
  // rather than fetching everything and slicing in JS.
  let q = supabase
    .rpc('visible_notifications', { p_user_id: userId })
    .select('id, type, title, message, link, thumbnail, created_at')
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1)

  const types = TYPE_FILTERS[filter]
  if (types) q = q.in('type', types)

  const { data, error } = await q

  if (error) {
    console.error('[notifications]', error.message)
    return res.status(500).json({ error: 'Could not load notifications.' })
  }

  const rows = data ?? []

  // Resolve read state for just this page rather than joining in SQL. The page
  // is at most 50 ids, so this is one small indexed lookup, and it keeps
  // visible_notifications() free of per-user read plumbing.
  let readIds = new Set()
  if (rows.length > 0) {
    const { data: reads } = await supabase
      .from('notification_reads')
      .select('notification_id')
      .eq('user_id', userId)
      .in('notification_id', rows.map((r) => r.id))
    readIds = new Set((reads ?? []).map((r) => r.notification_id))
  }

  res.json({
    notifications: rows.map((r) => ({ ...r, read: readIds.has(r.id) })),
    page,
    limit,
    // No total count: COUNT(*) over the union on every page load costs more
    // than it buys. A short page is the end of the list.
    hasMore: rows.length === limit,
  })
})

// ── GET /api/notifications/unread-count ──────────────────────────────────────
router.get('/unread-count', async (req, res) => {
  const { data, error } = await supabase.rpc('unread_notification_count', {
    p_user_id: req.user.id,
  })

  if (error) {
    console.error('[notifications/unread-count]', error.message)
    // The badge is decoration; never fail the header over it.
    return res.json({ count: 0 })
  }

  res.json({ count: Number(data ?? 0) })
})

// ── POST /api/notifications/read-all ─────────────────────────────────────────
router.post('/read-all', async (req, res) => {
  const { data, error } = await supabase.rpc('mark_all_notifications_read', {
    p_user_id: req.user.id,
  })

  if (error) {
    console.error('[notifications/read-all]', error.message)
    return res.status(500).json({ error: 'Could not mark notifications as read.' })
  }

  res.json({ ok: true, marked: Number(data ?? 0) })
})

// ── POST /api/notifications/:id/read ─────────────────────────────────────────
router.post('/:id/read', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  // Confirm the notification is actually visible to this user before recording
  // a read. Without this check, any authenticated user could insert a read row
  // for an arbitrary id — harmless on its own, but it would let them probe
  // which notification ids exist.
  const { data: visible, error: visErr } = await supabase
    .rpc('visible_notifications', { p_user_id: userId })
    .select('id')
    .eq('id', id)
    .maybeSingle()

  if (visErr) {
    console.error('[notifications/read]', visErr.message)
    return res.status(500).json({ error: 'Could not mark notification as read.' })
  }
  if (!visible) return res.status(404).json({ error: 'Notification not found.' })

  const { error } = await supabase
    .from('notification_reads')
    .upsert({ notification_id: id, user_id: userId }, { onConflict: 'notification_id,user_id', ignoreDuplicates: true })

  if (error) {
    console.error('[notifications/read]', error.message)
    return res.status(500).json({ error: 'Could not mark notification as read.' })
  }

  res.json({ ok: true })
})

export default router
