-- ─────────────────────────────────────────────────────────────────────────────
-- 003 — long-form descriptions, edit auditing, content status, blog posts
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────


-- =========================================================
-- 1. Long-form description
-- =========================================================
-- Stored as JSONB keyed by subsection rather than one TEXT blob.
--
-- The requirement is a ~400-word description split into five *named*
-- subsections, each rendered under its own <h3>. A single text column cannot
-- guarantee that structure: you would be parsing prose back into sections at
-- render time and hoping authors kept the right order. JSONB makes each
-- subsection independently editable, independently validatable, and lets the
-- renderer emit the heading hierarchy deterministically.
--
-- Shape (all keys optional so a partial draft can be saved):
--   {
--     "what":    "What is this meme — origin/context, who is in it.",
--     "why":     "Why people use it — the emotion or reaction it conveys.",
--     "how":     "How to use it — WhatsApp status, Reels, Shorts, editing.",
--     "quality": "Format & quality details in natural language.",
--     "related": "Related content teaser leading into You Might Also Like."
--   }
ALTER TABLE public.memes
  ADD COLUMN IF NOT EXISTS description_long JSONB;

-- Reject arrays/strings/numbers early; only an object (or NULL) is meaningful.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memes_description_long_is_object'
  ) THEN
    ALTER TABLE public.memes
      ADD CONSTRAINT memes_description_long_is_object
      CHECK (description_long IS NULL OR jsonb_typeof(description_long) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN public.memes.description_long IS
  'Long-form SEO description, keyed by subsection: what, why, how, quality, related. Separate from mood_tags (short tag-style metadata).';


-- =========================================================
-- 2. Edit auditing
-- =========================================================
-- NOTE: updated_at already exists from 001, maintained by the memes_updated_at
-- trigger. It is deliberately not redefined here.
ALTER TABLE public.memes
  ADD COLUMN IF NOT EXISTS last_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.memes.last_updated_by IS
  'Admin who last edited this row. Pairs with updated_at for the content audit trail.';


-- =========================================================
-- 3. Bulk description triage
-- =========================================================
ALTER TABLE public.memes
  ADD COLUMN IF NOT EXISTS needs_description BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.memes.needs_description IS
  'Admin-set flag: this item needs a long description written. Lets admins queue a backfill in bulk.';


-- =========================================================
-- 4. content_status
-- =========================================================
-- Four-state admin control replacing "guess the meaning of two booleans".
--
-- is_published and is_flagged are NOT dropped: the sitemap generator, the RLS
-- SELECT policy, the useMemes hooks and the existing approve/reject routes all
-- read them. Dropping them would mean rewriting all of that in one shot.
-- Instead a trigger keeps all three consistent in BOTH directions, so
-- content_status is what admins set while existing code keeps working untouched.
--
--   draft     → not published, not flagged
--   published → published, not flagged
--   flagged   → flagged; is_published is preserved so un-flagging restores it
--   removed   → not published AND flagged (soft delete)
--
-- Because every non-published state leaves is_published FALSE or is_flagged
-- TRUE, the existing "is_published AND NOT is_flagged" filter in the sitemap
-- and in RLS stays correct for all four states with no change.

ALTER TABLE public.memes
  ADD COLUMN IF NOT EXISTS content_status TEXT;

-- Backfill from the booleans before adding constraints.
UPDATE public.memes
SET content_status = CASE
      WHEN is_flagged AND NOT is_published THEN 'removed'
      WHEN is_flagged                      THEN 'flagged'
      WHEN is_published                    THEN 'published'
      ELSE 'draft'
    END
WHERE content_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memes_content_status_check'
  ) THEN
    ALTER TABLE public.memes
      ADD CONSTRAINT memes_content_status_check
      CHECK (content_status IN ('draft', 'published', 'flagged', 'removed'));
  END IF;
END $$;

-- NOT NULL is safe even though inserts may omit the column: BEFORE triggers run
-- before constraint checks, and sync_content_status() fills a NULL in.
ALTER TABLE public.memes ALTER COLUMN content_status SET NOT NULL;

COMMENT ON COLUMN public.memes.content_status IS
  'Authoritative publication state: draft | published | flagged | removed. Kept in sync with is_published/is_flagged by sync_content_status().';


