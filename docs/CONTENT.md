# Content model & admin editing

Covers `db/migrations/003_content_depth.sql`, the admin content editor, and the
blog. For the sitemap side see [SITEMAP.md](./SITEMAP.md).

## Why this exists

An AdSense reviewer looking at a meme page previously saw a title, a player, a
spec box, and one sentence that differed from every other page only by title and
format. That is the definition of thin, templated content, and it is the most
common reason a site like this is rejected for "low value content".

The fix is real per-asset copy. This migration and the admin editor are the
plumbing for it; **writing the copy is still a human job** — see [Backfilling](#backfilling).

## `description_long`

`JSONB`, keyed by subsection:

| Key | Renders under | Intended content |
| --- | --- | --- |
| `what` | What is this meme | Origin, context, who is in it, why it spread |
| `why` | Why people use it | The emotion or reaction it conveys, situations it fits |
| `how` | How to use this meme | WhatsApp status, Reels, Shorts, editing projects |
| `quality` | Format & quality | Format, resolution, watermark-free status, in prose |
| `related` | Related memes | Thematic lead-in to the "You Might Also Like" row |

### Why JSONB and not TEXT

The brief specified `text`. It is stored as JSONB because the same brief also
requires five *named* subsections, each under its own `<h3>`. One text blob
cannot guarantee that: you would be parsing prose back into sections at render
time and trusting authors to keep the order. Keyed storage makes each subsection
independently editable and validatable, and lets the renderer emit the heading
hierarchy deterministically.

Switching to TEXT later is a small change — collapse the object to a string on
read and drop the per-section textareas — but the heading structure the brief
asks for would go with it.

The section list is defined twice and must stay in step:

- `server/lib/contentSchema.js` → `DESCRIPTION_SECTIONS` (validates saves)
- `client/src/utils/contentSections.js` → `DESCRIPTION_SECTIONS` (renders + edits)

A key in one but not the other is silently dropped, not an error.

### Rendering

`client/src/components/MemeDescription.jsx`. `h2` for the section, `h3` per
subsection. Blank lines inside a subsection become separate paragraphs.

When nothing has been written it renders the short spec-derived sentence and
stops. It deliberately does **not** synthesise paragraphs from title and format:
templated prose repeated across 227 pages is exactly the problem the long
description exists to solve, and generating it would hide the gap instead of
closing it. Admins see the word count and a link to the editor instead.

The authored `what` section also becomes the page's `<meta description>` and the
`description` in its schema.org markup, replacing the boilerplate sentence that
was otherwise near-identical on every page. `server/lib/sitemap/generator.js`
applies the same rule to `<video:description>` — the two `describe()` functions
are kept byte-identical so a page and its sitemap entry never disagree.

## Auditing

- `updated_at` — already existed (001), maintained by the `memes_updated_at` trigger
- `last_updated_by` — added by 003; set by every admin write

Together they answer "who changed this and when". `updated_at` moving forward
also advances the sitemap's `<lastmod>`, so an edit prompts a recrawl.

## `content_status`

`draft` | `published` | `flagged` | `removed`. See the sync-trigger table in
[SITEMAP.md](./SITEMAP.md#content_status) — the short version is that
`content_status` is the admin control, `is_published`/`is_flagged` are kept in
sync by a trigger, and no existing query had to change.

`flagged` and `removed` exist so a DMCA or policy hold can unpublish a page
without destroying the record. The pre-existing `DELETE /api/admin/reject` still
hard-deletes; prefer setting `removed` unless the file must actually go.

## Admin API

All under `/api/admin`, all requiring an admin JWT.

| Endpoint | Purpose |
| --- | --- |
| `GET /content` | Search/filter/paginate every asset in any state |
| `GET /content/:id` | One asset with all editable fields |
| `PATCH /content/:id` | Edit title, category, tags, status, descriptions |
| `POST /content/bulk` | Set `content_status` and/or `needs_description` on up to 500 ids |
| `GET|POST /blog`, `PATCH|DELETE /blog/:id` | Blog CRUD |

The list endpoint returns `description_words` rather than the description bodies
— the table only needs to show how complete each row is, and the bodies would
dominate the payload.

Bulk edit accepts only status and the triage flag. Bulk-editing prose is
meaningless, and bulk-editing titles is how a catalogue gets destroyed by
accident.

**These routes require migration 003.** Unlike the sitemap, which probes and
degrades, the content editor is a new feature that cannot work without its
columns — it will return errors until the migration is applied.

## Backfilling

227 assets exist and none has a long description. The editor is built for
working through them rather than hunting one at a time:

1. Admin → Content Editor, filter **No long description**.
2. Select a batch, **Flag for description** — records the intent to write them.
3. Filter **Flagged for description work** to see the queue; the per-row word
   count turns green at 400.

`needs_description` (an admin's judgement) is deliberately separate from
`description_long IS NULL` (a fact about the data), so progress through a
planned batch is visible independently of raw emptiness.

## Blog

`public.blog_posts` — a second content type, not a variant of a meme page.
Editorial articles ("Top 10 Memes This Week") are unique copy by construction,
which makes them useful both as reviewable content and as a source of internal
links into the catalogue.

- Public routes: `/blog`, `/blog/:slug`; reachable from the footer, so the pages
  are not orphans
- RLS exposes only `status = 'published'`; the client reads Supabase directly,
  as it does for memes
- Bodies are Markdown, rendered by `client/src/components/Markdown.jsx`

That renderer is deliberately minimal and produces React elements only — never
`dangerouslySetInnerHTML`. "Trusted admin author" is not a safety model: a
compromised account or a careless paste would otherwise put arbitrary HTML on
the page. Only same-origin paths and `https://` URLs become links; everything
else, including `javascript:`, `data:` and protocol-relative `//host`, renders
as plain text.
