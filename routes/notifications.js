/**
 * GET   /api/notifications              — paginated feed (?type=&page=&limit=)
 * GET   /api/notifications/unread-count — badge probe, polled by the client
 * POST  /api/notifications/read-all     — mark everything visible as read
 * POST  /api/notifications/:id/read     — mark one as read
 *
 * Every route requires a signed-in user. The "which notifications can this
 * user see?" rule lives in visibleQueries() so the feed, the unread count and
 * mark-all-read cannot disagree about it:
 *   own rows, plus broadcasts (user_id NULL) that are unsegmented or match the
 *   user's preferred_language.
 */

import { Router } from 'express'
import { Query, DbError, getRow, listRows, listAllRows, createRow, stableId } from '../db/d1.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.use(requireAuth)

const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
/** Upper bound on how many visible notifications are considered at once. */
const VISIBLE_CAP = 1000

const TYPE_FILTERS = {
  all: null,
  new_content: ['new_content'],
  announcement: ['announcement'],
  system: ['system', 'milestone'],
}

async function visibleQueries(userId) {
  const profile = await getRow('profiles', userId).catch(() => null)
  const lang = profile?.preferred_language
  const segment = lang
    ? Query.or([Query.isNull('segment_language'), Query.equal('segment_language', lang)])
    : Query.isNull('segment_language')
  return [Query.or([Query.equal('user_id', userId), Query.and([Query.isNull('user_id'), segment])])]
}

async function readIdsFor(userId, notificationIds) {
  if (!notificationIds.length) return new Set()
  const out = new Set()
  // Appwrite caps array query values, so chunk the IN list.
  for (let i = 0; i < notificationIds.length; i += 100) {
    const rows = await listAllRows('notification_reads', [
      Query.equal('user_id', userId),
      Query.equal('notification_id', notificationIds.slice(i, i + 100)),
    ])
    for (const r of rows) out.add(r.notification_id)
  }
  return out
}

async function markRead(userId, notificationId) {
  try {
    await createRow(
      'notification_reads',
      { notification_id: notificationId, user_id: userId, read_at: new Date().toISOString() },
      stableId('read', notificationId, userId),
    )
    return 1
  } catch (err) {
    if (err instanceof DbError && err.code === 409) return 0
    throw err
  }
}

const PUBLIC_FIELDS = ({ id, type, title, message, link, thumbnail, created_at }) =>
  ({ id, type, title, message, link, thumbnail, created_at })

// ── GET /api/notifications ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const userId = req.user.id

  const filter = String(req.query.type ?? 'all')
  if (!(filter in TYPE_FILTERS)) {
    return res.status(400).json({ error: `type must be one of: ${Object.keys(TYPE_FILTERS).join(', ')}` })
  }

  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE_SIZE))

  try {
    const queries = await visibleQueries(userId)
    const types = TYPE_FILTERS[filter]
    if (types) queries.push(Query.equal('type', types))
    queries.push(Query.orderDesc('created_at'), Query.limit(limit), Query.offset((page - 1) * limit))

    const { rows } = await listRows('notifications', queries)
    const readIds = await readIdsFor(userId, rows.map((r) => r.id))

    res.json({
      notifications: rows.map((r) => ({ ...PUBLIC_FIELDS(r), read: readIds.has(r.id) })),
      page,
      limit,
      hasMore: rows.length === limit,
    })
  } catch (err) {
    console.error('[notifications]', err.message)
    res.status(500).json({ error: 'Could not load notifications.' })
  }
})

// ── GET /api/notifications/unread-count ──────────────────────────────────────
router.get('/unread-count', async (req, res) => {
  try {
    const visible = await listAllRows('notifications', await visibleQueries(req.user.id), { cap: VISIBLE_CAP })
    const readIds = await readIdsFor(req.user.id, visible.map((r) => r.id))
    res.json({ count: visible.filter((r) => !readIds.has(r.id)).length })
  } catch (err) {
    console.error('[notifications/unread-count]', err.message)
    // The badge is decoration; never fail the header over it.
    res.json({ count: 0 })
  }
})

// ── POST /api/notifications/read-all ─────────────────────────────────────────
router.post('/read-all', async (req, res) => {
  const userId = req.user.id
  try {
    const visible = await listAllRows('notifications', await visibleQueries(userId), { cap: VISIBLE_CAP })
    const readIds = await readIdsFor(userId, visible.map((r) => r.id))
    const unread = visible.filter((r) => !readIds.has(r.id))
    const results = await Promise.all(unread.map((r) => markRead(userId, r.id)))
    res.json({ ok: true, marked: results.reduce((a, b) => a + b, 0) })
  } catch (err) {
    console.error('[notifications/read-all]', err.message)
    res.status(500).json({ error: 'Could not mark notifications as read.' })
  }
})

// ── POST /api/notifications/:id/read ─────────────────────────────────────────
router.post('/:id/read', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  try {
    // Only record reads for notifications this user can actually see.
    const { rows } = await listRows('notifications', [
      ...(await visibleQueries(userId)),
      Query.equal('$id', id),
      Query.limit(1),
    ])
    if (!rows.length) return res.status(404).json({ error: 'Notification not found.' })

    await markRead(userId, id)
    res.json({ ok: true })
  } catch (err) {
    console.error('[notifications/read]', err.message)
    res.status(500).json({ error: 'Could not mark notification as read.' })
  }
})

export default router
