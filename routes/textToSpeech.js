import express from 'express'

const router = express.Router()

const FORMAT_MIME = {
  mp3: 'audio/mpeg',
  pcm: 'audio/L16',
}

router.post('/tts', async (req, res) => {
  try {
    const { text, voiceId, format = 'mp3' } = req.body

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text is required' })
    }

    const audioFormat = FORMAT_MIME[format] ? format : 'mp3'

    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.trim(),
        model: 's2.1-pro-free',
        reference_id: voiceId || undefined,
        format: audioFormat,
        sample_rate: 44100,
        prosody: {
          speed: 1,
          volume: 0,
          normalize_loudness: true,
        },
        normalize: true,
      }),
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
