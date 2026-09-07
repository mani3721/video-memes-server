/**
 * Quick sanity-check: show the current state of the 4 fixed pages.
 * Run: ~/.nvm/versions/node/v26.4.0/bin/node scripts/find-flagged-pages.mjs
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

function wc(dl) {
  if (!dl || typeof dl !== 'object') return 0
  return Object.values(dl).join(' ').split(/\s+/).filter(Boolean).length
}

const { data, error } = await sb
  .from('memes')
  .select('id, title, is_hot, needs_description, description_long, updated_at')
  .in('id', IDS)
  .order('updated_at', { ascending: true })

if (error) { console.error(error); process.exit(1) }

for (const r of data ?? []) {
  const slug = r.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
  console.log(`\n${r.id}`)
  console.log(`  title:    "${r.title}"`)
  console.log(`  slug:     /meme/${slug}-${r.id}`)
  console.log(`  is_hot:   ${r.is_hot}`)
  console.log(`  needs_d:  ${r.needs_description}`)
  console.log(`  words:    ${wc(r.description_long)} across ${r.description_long ? Object.keys(r.description_long).length : 0} sections`)
  console.log(`  updated:  ${r.updated_at}`)
}
