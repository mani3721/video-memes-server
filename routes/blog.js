/**
 * Public blog reads, backed by Appwrite. Only `status = 'published'` posts are
 * ever returned; drafts and removed posts stay server-side.
 *
 *   GET /api/blog          list (newest first, without the body)
 *   GET /api/blog/:slug    single post
 */

import { Router } from 'express'
import { listAllRows, listRows, Query } from '../db/appwrite.js'

const router = Router()

const LIST_COLUMNS = ['$id', 'slug', 'title', 'excerpt', 'cover_url', 'published_at']

router.get('/', async (_req, res) => {
  try {
    const posts = await listAllRows(
      'blog_posts',
      [Query.equal('status', 'published'), Query.orderDesc('published_at'), Query.select(LIST_COLUMNS)],
      { pageSize: 100, cap: 1000 },
    )
    res.set('Cache-Control', 'public, max-age=60')
    res.json({ posts })
  } catch (err) {
    console.error('[blog]', err.message)
    res.status(500).json({ error: 'Could not load blog posts.' })
  }
})

router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await listRows('blog_posts', [
      Query.equal('slug', req.params.slug),
      Query.equal('status', 'published'),
      Query.limit(1),
    ])
    if (!rows[0]) return res.status(404).json({ error: 'Not found.' })
    res.set('Cache-Control', 'public, max-age=60')
    res.json({ post: rows[0] })
  } catch (err) {
    console.error('[blog/:slug]', err.message)
    res.status(500).json({ error: 'Could not load blog post.' })
  }
})

export default router
