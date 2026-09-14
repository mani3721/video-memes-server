-- 009_collections_backfill.sql
-- Data migration: backfill existing users.
--
-- For every user who already has rows in `favorites`:
--   1. Create an "Uncategorized" default collection (is_default = TRUE) if
--      they don't already have one.
--   2. Insert their favorited memes into collection_items pointing at that
--      collection, skipping any that are already there.
--
-- Safe to re-run: INSERT ... ON CONFLICT DO NOTHING everywhere.
-- Run AFTER 008_collections.sql.

DO $$
DECLARE
  r        RECORD;
  col_id   UUID;
BEGIN
  -- Iterate over every user who has at least one favorite
  FOR r IN
    SELECT DISTINCT user_id FROM public.favorites
  LOOP
    -- Find or create the default collection for this user
    SELECT id INTO col_id
      FROM public.collections
     WHERE user_id    = r.user_id
       AND is_default = TRUE
     LIMIT 1;

    IF col_id IS NULL THEN
      INSERT INTO public.collections (user_id, name, is_default)
      VALUES (r.user_id, 'Uncategorized', TRUE)
      RETURNING id INTO col_id;
    END IF;

    -- Backfill all this user's favorites into their default collection
    INSERT INTO public.collection_items (collection_id, meme_id, user_id, added_at)
    SELECT col_id, f.meme_id, f.user_id, f.created_at
      FROM public.favorites f
     WHERE f.user_id = r.user_id
    ON CONFLICT (collection_id, meme_id) DO NOTHING;
  END LOOP;
END;
$$;
