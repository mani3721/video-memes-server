-- ─────────────────────────────────────────────────────────────────────────────
-- 002 — moderation flags for sitemap exclusion
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- Why: the sitemap must never list content removed for DMCA or policy reasons.
-- Until now the only takedown path was DELETE /api/admin/reject, which drops
-- the row outright. That works, but it destroys the audit trail and makes a
-- mistaken takedown unrecoverable. These columns allow a soft takedown: the
-- content stops being served and stops appearing in the sitemap, while the
-- record of the notice survives.
--
-- The sitemap generator probes for is_flagged at boot and falls back to
-- filtering on is_published alone if this migration has not been applied, so
-- applying it is safe in either order relative to a server deploy.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.memes
  ADD COLUMN IF NOT EXISTS is_flagged     BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flagged_reason TEXT,
  ADD COLUMN IF NOT EXISTS flagged_at     TIMESTAMPTZ;

COMMENT ON COLUMN public.memes.is_flagged IS
  'Soft takedown. TRUE excludes the asset from the sitemap and from public reads.';
COMMENT ON COLUMN public.memes.flagged_reason IS
  'Free text: DMCA notice reference, policy rule violated, etc.';

-- Partial index matching the sitemap query exactly: published, unflagged, in a
-- category, ordered by created_at. Keeps a full-catalogue sitemap build off a
-- sequential scan.
CREATE INDEX IF NOT EXISTS memes_sitemap_idx
  ON public.memes (category, created_at, id)
  WHERE is_published AND NOT is_flagged;

-- ── RLS: flagged content must stop being publicly readable ───────────────────
-- The existing "Published memes are public" policy would still expose a flagged
-- row, which would leave the page live while absent from the sitemap. Replace
-- it so a takedown actually takes the page down.
DROP POLICY IF EXISTS "Published memes are public" ON public.memes;

CREATE POLICY "Published memes are public"
  ON public.memes FOR SELECT
  USING (is_published = TRUE AND is_flagged = FALSE);
