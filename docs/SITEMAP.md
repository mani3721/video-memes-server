# Sitemaps

The sitemap is generated on demand from Supabase. There is no build step and no
file to regenerate: publishing, retitling or removing an asset is reflected on
the next request.

## Why the API server, not the build

The previous implementation was `client/scripts/generate-sitemap.mjs`, which ran
at build time and read a `ASSETS` array from `src/data/assets.js`. That array was
removed when the catalogue moved to Supabase, so the generator silently emitted
zero content URLs while `client/public/sitemap.xml` kept serving 480 stale
mock-data URLs (`/meme/cat-slams-laptop-shut-a1`) that soft-404 to the homepage.
Both files have been deleted.

Generating at request time in the API server also puts the generator in the same
process as the routes that change content, so publish/delete can invalidate the
cache directly rather than through a webhook.

## Request path

Crawlers must fetch sitemaps from the canonical origin, but the generator lives
on the API host. `client/vercel.json` bridges the two:

```
crawler → videsaur.co.in/sitemap-memes.xml
        → (Vercel rewrite) api-videsaur.onrender.com/sitemap-memes.xml
        → routes/sitemap.js → cache → generator → Supabase
```

> **Do not add `public/sitemap.xml` back.** Vercel checks the filesystem
> *before* applying rewrites, so a static file at that path silently wins over
> the rewrite and you are back to serving a stale sitemap.

## Files

| URL | Contents |
| --- | --- |
| `/sitemap.xml` | Index listing every file below |
| `/sitemap-pages.xml` | Static pages (home, trending, category feeds, policies) |
| `/sitemap-memes.xml` | `category = videos` |
| `/sitemap-gifs.xml` | `category = gifs` |
| `/sitemap-audio.xml` | `category = sounds` |
| `/sitemap-templates.xml` | `category = images` |

`sitemap-templates.xml` is not in the original spec, which named memes, gifs and
audio. It exists because the `images` category (meme templates, the `/templates`
feed) is real published content and would otherwise have been silently dropped
from the sitemap entirely.

### Pagination

The sitemaps protocol caps one file at 50,000 URLs / 50 MB. Past
`MAX_URLS_PER_FILE` (45,000, leaving headroom) a group splits automatically into
`sitemap-memes-1.xml`, `sitemap-memes-2.xml`, … and the index lists every page.
A single-page group keeps the unsuffixed name. Requesting a page beyond the end
returns 404 rather than an empty `<urlset>`, which would read to a crawler as
"every URL in this group was removed".

Rows are ordered by `created_at ASC, id ASC`. Ascending is deliberate: new
uploads append to the *last* page, so earlier pages stay byte-stable and
crawlers do not have to re-fetch the whole set after every upload. Descending
order would reshuffle every page on every upload.

## Per-URL metadata

- **`<loc>`** — built by `lib/sitemap/urls.js`, which mirrors
  `client/src/utils/seo.js`. These two must agree byte for byte; if a sitemap URL
  differs from the canonical the page renders, Google discards the sitemap URL as
  a duplicate. Change them together.
- **`<lastmod>`** — `max(created_at, updated_at)`. The `memes_updated_at` trigger
  maintains `updated_at`, so an admin retitle moves lastmod forward and prompts a
  recrawl.
- **`<changefreq>` / `<priority>`** — trending (`download_count >=`
  `TRENDING_DOWNLOADS`) → `daily` / `0.9`; uploaded within `RECENT_WINDOW_DAYS`
  → `daily` / `0.8`; otherwise `weekly` / `0.5`. Priority is only meaningful
  relative to other URLs on the same site, so `1.0` is reserved for the homepage.

Listing pages in `sitemap-pages.xml` take their `lastmod` from the newest asset
in the categories they display. Policy and copy pages use `POLICY_LASTMOD` —
bump it when that copy actually changes. Reporting today's date on every request
would tell crawlers the terms page changes daily and train them to ignore
`lastmod` altogether.

