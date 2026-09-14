-- 010_auto_default_collection.sql
-- Updates the handle_new_user trigger so every new sign-up automatically
-- gets a default "Uncategorized" collection, replacing the version from 008
-- that only created the profile row.
--
-- Safe to re-run: CREATE OR REPLACE.
-- Run AFTER 008_collections.sql and 009_collections_backfill.sql.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'user')
  ON CONFLICT (id) DO NOTHING;

  -- Seed the user's default "Uncategorized" collection so that the first
  -- favorited item has somewhere to land without a round-trip to create it.
  INSERT INTO public.collections (user_id, name, is_default)
  VALUES (NEW.id, 'Uncategorized', TRUE)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
