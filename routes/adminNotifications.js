/**
 * POST  /api/admin/announcements      — broadcast a notification to all users
 * PATCH /api/admin/announcements/:id  — edit a broadcast
 * GET   /api/admin/announcements      — recent broadcasts, newest first
 *
 * Mounted behind requireAuth + requireAdmin.
 *
 * An announcement is a SINGLE notifications row with user_id = null; per-user
 * read state lives in notification_reads.
 */

import { Router } from 'express'
import { Query, getRow, createRow, updateRow, listRows } from '../db/d1.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

router.use(requireAuth, requireAdmin)

const MAX_TITLE = 200
const MAX_MESSAGE = 2000

/**
 * Only site-relative links are accepted — an absolute URL would be an open
 * redirect pointed at the whole userbase.
 */
export function normaliseLink(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false }

  const link = raw.trim()
  if (!link.startsWith('/') || link.startsWith('//')) return { ok: false }
  return { ok: true, value: link }
}

/**
 * Thumbnails may be absolute (the CDN) or site-relative (a bundled asset), but
 * never javascript:/data: — those would execute in the notification list.
 */
export function normaliseThumbnail(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false }

  const value = raw.trim()
  if (value.startsWith('/') && !value.startsWith('//')) return { ok: true, value }
  if (/^https:\/\/[^\s]+$/i.test(value)) return { ok: true, value }
  return { ok: false }
}

/** @returns {{ error: string } | { fields: object }} */
function parseAnnouncement(body) {
  const { title, message, link, thumbnail, segmentLanguage } = body ?? {}

  if (typeof title !== 'string' || title.trim().length === 0) return { error: 'Title is required.' }
  if (title.trim().length > MAX_TITLE) return { error: `Title must be ${MAX_TITLE} characters or fewer.` }
  if (message != null && typeof message !== 'string') return { error: 'Message must be text.' }
  if (typeof message === 'string' && message.length > MAX_MESSAGE) {
    return { error: `Message must be ${MAX_MESSAGE} characters or fewer.` }
  }

  const linkResult = normaliseLink(link)
  if (!linkResult.ok) return { error: 'Link must be a site-relative path starting with "/".' }

  const thumbResult = normaliseThumbnail(thumbnail)
  if (!thumbResult.ok) return { error: 'Thumbnail must be an https:// URL or a site-relative path.' }

  return {
    fields: {
      title: title.trim(),
      message: typeof message === 'string' && message.trim() ? message.trim() : null,
      link: linkResult.value,
      thumbnail: thumbResult.value,
      segment_language:
        typeof segmentLanguage === 'string' && segmentLanguage.trim() ? segmentLanguage.trim() : null,
    },
  }
}

const shape = ({ id, title, message, link, thumbnail, segment_language, created_at }) =>
  ({ id, title, message, link, thumbnail, segment_language, created_at })

// ── POST /api/admin/announcements ────────────────────────────────────────────
router.post('/', async (req, res) => {
  const parsed = parseAnnouncement(req.body)
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  try {
    const row = await createRow('notifications', {
      ...parsed.fields,
      user_id: null, // broadcast
      type: 'announcement',
      created_at: new Date().toISOString(),
    })
    res.status(201).json({ announcement: shape(row) })
  } catch (err) {
    console.error('[admin/announcements]', err.message)
    res.status(500).json({ error: 'Could not send announcement.' })
  }
})

// ── PATCH /api/admin/announcements/:id ───────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const parsed = parseAnnouncement(req.body)
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  try {
    const existing = await getRow('notifications', req.params.id)
    if (!existing || existing.user_id != null || existing.type !== 'announcement') {
      return res.status(404).json({ error: 'Announcement not found.' })
    }
    const row = await updateRow('notifications', req.params.id, parsed.fields)
    res.json({ announcement: shape(row) })
  } catch (err) {
    console.error('[admin/announcements:update]', err.message)
    res.status(500).json({ error: 'Could not update announcement.' })
  }
})

// ── GET /api/admin/announcements ─────────────────────────────────────────────
router.get('/', async (_req, res) => {
  try {
    const { rows } = await listRows('notifications', [
      Query.isNull('user_id'),
      Query.equal('type', 'announcement'),
      Query.orderDesc('created_at'),
      Query.limit(25),
    ])
    res.json({ announcements: rows.map(shape) })
  } catch (err) {
    console.error('[admin/announcements:list]', err.message)
    res.status(500).json({ error: 'Could not load announcements.' })
  }
})

export default router