## Media tags

- **Video** (`MP4`, `WebM`) gets `<video:video>` with `thumbnail_loc`, `title`,
  `description`, `content_loc` and `duration`. `content_loc` is the CDN object
  URL, never the page: Google requires a directly fetchable stream there.
  `player_loc` is omitted because there is no embed page — the spec requires one
  of the two, not both.
- **GIFs and images** get `<image:image>`. A GIF is *not* valid in a video
  sitemap (`content_loc` must be a real video stream), so the format is
  re-checked per row and degrades to an image entry even inside a group declared
  as video.
- **Audio** gets a plain `<url>`. There is no audio counterpart to the video
  sitemap extension, so discovery relies on schema.org `AudioObject` markup on
  the page itself — see `buildAudioSchema` in `client/src/utils/seo.js`. Before
  this change, MP3/WAV pages emitted `ImageObject`, describing a sound download
  as an image.

Only namespaces a file actually uses are declared, since these files are
size-capped.

## Caching

Three layers, outermost first:

1. **Vercel edge** — governed by the origin's `s-maxage` (Vercel's
   `respectOriginCacheControl` defaults to true). This is what shields the
   Render instance from crawler traffic and cold starts.
2. **Origin in-process cache** (`lib/sitemap/cache.js`) — `CACHE_TTL_MS`,
   default 20 minutes. Also does:
   - **single-flight**: concurrent misses for one file share a single build, so a
     crawler opening six parallel connections after an expiry does not fire six
     identical multi-query builds;
   - **serve-stale-on-error**: if a rebuild throws but a previous copy exists,
     the old copy is served. A slightly stale sitemap beats a 503, which Search
     Console records as a fetch error against the whole sitemap;
   - **gzip at build time**: one compression per build, not per request. A
     45,000-URL file with video tags is tens of MB uncompressed and every crawler
     sends `Accept-Encoding: gzip`.
3. **Warmer** (`lib/sitemap/scheduler.js`) — rebuilds the index, the pages file
   and page 1 of each group every `CACHE_TTL_MS * 0.9`, so a crawler never pays
   the build cost. Measured on the current catalogue: ~3.9 s cold, ~3 ms warm.

### Invalidation

`onContentChanged()` in `lib/sitemap/notify.js` is the single hook. It clears the
cache and fires IndexNow. Called from:

| Route | Why |
| --- | --- |
| `POST /api/upload` | uploads publish immediately |
| `POST /api/admin/approve/:id` | publishing is what makes a page indexable |
| `DELETE /api/admin/reject/:id` | drop the URL before crawlers hit a 404 |
| `PATCH /api/admin/rename/:id` | the title is part of the slug, so the URL moves |
| `POST /api/admin/sitemap/refresh` | manual escape hatch |

The whole cache is cleared rather than single entries: one upload can add a page
to a group *and* change the index's file list, so there is no useful partial
invalidation.

Because a publish clears only the origin cache, the edge can still serve a
cached copy for up to `s-maxage`. Total worst-case staleness is one TTL, which
is inside the 15–30 minute window this was specified for. IndexNow is the
immediate path for individual URLs; the sitemap is the bulk backfill.

**Scope limit:** the cache is per process. Running more than one server instance
means a publish only invalidates the instance that handled it; the others
correct themselves within one TTL. That bounded staleness is the trade-off for
not introducing a shared cache dependency.

## Exclusions

A URL is listed only if it renders a live, canonical, indexable page:

- `is_published = true`
- `is_flagged = false` (DMCA / policy takedowns)
- Not an admin, auth or per-user page. `/admin`, `/login`, `/upload` and
  `/favorites` are absent from `STATIC_PAGES` and `Disallow`ed in `robots.txt`.
- Search result pages (`/?q=`) are excluded as thin duplicates of the feeds.

