-- Videsaur — Supabase schema
--
-- FRESH DATABASES ONLY. This file creates every table from scratch with bare
-- CREATE TABLE, so running it against a database that already has these
-- tables fails on the first one with:
--   ERROR: 42P07: relation "<table>" already exists
-- That error is harmless — it aborts before changing anything — but it means
-- this is the wrong file for an existing database.
--
-- To change a live database, add a numbered file under db/migrations/ instead.
-- Those are written to be idempotent (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS) and safe to re-run. Edits to this file keep new
-- deployments correct; they are never a way to patch an existing one.
--
-- Requires pg_trgm extension for full-text search.

CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- =========================================================
-- memes
-- =========================================================
CREATE TABLE public.memes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Content identity
  title            TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  creator_name     TEXT        NOT NULL DEFAULT 'anonymous',

  -- R2 storage
  spaces_key           TEXT        NOT NULL UNIQUE,            -- e.g. "videos/uuid-my-meme.mp4"
  public_url       TEXT        NOT NULL,                   -- e.g. "https://cdn.videsaur.co.in/videos/..."
  thumbnail_spaces_key TEXT        NOT NULL,
  thumbnail_url    TEXT        NOT NULL,
  filename         TEXT        NOT NULL,                   -- original name for Content-Disposition

  -- Media metadata
  format           TEXT        NOT NULL CHECK (format IN ('MP4','WebM','GIF','PNG','MP3','WAV')),
  category         TEXT        NOT NULL CHECK (category IN ('videos','gifs','images','sounds')),
  mood_tags        TEXT[]      NOT NULL DEFAULT '{}',
  license          TEXT        NOT NULL DEFAULT 'CC0' CHECK (license IN ('CC0','Editorial')),
  duration_seconds INTEGER     CHECK (duration_seconds >= 0),   -- NULL for still images
  file_size_bytes  BIGINT      NOT NULL CHECK (file_size_bytes > 0),
  width_px         INTEGER     CHECK (width_px > 0),
  height_px        INTEGER     CHECK (height_px > 0),
  has_alpha        BOOLEAN     NOT NULL DEFAULT FALSE,
  green_screen     BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Engagement
  download_count   BIGINT      NOT NULL DEFAULT 0,
  laugh_count      BIGINT      NOT NULL DEFAULT 0,
  fire_count       BIGINT      NOT NULL DEFAULT 0,
  skull_count      BIGINT      NOT NULL DEFAULT 0,

  -- Curation
  is_hot           BOOLEAN     NOT NULL DEFAULT FALSE,   -- admin pin: floats to top of every feed

  -- Access control
  uploader_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  is_published     BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep updated_at in sync
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER memes_updated_at
  BEFORE UPDATE ON public.memes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Fast lookups
CREATE INDEX memes_category_idx   ON public.memes (category) WHERE is_published;
CREATE INDEX memes_format_idx     ON public.memes (format)   WHERE is_published;
CREATE INDEX memes_created_idx    ON public.memes (created_at DESC);
CREATE INDEX memes_downloads_idx  ON public.memes (download_count DESC) WHERE is_published;
CREATE INDEX memes_title_trgm_idx ON public.memes USING GIN (title gin_trgm_ops);
CREATE INDEX memes_mood_tags_idx  ON public.memes USING GIN (mood_tags);

-- =========================================================
-- Row Level Security
-- =========================================================
ALTER TABLE public.memes ENABLE ROW LEVEL SECURITY;

-- Anyone can read published memes
CREATE POLICY "Published memes are public"
  ON public.memes FOR SELECT
  USING (is_published = TRUE);

-- Authenticated users can insert (server validates via service role anyway)
CREATE POLICY "Auth users can insert"
  ON public.memes FOR INSERT
  TO authenticated
  WITH CHECK (uploader_id = auth.uid());

-- Uploaders can update their own memes
CREATE POLICY "Uploaders can update own memes"
  ON public.memes FOR UPDATE
  TO authenticated
  USING (uploader_id = auth.uid());

-- =========================================================
-- download_events  (lightweight audit log; optional)
-- =========================================================
CREATE TABLE public.download_events (
  id         BIGSERIAL   PRIMARY KEY,
  meme_id    UUID        NOT NULL REFERENCES public.memes(id) ON DELETE CASCADE,
  country    TEXT,                    -- from Cloudflare CF-IPCountry header if available
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX download_events_meme_idx ON public.download_events (meme_id, created_at DESC);

-- Only server (service role) writes events; no RLS read for this table
ALTER TABLE public.download_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only" ON public.download_events USING (FALSE);

-- =========================================================
-- favorites  (account sync only — guests never reach this table)
-- =========================================================
-- Favorites work with no account at all: a guest's hearts live in
-- localStorage under `videsaur_fav_ids` (client/src/hooks/useFavorites.js).
-- This table exists purely for the one thing an account adds — carrying that
-- list across devices — and client/src/lib/migrateFavorites.js upserts the
-- guest's local list into it on sign-in so nothing is lost.
--
-- Corrected to match the deployed table. This block previously described a
-- cookie-session shape, (session_id TEXT, asset_id TEXT), with a
-- service-role-only policy. The client has always read and written favorites
-- directly with the anon key on user_id / meme_id, so a database built from
-- the old definition would reject every signed-in favorite twice over —
-- unknown column, then RLS denial — and the sign-in-to-sync promise would
-- silently fail on any fresh deployment.
--
-- server/routes/favorites.js still speaks the old cookie-session shape and is
-- dead code against this table; the client does not call it.
CREATE TABLE public.favorites (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  meme_id    UUID        NOT NULL REFERENCES public.memes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Load-bearing for the merge: migrateFavorites upserts with
  -- onConflict: 'user_id,meme_id', and Postgres rejects an ON CONFLICT clause
  -- outright unless a matching unique constraint exists.
  UNIQUE (user_id, meme_id)
);

CREATE INDEX favorites_user_idx ON public.favorites (user_id);

ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

-- Scoped to auth.uid() rather than service-role-only, because the client
-- talks to this table directly with the anon key. A guest holds no JWT and so
-- matches none of these policies — which is correct; their favorites are in
-- localStorage, not here.
CREATE POLICY "Users read own favorites"
  ON public.favorites FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users add own favorites"
  ON public.favorites FOR INSERT
  TO authenticated
  -- WITH CHECK is the important half: it stops a client inserting a row
  -- attributed to somebody else's user_id.
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users remove own favorites"
  ON public.favorites FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- =========================================================
-- profiles  (role management — admin | user)
-- =========================================================
CREATE TABLE public.profiles (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT,
  display_name TEXT,
  role         TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Service role (server) manages everything; anon/authenticated users cannot write
CREATE POLICY "Service role only write"
  ON public.profiles FOR ALL
  USING (FALSE);

-- Auto-create a profile row with role='user' whenever a new auth user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =========================================================
-- RLS update: uploaders can read their own pending memes
-- =========================================================
CREATE POLICY "Uploaders can read own memes"
  ON public.memes FOR SELECT
  TO authenticated
  USING (uploader_id = auth.uid());

-- =========================================================
-- RPC: increment_download_count
-- Called by the server on every download event.
-- Using a dedicated function avoids a read-modify-write race.
-- =========================================================
CREATE OR REPLACE FUNCTION public.increment_download_count(meme_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.memes
  SET download_count = download_count + 1
  WHERE id = meme_id;
$$;
