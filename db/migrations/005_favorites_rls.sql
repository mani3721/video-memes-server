-- ─────────────────────────────────────────────────────────────────────────────
-- 005 — favorites RLS policies for account sync
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to run more than once, and safe whatever the current policy state is.
--
-- Why: the deployed favorites table is already the right shape — columns
-- (id, user_id, meme_id, created_at), a UNIQUE index on (user_id, meme_id),
-- and an FK to auth.users, all verified against the live database. What could
-- not be verified without a user JWT is whether its RLS policies actually let
-- a signed-in user read and write their own rows.
--
-- That matters because the client talks to this table directly with the anon
-- key. If the only policy is the service-role-only USING (FALSE) that
-- schema.sql originally created, every signed-in favorite is denied and
-- client/src/lib/migrateFavorites.js cannot carry a guest's list into their
-- new account — the one thing signing in is advertised to do.
--
-- This migration is additive and idempotent, so it closes that gap without
-- needing to know the current state. Postgres ORs permissive policies
-- together: access is granted if ANY policy passes. So a leftover
-- USING (FALSE) policy does not block these, and is left in place rather than
-- dropped — it still correctly describes that the service role owns the table
-- outright, and removing it would be a change with no benefit.
--
-- Guests are unaffected either way. A guest holds no JWT, matches none of
-- these `TO authenticated` policies, and never touches this table — their
-- favorites live in localStorage under `videsaur_fav_ids`.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own favorites" ON public.favorites;
CREATE POLICY "Users read own favorites"
  ON public.favorites FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users add own favorites" ON public.favorites;
CREATE POLICY "Users add own favorites"
  ON public.favorites FOR INSERT
  TO authenticated
  -- WITH CHECK is the important half: it stops a client inserting a row
  -- attributed to somebody else's user_id.
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users remove own favorites" ON public.favorites;
CREATE POLICY "Users remove own favorites"
  ON public.favorites FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());
