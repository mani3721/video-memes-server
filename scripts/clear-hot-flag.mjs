/**
 * Clear the is_hot pin from the 4 pages that were temporarily pinned
 * to ensure Googlebot could reach them from the homepage/category feed
 * while their indexing was being evaluated.
 *
 * Run ONLY after Google Search Console confirms all 4 URLs are indexed:
 *   ~/.nvm/versions/node/v26.4.0/bin/node scripts/clear-hot-flag.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

const IDS = [
  'ec53ed8d-ae1c-40cf-99e0-9e1c4994bfc5',
  '52709905-35dc-4354-8176-0fbc6cb4faa3',
  '278627f8-ac03-4567-a8f9-dc85542a26d2',
  'ccc34809-8ae8-4ee9-8cd8-4aedc48f0bff',
]

const { data, error } = await sb
  .from('memes')
  .update({ is_hot: false })
  .in('id', IDS)
  .select('id, title')

if (error) { console.error('Failed:', error.message); process.exit(1) }
console.log(`Cleared is_hot on ${data?.length ?? 0} records:`)
for (const r of data ?? []) console.log(`  ${r.id}  "${r.title}"`)
