import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

// Admin-only — gate every request before touching the cache or Reddit.
router.use(requireAuth, requireAdmin)

// Reddit RSS works without OAuth and is not rate-limited like the JSON API.
// "new" sort returns genuinely fresh posts on every fetch.
const cache    = new Map()
const CACHE_MS = 60 * 1000  // 1 min — keeps "new" sort fresh

const ALLOWED_SUBS = new Set([
  'TamilMemes', 'kollywood', 'tamil', 'TamilNadu',
  'memes', 'dankmemes', 'funny', 'gaming', 'me_irl',
])

function redditError(status, sub) {
  if (status === 404) return { status: 404, code: 'NOT_FOUND',    message: `r/${sub} doesn't exist on Reddit` }
  if (status === 403) return { status: 403, code: 'PRIVATE',      message: `r/${sub} is private or restricted` }
  if (status === 429) return { status: 429, code: 'RATE_LIMITED', message: 'Reddit rate limit — try again shortly' }
  return               { status: 502, code: 'UPSTREAM_ERROR', message: `Reddit returned ${status}` }
}

router.get('/', async (req, res, next) => {
  try {
    const sub   = ALLOWED_SUBS.has(req.query.sub) ? req.query.sub : 'memes'
    const force = req.query.force === 'true'
    const key   = sub
    const now   = Date.now()
    const hit   = cache.get(key)

    if (!force && hit && now - hit.ts < CACHE_MS) {
      res.set('Content-Type', 'application/xml')
      res.set('X-Cache', 'HIT')
      res.set('X-Cache-Age', String(Math.floor((now - hit.ts) / 1000)))
      return res.send(hit.xml)
    }

    const upstream = await fetch(
      `https://www.reddit.com/r/${sub}/new/.rss`,
      { headers: { 'User-Agent': 'Vidsour/1.0 (+https://videsaur.co.in)' } }
    )

    if (!upstream.ok) {
      if (hit) {
        res.set('Content-Type', 'application/xml')
        res.set('X-Cache', 'STALE')
        return res.send(hit.xml)
      }
      const { status, code, message } = redditError(upstream.status, sub)
      return res.status(status).json({ error: message, code, sub })
    }

    const xml = await upstream.text()
    cache.set(key, { xml, ts: now })
    res.set('Content-Type', 'application/xml')
    res.set('X-Cache', 'MISS')
    res.set('X-Cache-Age', '0')
    res.send(xml)
  } catch (err) {
    next(err)
  }
})

export default router
