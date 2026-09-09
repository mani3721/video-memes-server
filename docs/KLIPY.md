# KLIPY Sticker API integration

Powers the `/stickers` tab. All upstream calls happen in
[`server/routes/stickers.js`](../routes/stickers.js); the browser only ever
talks to `/api/stickers/*`.

Docs: <https://docs.klipy.com/stickers-api/stickers-trending-api>

## Setup

1. Create a platform at <https://partner.klipy.com> → **API Keys**.
2. Put the app key in `server/.env` as `KLIPY_API_KEY` (no `VITE_` prefix —
   that would compile it into the browser bundle).
3. Restart the server. Without the key every `/api/stickers/*` route answers
   `503 KLIPY_NOT_CONFIGURED` and the page shows a plain "not switched on yet"
   message rather than an error cascade.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KLIPY_API_KEY` | — | App key. Required. |
| `KLIPY_MAX_CALLS_PER_HOUR` | `80` | Upstream budget, kept under the test-tier cap of 100. |
| `KLIPY_TRENDING_TTL_MS` | `1200000` (20 min) | Trending cache lifetime. |
| `KLIPY_SEARCH_TTL_MS` | `300000` (5 min) | Per-term search cache lifetime. |
| `KLIPY_CONTENT_FILTER` | `high` | `off` \| `low` \| `medium` \| `high`. |

## Endpoints we expose

```
GET  /api/stickers/trending?page&per_page&locale&customer_id
GET  /api/stickers/search?q=&page&per_page&locale&customer_id
POST /api/stickers/share/:slug        body: { customer_id, q }
```

Responses are the KLIPY payload passed through untouched:
`{ result, data: { data: [...], current_page, per_page, has_next } }`.
Each item carries `id`, `slug`, `title`, `tags`, `blur_preview` and a
`file.{hd,md,sm,xs}.{gif,webp,webm,png}` tree of `{url,width,height,size}`.

Diagnostic response headers: `X-Cache`
(`HIT` / `MISS` / `COALESCED` / `STALE-BUDGET` / `STALE-ERROR`),
`X-Cache-Age` (seconds), `X-Klipy-Budget-Remaining`.

## Rate-limit safety

The **test tier allows 100 requests per hour**, not per minute. Four layers
keep us underneath it:

1. **Cache** — trending 20 min, search 5 min per normalised term. Trending is
   identical for every visitor, so the whole audience costs ~3 upstream calls
   an hour per locale/page.
2. **In-flight coalescing** — N simultaneous cold requests for the same key
   make one upstream call, not N. This is what a cold start after a deploy
   would otherwise cost.
3. **Rolling-hour budget** — hard cap of `KLIPY_MAX_CALLS_PER_HOUR` upstream
   calls. Past that, requests degrade to stale cache (kept up to 6 hours) and
   only fail with `429 BUDGET_EXHAUSTED` if there is nothing cached at all.
4. **Per-IP limiter** — 40 req/min on `/api/stickers` in `server/index.js`,
   so one client cannot burn the shared budget on unique search terms.

**Before launch:** request Production access in the Partner Panel. Until then
the tab should stay behind whatever gating you are comfortable with — 80
calls/hour is fine for development and for a low-traffic soft launch, but a
real audience hitting varied search terms will exhaust it.

## Compliance notes

Read <https://docs.klipy.com/integration-requirements> in full. Two clauses
bear directly on how this is built:

- **§3 "Send requests from the end-user client"** — KLIPY expects API calls to
  originate from the browser, and says routing them "through partner-operated
  servers, proxies, CDNs, or other intermediaries" needs *prior written
  approval*. This integration is a server-side proxy, deliberately, so the app
  key is never exposed client-side. **Email developers@klipy.com for written
  approval of the proxy before going live**, alongside the Production access
  request.
- **§2 / "Approved Caching Integrations"** — the same clause covers caching.
  We cache only the JSON metadata, never the media (images load straight from
  `static.klipy.com` in the visitor's browser and are never mirrored), but the
  approval email should say so explicitly.

What the code already does to stay inside the other clauses:

- §1 Media URLs are passed through verbatim, query parameters intact.
- §4 Results are rendered in the order KLIPY returned them; nothing is
  reordered, filtered or removed client-side.
- §5 Stickers live in their own tab and are never mixed with library assets.
- §6 `POST /share/:slug` keeps KLIPY's share signal intact.

### Attribution

<https://docs.klipy.com/attribution>. One item is REQUIRED:

- ✅ **"Search KLIPY" as the default search placeholder** — implemented in
  `client/src/pages/StickersPage.jsx`. "Search stickers" is the field's
  accessible name so screen-reader users still get a plain description.
- ✅ "Powered by KLIPY" mark (optional) — rendered under the search bar.
  **TODO:** swap the text wordmark for the official logo asset from the Drive
  folder linked in their attribution page.
- ⬜ Watermark on shared content cards (optional) — not implemented.

### Localisation

`locale` is an **ISO 3166-1 alpha-2 country code**, not a language tag. KLIPY
localises *search* from the script of the query itself; `locale` biases region.

**Tamil is not in KLIPY's supported language list** (they cover Hindi, Bengali
and Urdu, not Tamil — see <https://docs.klipy.com/migrate-from-tenor/localization>),
so Tamil-localised sticker results are not available from this provider today.
`client/src/hooks/useStickers.js` maps `ta → in` as the closest honest
approximation and `en → us`; anything unmapped sends no `locale`, which lets
KLIPY geo-detect.
