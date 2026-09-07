/**
 * Ping IndexNow for the 4 newly fixed meme pages + their old canonical URLs
 * (so Bing/Yandex recrawl both old and new slugs and follow the canonical).
 *
 * Run: ~/.nvm/versions/node/v26.4.0/bin/node scripts/ping-indexnow.mjs
 */

import 'dotenv/config'
import { submitToIndexNow, indexNowStatus } from '../lib/sitemap/indexnow.js'

const ORIGIN = 'https://www.videsaur.co.in'

const URLS = [
  // New canonical slugs (post-rename)
  `${ORIGIN}/meme/funny-laughing-boy-ec53ed8d-ae1c-40cf-99e0-9e1c4994bfc5`,
  `${ORIGIN}/meme/ha-ha-ha-laugh-meme-52709905-35dc-4354-8176-0fbc6cb4faa3`,
  `${ORIGIN}/meme/funny-laughing-reaction-video-278627f8-ac03-4567-a8f9-dc85542a26d2`,
  `${ORIGIN}/meme/funny-lol-clip-meme-ccc34809-8ae8-4ee9-8cd8-4aedc48f0bff`,
  // Old slugs — so crawlers re-visit, see canonical, and stop indexing old URLs
  `${ORIGIN}/meme/ha-ha-ha-meme-video-download-52709905-35dc-4354-8176-0fbc6cb4faa3`,
  `${ORIGIN}/meme/funny-278627f8-ac03-4567-a8f9-dc85542a26d2`,
  `${ORIGIN}/meme/funny-ccc34809-8ae8-4ee9-8cd8-4aedc48f0bff`,
  // Category and homepage to prompt feed recrawl
  `${ORIGIN}/`,
  `${ORIGIN}/videos`,
]

const status = indexNowStatus()
console.log('IndexNow status:', status)

if (!status.enabled) {
  console.log('\nIndexNow not configured — skipping submission.')
  console.log('Set INDEXNOW_KEY in server/.env to enable.')
  process.exit(0)
}

const result = await submitToIndexNow(URLS)
console.log(`\nSubmitted ${result.submitted} / ${URLS.length} URLs`)
if (result.skipped) console.log('Skipped:', result.skipped)
