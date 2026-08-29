/**
 * POST /api/upload
 *
 * Accepts multipart/form-data and stores the file in DigitalOcean Spaces.
 * Fields:
 *   file       — the media file (required)
 *   title      — human-readable name (required)
 *   category   — "videos" | "gifs" | "images" | "sounds" (required)
 *   mood_tags  — comma-separated mood ids, e.g. "laugh,savage"
 *   license    — "CC0" | "Editorial" (default: CC0)
 *
 * On success returns 201 with { meme: <row> }.
 */

import { Router } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { spaces, BUCKET, CDN_URL } from '../spacesClient.js'
import { supabase } from '../supabaseClient.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// ── Allowed file types ───────────────────────────────────────────────────────

const ALLOWED = {
  'video/mp4':  { ext: 'mp4',  category: 'videos', maxBytes: 50 * 1024 * 1024 },
  'video/webm': { ext: 'webm', category: 'videos', maxBytes: 50 * 1024 * 1024 },
  'image/gif':  { ext: 'gif',  category: 'gifs',   maxBytes: 20 * 1024 * 1024 },
  'image/png':  { ext: 'png',  category: 'images', maxBytes: 10 * 1024 * 1024 },
  'image/jpeg': { ext: 'jpg',  category: 'images', maxBytes: 10 * 1024 * 1024 },
  'image/webp': { ext: 'webp', category: 'images', maxBytes: 10 * 1024 * 1024 },
  'audio/mpeg': { ext: 'mp3',  category: 'sounds', maxBytes: 10 * 1024 * 1024 },
  'audio/wav':  { ext: 'wav',  category: 'sounds', maxBytes: 20 * 1024 * 1024 },
}

// ── Multer (memory storage — magic-byte check happens before any write) ──────

const upload = multer({
  storage: multer.memoryStorage(),
  // Reject oversized requests before reading the body at all
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/, '')
    .slice(0, 80)
}

async function generateThumbnail(buffer, mime) {
  if (mime.startsWith('image/')) {
    return sharp(buffer).resize(600, 600, { fit: 'cover' }).webp({ quality: 80 }).toBuffer()
  }
  // Video/audio: grey placeholder. Wire up ffmpeg in production for real frames.
  return sharp({
    create: { width: 600, height: 600, channels: 3, background: { r: 18, g: 16, b: 28 } },
  })
    .webp({ quality: 60 })
    .toBuffer()
}

async function putToSpaces(key, buffer, contentType, contentDisposition) {
  await spaces.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: contentDisposition,
      // ACL required for Spaces public objects (R2 doesn't need this)
      ACL: 'public-read',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )
  return `${CDN_URL}/${key}`
}

// ── Route ────────────────────────────────────────────────────────────────────

router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file
    if (!file) return res.status(400).json({ error: 'No file provided.' })

    // 1 — Validate magic bytes (not just Content-Type header)
    const detected = await fileTypeFromBuffer(file.buffer)
    const mime = detected?.mime ?? file.mimetype
    const allowed = ALLOWED[mime]

    if (!allowed) {
      return res.status(415).json({
        error: `Unsupported file type: ${mime}. Accepted: MP4, WebM, GIF, PNG, JPEG, WebP, MP3, WAV.`,
      })
    }
    if (file.size > allowed.maxBytes) {
      return res.status(413).json({
        error: `File too large. Max for ${allowed.ext.toUpperCase()} is ${allowed.maxBytes / 1024 / 1024} MB.`,
      })
    }

    // 2 — Validate fields
    const title = (req.body.title ?? '').trim()
    if (!title) return res.status(400).json({ error: 'title is required.' })

    const category = req.body.category ?? allowed.category
    if (!['videos', 'gifs', 'images', 'sounds'].includes(category)) {
      return res.status(400).json({ error: 'category must be videos, gifs, images, or sounds.' })
    }

    const license = ['CC0', 'Editorial'].includes(req.body.license) ? req.body.license : 'CC0'
    const moodTags = req.body.mood_tags
      ? req.body.mood_tags.split(',').map((t) => t.trim()).filter(Boolean)
      : []

    // 3 — Build unique Spaces keys
    const uid = uuidv4()
    const slug = slugify(title)
    const mainKey = `${category}/${uid}-${slug}.${allowed.ext}`
    const thumbKey = `thumbnails/${uid}.webp`
    const filename = `videsaur-${slug}.${allowed.ext}`

    // 4 — Generate thumbnail and upload both files in parallel
    const thumbBuffer = await generateThumbnail(file.buffer, mime)
    const [publicUrl, thumbnailUrl] = await Promise.all([
      putToSpaces(mainKey, file.buffer, mime, `attachment; filename="${filename}"`),
      putToSpaces(thumbKey, thumbBuffer, 'image/webp', `inline; filename="${uid}.webp"`),
    ])

    // 5 — Get image dimensions (still images only)
    let widthPx = null
    let heightPx = null
    if (mime.startsWith('image/')) {
      const meta = await sharp(file.buffer).metadata()
      widthPx = meta.width ?? null
      heightPx = meta.height ?? null
    }

    // 6 — Insert metadata into Supabase (all uploads are public immediately)
    const { data: meme, error: dbErr } = await supabase
      .from('memes')
      .insert({
        title,
        spaces_key: mainKey,
        public_url: publicUrl,
        thumbnail_spaces_key: thumbKey,
        thumbnail_url: thumbnailUrl,
        filename,
        format: allowed.ext.toUpperCase().replace('JPG', 'JPEG'),
        category,
        mood_tags: moodTags,
        license,
        file_size_bytes: file.size,
        width_px: widthPx,
        height_px: heightPx,
        uploader_id: req.user.id,
        is_published: true,
      })
      .select()
      .single()

    if (dbErr) {
      console.error('[upload] Supabase insert error:', dbErr.message)
      return res.status(500).json({ error: 'File uploaded to Spaces but metadata save failed. Contact support.' })
    }

    return res.status(201).json({ meme })
  } catch (err) {
    console.error('[upload] Unexpected error:', err.message)
    return res.status(500).json({ error: 'Upload failed. Please try again.' })
  }
})

export default router
