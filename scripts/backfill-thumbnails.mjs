/**
 * Regenerate blank thumbnails.
 *
 * Why this is needed: generateThumbnail() in routes/upload.js extracts a frame
 * with ffmpeg for video and falls back to a flat rgb(18,16,28) square when
 * that fails. ffmpeg was missing from package.json, so extraction failed for
 * every upload and the `catch` silently wrote the placeholder. The result is a
 * valid, 722-byte, entirely blank WebP on every row — HTTP 200, no visible
 * error, nothing rendered.
 *
 * With ffmpeg now declared as a dependency, extraction works, so this script
 * re-derives the thumbnails that were lost. It only touches rows whose current
 * thumbnail is provably blank (zero variance on every channel), so it is safe
 * to re-run and will not overwrite a good image.
 *
 * Audio is skipped by design: an MP3 has no frame to extract, so its
 * placeholder is legitimate. The sound detail page draws generated waveform
 * art instead (client/src/components/AudioHero.jsx).
 *
 * DRY RUN BY DEFAULT — reports what it would change and writes nothing.
 *
 * Run from server/:
 *   ~/.nvm/versions/node/v26.4.0/bin/node scripts/backfill-thumbnails.mjs
 *
 * Apply for real (uploads to Spaces, overwriting the existing thumbnail keys):
 *   APPLY=1 ~/.nvm/versions/node/v26.4.0/bin/node scripts/backfill-thumbnails.mjs
 *
 * Work through it in batches:
 *   APPLY=1 LIMIT=50 ~/.nvm/versions/node/v26.4.0/bin/node scripts/backfill-thumbnails.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffmpeg from 'fluent-ffmpeg'
import { writeFile, readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { spaces, BUCKET } from '../spacesClient.js'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

const APPLY = process.env.APPLY === '1'
const LIMIT = Number.parseInt(process.env.LIMIT ?? '0', 10) || null

const VIDEO_FORMATS = ['MP4', 'WebM']

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

/** A thumbnail is "blank" when no channel varies at all. */
async function isBlank(buffer) {
  try {
    const stats = await sharp(buffer).stats()
    return stats.channels.every((c) => c.stdev < 1)
  } catch {
    return false // unreadable: leave it alone rather than guess
  }
}

async function fetchBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function extractFrame(videoBuffer) {
  const id = randomUUID()
  const inputPath = join(tmpdir(), `${id}-in.mp4`)
  const outputPath = join(tmpdir(), `${id}-out.jpg`)
  try {
    await writeFile(inputPath, videoBuffer)
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .seekInput(1)
        .frames(1)
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })
    return await readFile(outputPath)
  } finally {
    await unlink(inputPath).catch(() => {})
    await unlink(outputPath).catch(() => {})
  }
}

const { data: rows, error } = await sb
  .from('memes')
  .select('id, title, format, thumbnail_url, thumbnail_spaces_key, public_url')
  .in('format', VIDEO_FORMATS)
  .order('download_count', { ascending: false })

if (error) {
  console.error('Query failed:', error.message)
  process.exit(1)
}

const targets = LIMIT ? rows.slice(0, LIMIT) : rows

console.log(`${APPLY ? '' : '[DRY RUN] '}Checking ${targets.length} video rows`)
console.log(`ffmpeg: ${ffmpegInstaller.path}\n`)

let blank = 0
let fixed = 0
let failed = 0
let skipped = 0

for (const row of targets) {
  const label = row.title.slice(0, 44).padEnd(44)
  try {
    const current = await fetchBuffer(row.thumbnail_url)
    if (!(await isBlank(current))) {
      skipped++
      continue
    }
    blank++

    const video = await fetchBuffer(row.public_url)
    const frame = await extractFrame(video)
    const webp = await sharp(frame).resize(600, 600, { fit: 'cover' }).webp({ quality: 80 }).toBuffer()

    if (await isBlank(webp)) {
      console.log(`  ~  ${label} extracted frame is blank too — leaving as is`)
      failed++
      continue
    }

    if (!APPLY) {
      console.log(`  .  ${label} would regenerate (${current.length}b -> ${webp.length}b)`)
      continue
    }

    // Overwrite the same key so thumbnail_url stays valid and no DB write is
    // needed. CDN caches may serve the old blank image until their TTL expires.
    await spaces.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: row.thumbnail_spaces_key,
        Body: webp,
        ContentType: 'image/webp',
        ACL: 'public-read',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
    fixed++
    console.log(`  OK ${label} ${current.length}b -> ${webp.length}b`)
  } catch (err) {
    failed++
    console.log(`  !! ${label} ${err.message}`)
  }
}

console.log(`
${APPLY ? 'Applied' : 'Dry run'} complete
  already fine : ${skipped}
  blank found  : ${blank}
  ${APPLY ? 'regenerated  : ' + fixed : 'would fix    : ' + (blank - failed)}
  failed       : ${failed}
`)

if (!APPLY && blank > 0) {
  console.log('Re-run with APPLY=1 to write these to Spaces.')
}
