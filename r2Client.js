import { S3Client } from '@aws-sdk/client-s3'

if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  throw new Error('Missing required R2 environment variables. Check your .env file against .env.example.')
}

export const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

export const BUCKET = process.env.R2_BUCKET_NAME
export const PUBLIC_URL = process.env.R2_PUBLIC_URL
