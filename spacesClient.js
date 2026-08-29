import { S3Client } from '@aws-sdk/client-s3'

const required = ['DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET', 'DO_SPACES_ENDPOINT', 'DO_SPACES_CDN_URL']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  throw new Error(`Missing required DO Spaces env vars: ${missing.join(', ')}`)
}

/**
 * DigitalOcean Spaces is S3-compatible — we use the AWS SDK v3 pointed at
 * the Spaces regional endpoint.  ACL is set per-upload to 'public-read'.
 */
export const spaces = new S3Client({
  region: process.env.DO_SPACES_REGION ?? 'us-east-1',
  endpoint: process.env.DO_SPACES_ENDPOINT,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
  },
  forcePathStyle: false, // Spaces uses virtual-hosted style (bucket.endpoint)
})

export const BUCKET = process.env.DO_SPACES_BUCKET
export const CDN_URL = process.env.DO_SPACES_CDN_URL.replace(/\/$/, '')
