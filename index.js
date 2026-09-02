import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import uploadRouter from './routes/upload.js'
import trackDownloadRouter from './routes/trackDownload.js'
import bulkDownloadRouter from './routes/bulkDownload.js'
import favoritesRouter from './routes/favorites.js'
import adminRouter from './routes/admin.js'
import ttsRouter from './routes/textToSpeech.js'
import sitemapRouter from './routes/sitemap.js'
import { startSitemapWarmer } from './lib/sitemap/scheduler.js'

const app = express()
const PORT = process.env.PORT ?? 3001

// ── Proxy trust ───────────────────────────────────────────────────────────────
// Render (and the Vercel rewrite in front of it) terminate TLS and forward the
// client IP in X-Forwarded-For. Without this, req.ip is the proxy's address, so
// every rate limiter buckets all traffic on the planet into a single counter —
// 120 req/min shared by every visitor — and express-rate-limit logs
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on each request.
//
// The hop count matters: trusting more hops than actually exist lets a client
// spoof its IP by sending its own X-Forwarded-For. 1 == the single proxy in
// front of this server. Override with TRUST_PROXY if that changes.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1))

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
      cb(new Error(`CORS: origin ${origin} not allowed`))
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true, // required for cookie-based favorites session
  }),
)

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }))

// ── Rate limiting ─────────────────────────────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,                    // 50 uploads per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads from this IP. Please wait before trying again.' },
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

app.use('/api/', apiLimiter)
app.use('/api/upload', uploadLimiter)

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/upload', uploadRouter)
app.use('/api/track-download', trackDownloadRouter)
app.use('/api/bulk-download', bulkDownloadRouter)
app.use('/api/favorites', favoritesRouter)
app.use('/api/admin', adminRouter)
app.use('/api', ttsRouter)

// Sitemaps live at the root, not under /api, because crawlers fetch them from
// the site origin (client/vercel.json rewrites /sitemap*.xml to this server).
// Mounted after the /api routers so it cannot shadow them, and outside the
// apiLimiter — it carries its own, crawler-friendly rate limit.
app.use('/', sitemapRouter)

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  // Never expose internal error details in production
  console.error('[server]', err.message)
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`[videsaur-server] listening on http://localhost:${PORT}`)
  // Keeps sitemap files pre-rendered so crawler requests never wait on a build.
  startSitemapWarmer()
})
