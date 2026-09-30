/**
 * AI Chat proxy — ModelScope (OpenAI-compatible) chat completions.
 *
 *   POST /api/ai-chat          → { reply, model, usage }
 *   POST /api/ai-chat?stream=1 → text/event-stream of { delta } frames
 *
 * The browser never sees MODELSCOPE_API_KEY: a key shipped in a Vite bundle is
 * a public key, and ModelScope's free tier is a hard 2,000 requests/day for the
 * whole account, so one scraper would drain the quota for every visitor. All
 * traffic goes through here, where the key stays server-side and the per-IP
 * limiter below is the actual spend control.
 */
import { Router } from 'express'
import rateLimit from 'express-rate-limit'

const router = Router()

const API_URL = 'https://api-inference.modelscope.cn/v1/chat/completions'

// Overridable because ModelScope rotates model IDs faster than we redeploy —
// a 404 from a retired ID should be a config change, not a code change.
const MODEL = process.env.MODELSCOPE_MODEL ?? 'Qwen/Qwen3-30B-A3B-Instruct-2507'

// ── Request shape limits ──────────────────────────────────────────────────────
// The upstream bills by request, not by token, but an unbounded history is
// still a free way for a client to make us pay latency and burn context.
const MAX_MESSAGES    = 30
const MAX_CHARS       = 4000   // per message
const MAX_TOTAL_CHARS = 24000  // whole conversation
const ROLES = new Set(['user', 'assistant', 'system'])

const SYSTEM_PROMPT =
  'You are Vidsour Assistant, a friendly helper on Vidsour — a site for free meme videos, ' +
  'GIFs, blank templates, stickers and sound effects. Help visitors find content, write ' +
  'captions, brainstorm meme ideas and answer questions about editing or downloading. ' +
  'Keep answers short and conversational. Use simple Markdown (bold, lists, code) when it ' +
  'helps. If a question is outside memes or the site, answer briefly and helpfully anyway.'

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages — give the AI a moment to catch up.' },
})

/**
 * Returns a clean message array or throws a 400-shaped Error.
 * Anything the caller sends beyond role/content is dropped rather than
 * forwarded: the upstream accepts extra fields, and silently proxying unknown
 * keys (tools, functions, images) would let a client reshape our request.
 */
function normalizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    const err = new Error('messages must be a non-empty array')
    err.status = 400
    throw err
  }

  // Keep the tail: the most recent turns are the ones that carry the context.
  const messages = raw.slice(-MAX_MESSAGES).map((m) => {
    const role = ROLES.has(m?.role) ? m.role : 'user'
    const content = typeof m?.content === 'string' ? m.content.trim() : ''
    return { role, content: content.slice(0, MAX_CHARS) }
  }).filter((m) => m.content.length > 0)

  if (messages.length === 0) {
    const err = new Error('messages must contain at least one non-empty message')
    err.status = 400
    throw err
  }

  const total = messages.reduce((n, m) => n + m.content.length, 0)
  if (total > MAX_TOTAL_CHARS) {
    const err = new Error('Conversation is too long. Start a new chat.')
    err.status = 413
    throw err
  }

  return [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
}

function callUpstream({ messages, stream, signal }) {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MODELSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 1024,
    }),
    signal,
  })
}

router.post('/', chatLimiter, async (req, res) => {
  if (!process.env.MODELSCOPE_API_KEY) {
    return res.status(503).json({ error: 'AI chat is not configured on this server.' })
  }

  let messages
  try {
    messages = normalizeMessages(req.body?.messages)
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message })
  }

  const wantsStream = req.query.stream === '1' || req.body?.stream === true

  // Abort the upstream call when the browser navigates away mid-answer,
  // otherwise a closed tab keeps consuming the daily quota to completion.
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  let upstream
  try {
    upstream = await callUpstream({ messages, stream: wantsStream, signal: controller.signal })
  } catch (err) {
    if (controller.signal.aborted) return
    console.error('[ai-chat] upstream unreachable:', err.message)
    return res.status(502).json({ error: 'Could not reach the AI service. Try again.' })
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    console.error('[ai-chat] upstream %d: %s', upstream.status, detail.slice(0, 500))
    // 429 is the daily-quota wall and is worth surfacing honestly; everything
    // else collapses to a generic message so upstream internals stay private.
    const status = upstream.status === 429 ? 429 : 502
    return res.status(status).json({
      error: status === 429
        ? 'The AI is out of free requests for now. Please try again later.'
        : 'The AI service returned an error. Try again.',
    })
  }

  if (!wantsStream) {
    const data = await upstream.json().catch(() => null)
    const reply = data?.choices?.[0]?.message?.content?.trim()
    if (!reply) {
      return res.status(502).json({ error: 'The AI returned an empty response.' })
    }
    return res.json({ reply, model: data.model ?? MODEL, usage: data.usage ?? null })
  }

  // ── Streaming ───────────────────────────────────────────────────────────────
  // Re-emitted as our own minimal SSE ({ delta } / [DONE]) rather than piped
  // raw: the client then depends on this shape, not on ModelScope's, and the
  // upstream's per-chunk metadata never reaches the browser.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Render/nginx buffer SSE by default, which would deliver the whole answer
    // in one lump and defeat the point of streaming.
    'X-Accel-Buffering': 'no',
  })

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  try {
    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true })

      // SSE frames are separated by a blank line; a chunk can split one in half.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue

        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue

        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
          if (delta) send({ delta })
        } catch {
          // A malformed frame is not worth killing a good answer over.
        }
      }
    }

    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    if (controller.signal.aborted) return
    console.error('[ai-chat] stream error:', err.message)
    // Headers are already sent, so the error has to travel in-band.
    send({ error: 'The response was cut short. Try again.' })
    res.end()
  }
})

export default router