`is_flagged` comes from `db/migrations/002_sitemap_moderation.sql`, which also
adds a matching partial index and tightens the RLS `SELECT` policy so a flagged
asset stops being publicly readable — otherwise a takedown would remove the URL
from the sitemap while leaving the page live.

**The generator probes for the column at boot** and falls back to filtering on
`is_published` alone if the migration has not been applied, logging a warning
each start. So the deploy order does not matter, but until you run the migration
the only takedown path is the hard delete in `DELETE /api/admin/reject`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SITE_ORIGIN` | `https://videsaur.co.in` | Origin used in every `<loc>`. Must match `BASE_URL` in the client. |
| `SITEMAP_CACHE_TTL_MS` | `1200000` (20 min) | Cache TTL, clamped to 1 min – 24 h. |
| `SITEMAP_MAX_URLS` | `45000` | URLs per file, clamped to ≤ 50,000. |
| `SITEMAP_RECENT_DAYS` | `30` | "Recently uploaded" window. |
| `SITEMAP_TRENDING_DOWNLOADS` | `500` | `download_count` that counts as trending. |
| `SITEMAP_POLICY_LASTMOD` | `2026-09-01` | `lastmod` for hand-written copy pages. |
| `SITEMAP_WARM` | *(on)* | Set `false` to disable the warmer (useful locally). |
| `INDEXNOW_KEY` | *(unset)* | 8–128 hex chars. Unset = IndexNow no-ops. |
| `TRUST_PROXY` | `1` | Proxy hops to trust for client IPs. |

## Search engine submission

**Both classic sitemap ping endpoints are gone.** Google retired
`google.com/ping?sitemap=` (announced June 2023, now 404) and Bing's
`bing.com/ping` returns 410 Gone. Code that calls them is dead code. So:

### Google — manual, once
Search Console → *Sitemaps* → submit `https://videsaur.co.in/sitemap.xml`.
Submit the **index only**; Google discovers the sub-sitemaps from it and
re-fetches on its own schedule. There is no push API. Resubmit only after a
structural change (a new group, a change to the file naming).

### Bing — manual once, then automatic
Bing Webmaster Tools → *Sitemaps* → submit the same index URL. After that,
IndexNow handles per-URL notification.

### IndexNow — automatic
Covers Bing and Yandex. To enable:

1. Generate a key: `openssl rand -hex 16`
2. Set `INDEXNOW_KEY` on the API service.
3. Confirm `https://videsaur.co.in/indexnow.txt` returns the key — IndexNow
   verifies host ownership by reading it, which is why the Vercel rewrite for
   that path exists. The key is public by design; it proves control of the host
   and is not a secret.

Every publish, retitle and takedown then submits the affected URLs
automatically. A rename submits both the old and new URL, so the outgoing slug
gets recrawled and picks up the new canonical.

## Operations

```bash
# What the crawler sees
curl -s https://videsaur.co.in/sitemap.xml

# Cache state, hit/miss counters, IndexNow status  (admin JWT required)
curl -H "Authorization: Bearer $TOKEN" \
  https://api-videsaur.onrender.com/api/admin/sitemap/status

# Force a rebuild — needed after editing STATIC_PAGES or a direct DB change
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://api-videsaur.onrender.com/api/admin/sitemap/refresh
```

Failure modes: a file that cannot be built returns **503** with `Retry-After`
(retryable in Search Console) rather than 500; an unknown group or an
out-of-range page returns **404**.

## Known gaps

These limit the media tags' effectiveness and are upstream of the sitemap:

- **Video thumbnails are placeholders.** `routes/upload.js` has no ffmpeg, so
  video and audio uploads get a flat grey 600×600 WebP. `video:thumbnail_loc` is
  required and Google may reject a video entry whose thumbnail does not depict
  the video, so video rich results are unlikely until real frames are extracted.
- **`duration_seconds` is never populated** for uploads, so `<video:duration>`
  and the schema.org `duration` are omitted. Both are optional, but duration is
  one of the fields that earns a richer video result.
