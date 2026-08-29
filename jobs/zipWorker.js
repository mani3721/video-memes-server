/**
 * In-memory bulk-zip job queue — used by the background-job variant of bulk download.
 *
 * NOTE: The primary bulk-download route (routes/bulkDownload.js) now streams
 * the ZIP directly.  This worker is kept for cases where you want to offload
 * large zips to a background process and return a presigned download URL.
 *
 * For production at scale replace this with BullMQ + Redis.
 * Jobs expire from memory after JOB_TTL_MS (6 hours).
 */

import { Readable } from 'node:stream'
import archiver from 'archiver'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { spaces, BUCKET } from '../spacesClient.js'

const JOB_TTL_MS = 6 * 60 * 60 * 1000   // 6 hours
const ZIP_PRESIGN_TTL_S = 3600            // 1 hour

const jobs = new Map()

/** @returns {{ status: 'pending'|'ready'|'error', url?: string } | undefined} */
export function getJob(jobId) {
  return jobs.get(jobId)
}

/**
 * Kick off a zip job in the background.  Returns immediately.
 * Poll getJob(jobId) until status !== 'pending'.
 *
 * @param {string}   jobId
 * @param {string[]} keys   Spaces object keys to include
 */
export function enqueueZipJob(jobId, keys) {
  jobs.set(jobId, { status: 'pending' })
  runZipJob(jobId, keys).catch((err) => {
    console.error(`[zipWorker] job ${jobId} failed:`, err.message)
    jobs.set(jobId, { status: 'error', error: err.message })
    scheduleExpiry(jobId)
  })
}

async function runZipJob(jobId, keys) {
  const zipBuffer = await buildZip(keys)

  const zipKey = `temp-zips/${jobId}.zip`
  await spaces.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: zipKey,
      Body: zipBuffer,
      ContentType: 'application/zip',
      ContentDisposition: `attachment; filename="videsaur-${jobId.slice(0, 8)}.zip"`,
      // Do NOT set ACL public-read on temp zips — presigned URL provides time-limited access
    }),
  )

  const url = await getSignedUrl(
    spaces,
    new GetObjectCommand({ Bucket: BUCKET, Key: zipKey }),
    { expiresIn: ZIP_PRESIGN_TTL_S },
  )

  jobs.set(jobId, { status: 'ready', url })
  scheduleExpiry(jobId)
}

async function buildZip(keys) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const archive = archiver('zip', { zlib: { level: 6 } })

    archive.on('data', (chunk) => chunks.push(chunk))
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err) })
    archive.on('error', reject)
    archive.on('finish', () => resolve(Buffer.concat(chunks)))

    // Append files sequentially — archiver handles backpressure
    ;(async () => {
      for (const key of keys) {
        try {
          const { Body } = await spaces.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
          const nodeStream = Readable.fromWeb(Body)
          archive.append(nodeStream, { name: key.split('/').pop() })
          // Wait for each entry to drain before adding the next
          await new Promise((res) => nodeStream.once('end', res))
        } catch (err) {
          console.error(`[zipWorker] skipping ${key}:`, err.message)
        }
      }
      archive.finalize()
    })().catch(reject)
  })
}

function scheduleExpiry(jobId) {
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS)
}
