import express from 'express'
import rateLimit from 'express-rate-limit'

const router = express.Router()

const FORMAT_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/L16',
}

const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many TTS requests. Please wait a moment.' },
})

router.post('/tts', ttsLimiter, async (req, res) => {
  try {
    const {
      text,
      reference_id,
      format        = 'mp3',
      sample_rate   = 44100,
      mp3_bitrate   = 128,
      latency       = 'normal',
      // prosody
      speed                        = 1,
      volume                       = 0,
      normalize_loudness           = true,
      // generation
      temperature                  = 0.7,
      top_p                        = 0.7,
      repetition_penalty           = 1.2,
      chunk_length                 = 300,
      min_chunk_length             = 50,
      max_new_tokens               = 1024,
      early_stop_threshold         = 1,
      normalize                    = true,
      condition_on_previous_chunks = true,
    } = req.body

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text is required' })
    }

    const audioFormat = FORMAT_MIME[format] ? format : 'mp3'

    const body = {
      text: text.trim(),
      format: audioFormat,
      sample_rate,
      latency,
      temperature,
      top_p,
      repetition_penalty,
      chunk_length,
      min_chunk_length,
      max_new_tokens,
      early_stop_threshold,
      normalize,
      condition_on_previous_chunks,
      prosody: {
        speed,
        volume,
        normalize_loudness,
      },
    }

    if (reference_id) body.reference_id = reference_id
    if (audioFormat === 'mp3') body.mp3_bitrate = mp3_bitrate

    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
        'Content-Type': 'application/json',
        model: 's2.1-pro-free',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Fish Audio API error: ${errText}`)
    }

    res.setHeader('Content-Type', FORMAT_MIME[audioFormat])
    const buffer = await response.arrayBuffer()
    res.send(Buffer.from(buffer))
  } catch (err) {
    console.error('[tts] error:', err)
    res.status(500).json({ error: 'TTS generation failed' })
  }
})

export default router