-- ── Bidirectional sync trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_content_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A NULL status means the caller used the legacy boolean API (e.g.
    -- routes/upload.js inserting is_published = true), so derive from those.
    IF NEW.content_status IS NULL THEN
      NEW.content_status := CASE
        WHEN NEW.is_flagged AND NOT NEW.is_published THEN 'removed'
        WHEN NEW.is_flagged                          THEN 'flagged'
        WHEN NEW.is_published                        THEN 'published'
        ELSE 'draft'
      END;
    ELSE
      NEW.is_published := (NEW.content_status = 'published');
      NEW.is_flagged   := (NEW.content_status IN ('flagged', 'removed'));
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: whichever side the caller touched wins. Status is checked first so
  -- an admin setting content_status does not fight a stale boolean in the same
  -- statement.
  IF NEW.content_status IS DISTINCT FROM OLD.content_status THEN
    NEW.is_flagged := (NEW.content_status IN ('flagged', 'removed'));
    IF NEW.content_status = 'published' THEN
      NEW.is_published := TRUE;
    ELSIF NEW.content_status IN ('draft', 'removed') THEN
      NEW.is_published := FALSE;
    END IF;
    -- 'flagged' deliberately leaves is_published alone: clearing the flag then
    -- restores whatever publication state the asset had before the hold.

  ELSIF NEW.is_published IS DISTINCT FROM OLD.is_published
     OR NEW.is_flagged   IS DISTINCT FROM OLD.is_flagged THEN
    NEW.content_status := CASE
      WHEN NEW.is_flagged AND NOT NEW.is_published THEN 'removed'
      WHEN NEW.is_flagged                          THEN 'flagged'
      WHEN NEW.is_published                        THEN 'published'
      ELSE 'draft'
    END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memes_sync_content_status ON public.memes;
CREATE TRIGGER memes_sync_content_status
  BEFORE INSERT OR UPDATE ON public.memes
  FOR EACH ROW EXECUTE FUNCTION public.sync_content_status();


-- ── Indexes for the admin content table ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS memes_content_status_idx
  ON public.memes (content_status, created_at DESC);

CREATE INDEX IF NOT EXISTS memes_needs_description_idx
  ON public.memes (created_at DESC) WHERE needs_description;


-- =========================================================
-- 5. blog_posts
-- =========================================================
-- A separate content type from individual meme pages: editorial articles
-- ("Top 10 Memes This Week") that carry their own unique long-form copy and
-- link internally to meme pages.
CREATE TABLE IF NOT EXISTS public.blog_posts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  slug            TEXT        NOT NULL UNIQUE
                              CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title           TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  excerpt         TEXT        CHECK (excerpt IS NULL OR char_length(excerpt) <= 400),
  -- Markdown. Rendered by a deliberately restricted renderer on the client, so
  -- no raw HTML is ever interpolated into the page.
  body            TEXT        NOT NULL DEFAULT '',
  cover_url       TEXT,

  status          TEXT        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'published', 'removed')),

  author_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  last_updated_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,

  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS blog_posts_updated_at ON public.blog_posts;
CREATE TRIGGER blog_posts_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Stamp published_at the first time a post goes live, and clear it if unpublished.
CREATE OR REPLACE FUNCTION public.sync_blog_published_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := NOW();
  ELSIF NEW.status <> 'published' THEN
    NEW.published_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blog_posts_published_at ON public.blog_posts;
CREATE TRIGGER blog_posts_published_at
  BEFORE INSERT OR UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.sync_blog_published_at();

CREATE INDEX IF NOT EXISTS blog_posts_published_idx
  ON public.blog_posts (published_at DESC) WHERE status = 'published';

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

-- Anyone may read published posts; everything else is service-role only.
DROP POLICY IF EXISTS "Published blog posts are public" ON public.blog_posts;
CREATE POLICY "Published blog posts are public"
  ON public.blog_posts FOR SELECT
  USING (status = 'published');

DROP POLICY IF EXISTS "Service role only write" ON public.blog_posts;
CREATE POLICY "Service role only write"
  ON public.blog_posts FOR ALL
  USING (FALSE);
