-- 008_collections.sql
-- Adds named collection folders so users can organise their favorites.
-- Collections are auth-user-only; the flat favorites table is unchanged.
--
-- Safe to re-run: all statements use IF NOT EXISTS / CREATE OR REPLACE.

-- =========================================================
-- collections
-- =========================================================
CREATE TABLE IF NOT EXISTS public.collections (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  emoji      TEXT,
  -- TRUE for the one auto-created default ("Uncategorized") per user.
  -- Stored so the API can find or guard it without brittle name-matching.
  is_default BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS collections_user_idx         ON public.collections (user_id);
CREATE INDEX IF NOT EXISTS collections_user_default_idx ON public.collections (user_id, is_default);

-- Keep updated_at fresh on rename / icon change
CREATE OR REPLACE FUNCTION update_collections_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS collections_updated_at ON public.collections;
CREATE TRIGGER collections_updated_at
  BEFORE UPDATE ON public.collections
  FOR EACH ROW EXECUTE FUNCTION update_collections_updated_at();

-- RLS
ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own collections"   ON public.collections;
CREATE POLICY "Users read own collections"
  ON public.collections FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users create own collections" ON public.collections;
CREATE POLICY "Users create own collections"
  ON public.collections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own collections" ON public.collections;
CREATE POLICY "Users update own collections"
  ON public.collections FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own collections" ON public.collections;
CREATE POLICY "Users delete own collections"
  ON public.collections FOR DELETE
  USING (auth.uid() = user_id);


-- =========================================================
-- collection_items
-- =========================================================
CREATE TABLE IF NOT EXISTS public.collection_items (
  id            BIGSERIAL   PRIMARY KEY,
  collection_id UUID        NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
  meme_id       UUID        NOT NULL REFERENCES public.memes(id)       ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES auth.users(id)         ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection_id, meme_id)
);

CREATE INDEX IF NOT EXISTS collection_items_collection_idx ON public.collection_items (collection_id);
CREATE INDEX IF NOT EXISTS collection_items_user_idx       ON public.collection_items (user_id);

-- RLS
ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own collection items"   ON public.collection_items;
CREATE POLICY "Users read own collection items"
  ON public.collection_items FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users add own collection items"    ON public.collection_items;
CREATE POLICY "Users add own collection items"
  ON public.collection_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users remove own collection items" ON public.collection_items;
CREATE POLICY "Users remove own collection items"
  ON public.collection_items FOR DELETE
  USING (auth.uid() = user_id);
