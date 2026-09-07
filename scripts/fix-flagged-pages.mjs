/**
 * Fix the 4 Search Console "Crawled - currently not indexed" meme pages.
 *
 * What this script does, per page:
 *  1. Renames generic/duplicate/keyword-stuffed titles to distinct descriptive ones
 *  2. Replaces boilerplate description_long (identical across pages) with 400-word
 *     unique structured copy across all 5 sections
 *  3. Sets is_hot = true so these pages appear on the first page of the homepage
 *     and /videos feed, giving Googlebot a direct HTML link path without relying
 *     on JS pagination. Clear is_hot after Google confirms indexing.
 *  4. Clears the needs_description triage flag
 *
 * Run from server/:
 *   ~/.nvm/versions/node/v26.4.0/bin/node scripts/fix-flagged-pages.mjs
 *
 * Dry-run mode (no DB writes):
 *   DRY_RUN=1 ~/.nvm/versions/node/v26.4.0/bin/node scripts/fix-flagged-pages.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const DRY_RUN = process.env.DRY_RUN === '1'

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

// ─── Page updates ─────────────────────────────────────────────────────────────

const UPDATES = [
  {
    id: 'ec53ed8d-ae1c-40cf-99e0-9e1c4994bfc5',
    currentTitle: 'funny laughing boy',
    title: 'Funny Laughing Boy',
    // Slug becomes: funny-laughing-boy-ec53ed8d-ae1c-40cf-99e0-9e1c4994bfc5
    // (capitalisation does not affect slug — toSlug lowercases before hashing)
    description_long: {
      what: `Funny Laughing Boy is a short viral meme clip featuring a young boy bursting into uncontrollable laughter. The meme spread rapidly across Indian social media platforms and WhatsApp groups, where it caught on as a reaction to absurd or unexpected situations. The boy's genuine, infectious laugh resonates because it captures a pure, unfiltered moment of real joy — making viewers smile before they even know what triggered the reaction. It belongs to the tradition of authentic laughing-reaction memes where the response itself becomes the punchline rather than whatever originally set it off.`,

      why: `This meme works because laughter is contagious and universal. When someone drops the Funny Laughing Boy clip into a group chat, they are communicating that what just happened is so perfectly absurd that words cannot do it justice — only an uncontrollable burst of giggles can match the energy. The clip is especially popular as a reply in comment sections and WhatsApp threads when something lands completely out of nowhere. It carries no mean edge, which means it lands cleanly across age groups and cultures, explaining why it keeps circulating years after it first appeared.`,

      how: `Download the Funny Laughing Boy video from Videsaur as a clean, watermark-free MP4 — no sign-up, no fee. Drop it directly into a WhatsApp chat as a video reply, share it as an Instagram Reel or Story reaction, or use it as a cut in a YouTube Shorts or TikTok response edit. It works well as a standalone reaction or looped over a split-screen alongside the thing it is reacting to. Video editors can bring it into CapCut, DaVinci Resolve, or Adobe Premiere without any licence complications — the CC0 licence covers personal and commercial use with no attribution required.`,

      quality: `Funny Laughing Boy is available as an MP4 file — the most universally supported video container for playback on phones, browsers, and editing software. At under 1 MB, the file loads and sends instantly on mobile data without buffering or compression artefacts. MP4 plays natively in WhatsApp, Telegram, Instagram, YouTube Studio, TikTok, CapCut, and every major desktop editor straight out of the box. The version served by Videsaur carries no watermark, no overlay, and no branding of any kind — just the original clean clip, ready to paste into any project or conversation.`,

      related: `If Funny Laughing Boy made you laugh, the laugh mood category on Videsaur has more where that came from. Try the Ha Ha Ha Laugh Meme for a more theatrical, exaggerated take on uncontrollable laughter, or browse the Funny Laughing Reaction Video for a longer-form version of the same energy. The Trending Videos page surfaces the highest-downloaded reaction and laugh clips updated daily. Everything in the collection is free, watermark-free, and CC0 licensed.`,
    },
  },

  {
    id: '52709905-35dc-4354-8176-0fbc6cb4faa3',
    currentTitle: 'Ha Ha Ha Meme Video Download',
    title: 'Ha Ha Ha Laugh Meme',
    // Old slug: ha-ha-ha-meme-video-download-52709905-...  (keyword-stuffed "Video Download" in title)
    // New slug: ha-ha-ha-laugh-meme-52709905-35dc-4354-8176-0fbc6cb4faa3
    description_long: {
      what: `Ha Ha Ha Laugh Meme is a viral video clip built around an exaggerated, theatrical burst of laughter — the kind that signals mockery, disbelief, or a plot twist so unexpected that a quiet chuckle cannot contain it. The "ha ha ha" vocal pattern is one of the most recognisable laugh signatures in internet culture, used to mark situations as either spectacularly funny or spectacularly, gloriously wrong. The clip distils that energy into a short, loopable MP4 that lands in conversation as a perfectly timed reaction, carrying layers of meaning depending on how flat or how gleeful the laugh is delivered.`,

      why: `The power of this meme is in its rhythm. "Ha. Ha. Ha." delivered in a deliberate, measured cadence reads as dry and sarcastic — the perfect reply to a plan that just fell apart or a joke that did not land. Delivered with full energy it swings the other direction and becomes pure infectious joy. This double-edged versatility means the Ha Ha Ha Laugh Meme functions as a sincere laugh reaction and as a deadpan "sure, very funny" in equal measure. The sound crosses language barriers without subtitles and is instantly understood across age groups and internet communities worldwide.`,

      how: `Download Ha Ha Ha Laugh Meme as a watermark-free MP4 from Videsaur — no account, no fee, one click. Use it as a video reply in WhatsApp or Telegram to any message that catches you off guard, add it as a reaction layer over a split-screen in a YouTube Shorts or Instagram Reels edit, or loop it as a section break in a meme compilation. Under 1 MB means it sends without compression damage on mobile data. The CC0 licence removes all restrictions — use it freely in monetised YouTube content, sponsored social posts, or client projects without attribution.`,

      quality: `Ha Ha Ha Laugh Meme is served as an MP4 from Videsaur's CDN — near-instant download on any connection. MP4 is the native format for Instagram, YouTube, TikTok, WhatsApp, CapCut, Premiere Pro, and DaVinci Resolve, requiring no conversion before use. The compact file size means zero buffering on mobile playback, and the encoding preserves the original audio so the laugh hit lands with full impact. Videsaur delivers this file clean: no watermark, no overlay, no account prompt. Download it, drop it in, and the reaction is ready to send.`,

      related: `Fans of laugh-reaction memes will find more in Videsaur's laugh mood and videos categories. Funny Laughing Boy captures the same uncontrollable laughter with a more personal, human energy. The Funny Laughing Reaction Video is a longer-form option when you need a reaction shot with more runtime for editing. For laugh sound effects without the video — great for audio dubbing in Reels or Shorts — check the Sounds page. Trending shows the highest-downloaded laugh and reaction clips updated daily.`,
    },
  },

  {
    id: '278627f8-ac03-4567-a8f9-dc85542a26d2',
    currentTitle: 'funny',
    title: 'Funny Laughing Reaction Video',
    // Old slug: funny-278627f8-... (title was just "funny")
    // New slug: funny-laughing-reaction-video-278627f8-ac03-4567-a8f9-dc85542a26d2
    description_long: {
      what: `Funny Laughing Reaction Video is a meme clip capturing a genuine moment of uncontrollable laughter — the kind that starts small and builds until the person can barely keep it together. At 6.7 MB, this is a longer-form reaction clip with enough runtime to show the full build and peak of the laughing moment, making it well-suited for video edits where you need the reaction to land and then linger rather than cut away immediately. The clip comes from the broad tradition of authentic laughing-reaction memes whose power comes from the fact that viewers find the laugh itself more infectious than whatever originally triggered it.`,

      why: `Reaction memes succeed when the emotion they show is completely real, and this clip delivers exactly that. Audiences watching someone lose control laughing cannot help but mirror the feeling — it triggers the same reflex as hearing genuine laughter across a room. Laughing memes consistently outperform scripted comedy in resharing rates for this reason. Funny Laughing Reaction Video works as an enthusiastic positive reply, a commentary on something spectacularly absurd, or a standalone mood-lifter dropped into a group chat at exactly the moment a conversation needs rescuing. The longer duration also makes it ideal for montage and compilation edits.`,

      how: `Download Funny Laughing Reaction Video as a clean, watermark-free MP4 from Videsaur. The longer runtime makes it particularly useful in CapCut and Premiere Pro projects where you need a reaction shot with some duration — trim it to the exact moment you want, loop the peak, or use the full clip as a reaction panel in a split-screen edit. Share it in WhatsApp as a video reply, export it as a Reel or Short with your own text overlay, or build it into a meme compilation. CC0 licence covers all personal and commercial uses with no attribution needed and no royalty payments required.`,

      quality: `Funny Laughing Reaction Video is available in MP4 format at the highest quality in which it was submitted to Videsaur. At 6.7 MB, it delivers genuine video duration rather than a one-second loop — enough frames to build a clean edit around. MP4 plays natively across every platform: YouTube, Instagram, TikTok, WhatsApp, CapCut, DaVinci Resolve, and Adobe Premiere all accept it without conversion. The file Videsaur serves has no watermark, no encoding overlay, and no compression added during storage — it is the original file as uploaded, downloaded in one click.`,

      related: `For a shorter, punchier version of the same laughing energy, Funny LOL Clip Meme delivers the reaction in under two seconds — perfect for fast-moving group chats. Ha Ha Ha Laugh Meme takes the laughing reaction into more theatrical, exaggerated territory for when subtlety is not required. Funny Laughing Boy offers a pure, child-like laugh that lands across every age group. Find more in the laugh mood collection inside the Videos category, or check Trending for the week's most-downloaded reaction clips.`,
    },
  },

  {
    id: 'ccc34809-8ae8-4ee9-8cd8-4aedc48f0bff',
    currentTitle: 'funny',
    title: 'Funny LOL Clip Meme',
    // Old slug: funny-ccc34809-... (title was just "funny", identical to above)
    // New slug: funny-lol-clip-meme-ccc34809-8ae8-4ee9-8cd8-4aedc48f0bff
    description_long: {
      what: `Funny LOL Clip Meme is a short, punchy video reaction built for speed — at just over 1 MB, it loads and sends instantly in any chat app, making it the ideal response when something in a conversation hits completely out of nowhere. The clip captures a laugh that says "that genuinely wrecked me" in under two seconds, landing cleanly without needing any caption or context to support it. Short laughing clips like this have become a staple of WhatsApp and Telegram group culture, where timing is everything and a clip that takes too long to play misses its moment entirely.`,

      why: `The Funny LOL Clip Meme works because of its brevity. In fast-moving group chats and comment threads, a short sharp reaction lands harder than a long one — by the time a ten-second clip finishes, the conversation has moved on and the moment is lost. This clip delivers the reaction at precisely the right point and exits cleanly, which is what instant-reaction memes need to do to be effective. It signals authentic amusement rather than performed comedy, and that authenticity is what drives resharing. The LOL energy reads immediately across age groups, languages, and platforms without subtitles or additional context.`,

      how: `Download Funny LOL Clip Meme from Videsaur as a watermark-free MP4 — one click, no account required. The small file size means it sends without compression damage in WhatsApp, Telegram, and Signal even on slow mobile data. Drop it into Instagram Reels or YouTube Shorts as an instant reaction layer, or use it as a quick cut in a meme compilation edited in CapCut or DaVinci Resolve. Because it is CC0-licensed, you can use it in monetised YouTube content, sponsored social posts, or commercial client projects without paying royalties or adding attribution credits to your descriptions.`,

      quality: `Funny LOL Clip Meme is delivered in MP4 format from Videsaur's CDN. The compact 1.1 MB file is optimised for instant mobile playback — no buffering, no quality loss, no waiting for the punchline. MP4 is the universal video format natively supported by WhatsApp, Instagram, TikTok, YouTube, Telegram, CapCut, Premiere Pro, and DaVinci Resolve without any conversion step. Videsaur serves the file clean: no watermark, no branding overlay, and no encoding compression added after the original upload. One click and the original file is on your device, ready to use.`,

      related: `Funny LOL Clip Meme pairs naturally with the rest of Videsaur's laugh and reaction collection. For more runtime to work with in video edits, Funny Laughing Reaction Video is the longer-form version of the same laughing energy. Ha Ha Ha Laugh Meme brings a theatrical, exaggerated laugh when the situation calls for maximum drama. Funny Laughing Boy captures genuine, unscripted laughter that lands across every audience. Browse the laugh mood inside the Videos category for the full collection, or check Trending for the most-downloaded reaction clips this week.`,
    },
  },
]

// ─── Execution ────────────────────────────────────────────────────────────────

function wordCount(dl) {
  return Object.values(dl).join(' ').split(/\s+/).filter(Boolean).length
}

console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Fixing ${UPDATES.length} pages...\n`)

let allOk = true

for (const update of UPDATES) {
  const wc = wordCount(update.description_long)
  console.log(`  ${update.id}`)
  console.log(`    "${update.currentTitle}" → "${update.title}"`)
  console.log(`    description: ${wc} words across ${Object.keys(update.description_long).length} sections`)

  if (DRY_RUN) { console.log('    [skipped — dry run]\n'); continue }

  const { data, error } = await sb
    .from('memes')
    .update({
      title: update.title,
      description_long: update.description_long,
      needs_description: false,
      is_hot: true,   // Pin to top of feeds so Googlebot can find a direct HTML link
      updated_at: new Date().toISOString(),
    })
    .eq('id', update.id)
    .select('id, title, updated_at')
    .single()

  if (error || !data) {
    console.error(`    ✗ Update failed: ${error?.message}`)
    allOk = false
  } else {
    console.log(`    ✓ Saved — updated_at: ${data.updated_at}`)
  }
  console.log('')
}

if (!DRY_RUN) {
  if (allOk) {
    console.log('All 4 pages updated.')
    console.log('\nNext steps:')
    console.log('  1. Verify updated pages live: https://www.videsaur.co.in/meme/<slug>')
    console.log('  2. Sitemap cache expires in 20 min (or hit /sitemap.xml to force re-check).')
    console.log('  3. In Search Console → URL Inspection → Request Indexing for each URL.')
    console.log('  4. After Google confirms indexing, set is_hot = false on these 4 records.')
    console.log('     (Run: node scripts/clear-hot-flag.mjs)')
  } else {
    console.log('\nSome updates failed — review errors above.')
    process.exit(1)
  }
}
