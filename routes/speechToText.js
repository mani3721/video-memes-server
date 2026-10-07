import express from 'express'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import { fileTypeFromBuffer } from 'file-type'

const router = express.Router()
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/webm',
  // Magic-byte detection identifies WebM containers as video even when they
  // contain audio only (for example, recordings from MediaRecorder).
  'video/webm',
])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
})

const asrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many transcription requests. Please wait a moment.' },
})

function receiveAudio(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('audio')(req, res, (error) => {
      if (!error) return resolve()
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        error.status = 413
        error.message = 'Audio file is too large. Maximum size is 25 MB.'
      } else {
        error.status = 400
      }
      reject(error)
    })
  })
}

router.post('/asr', asrLimiter, async (req, res) => {
  try {
    await receiveAudio(req, res)

    if (!process.env.FISH_AUDIO_API_KEY) {
      return res.status(503).json({ error: 'Speech recognition is not configured.' })
    }

    const file = req.file
    if (!file) return res.status(400).json({ error: 'An audio file is required.' })

    const detected = await fileTypeFromBuffer(file.buffer)
    const mime = detected?.mime ?? file.mimetype
    if (!ALLOWED_AUDIO_TYPES.has(mime)) {
      return res.status(415).json({
        error: 'Unsupported audio type. Use MP3, WAV, M4A, OGG, FLAC, or WebM.',
      })
    }

    const formData = new FormData()
    const filename = file.originalname || `speech.${detected?.ext ?? 'wav'}`
    formData.append('audio', new Blob([file.buffer], { type: mime }), filename)

    const response = await fetch('https://api.fish.audio/v1/asr', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}` },
      body: formData,
    })

    const rawBody = await response.text()
    let data
    try {
      data = JSON.parse(rawBody)
    } catch {
      data = null
    }

    if (!response.ok) {
      console.error('[asr] Fish Audio error:', response.status, rawBody)
      return res.status(response.status >= 500 ? 502 : response.status).json({
        error: data?.detail || data?.error || 'The transcription service rejected the audio.',
      })
    }

    if (!data || typeof data.text !== 'string') {
      console.error('[asr] Invalid Fish Audio response:', rawBody)
      return res.status(502).json({ error: 'The transcription service returned an invalid response.' })
    }

    res.json({ text: data.text })
  } catch (error) {
    console.error('[asr] error:', error)
    res.status(error.status ?? 500).json({ error: error.message || 'Transcription failed.' })
  }
})

export default router
