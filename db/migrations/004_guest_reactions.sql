-- ─────────────────────────────────────────────────────────────────────────────
-- 004 — guest-capable reactions
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to run more than once.
--
-- Why: laugh_count / fire_count / skull_count already exist on memes, but
-- nothing ever wrote to them — reactions were display-only. Making them
-- interactive raises the obvious question of who is allowed to react.
--
-- Requiring an account would be the easy answer and the wrong one: a reaction
-- is a one-tap engagement signal on public content, and a login wall in front
-- of it costs far more participation than it saves in noise. So reactions are
-- open to guests, and abuse is handled by de-duplication instead of identity:
-- one reaction per (meme, reaction, actor) where the actor is the server's
-- HttpOnly session cookie, or the signed-in user ID when there is one.
--
-- The UNIQUE constraint is what makes this work — it is the enforcement point,
-- not the application code. A replayed request hits a duplicate key and the
-- counter is left alone, so spamming the endpoint cannot inflate a count even
-- if the per-IP rate limiter is bypassed with distributed traffic.
-- ─────────────────────────────────────────────────────────────────────────────


-- =========================================================
-- 1. reaction_events — one row per (meme, reaction, actor)
-- =========================================================
CREATE TABLE IF NOT EXISTS public.reaction_events (
  id         BIGSERIAL   PRIMARY KEY,
  meme_id    UUID        NOT NULL REFERENCES public.memes(id) ON DELETE CASCADE,
  reaction   TEXT        NOT NULL CHECK (reaction IN ('laugh', 'fire', 'skull')),

  -- The actor is deliberately opaque. For a guest this is the videsaur_sid
  -- cookie value; for a signed-in user it is 'user:<uuid>'. Storing it as one
  -- TEXT column rather than two nullable columns keeps the UNIQUE constraint
  -- to a single index and means the dedupe rule reads the same either way.
  actor_key  TEXT        NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (meme_id, reaction, actor_key)
);

-- Supports the "what has this actor already reacted to?" lookup the client
-- uses to render its reaction state on a cold load.
CREATE INDEX IF NOT EXISTS reaction_events_actor_idx
  ON public.reaction_events (actor_key, meme_id);

-- Supports abuse review: "everything this actor did in the last hour".
CREATE INDEX IF NOT EXISTS reaction_events_recent_idx
  ON public.reaction_events (actor_key, created_at DESC);

-- Only the service-role server touches this table. Guests never hold a
-- Supabase credential, so there is no anon policy to write.
ALTER TABLE public.reaction_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.reaction_events;
CREATE POLICY "Service role only" ON public.reaction_events USING (FALSE);


-- =========================================================
-- 2. RPC: toggle_reaction
-- =========================================================
-- Records or withdraws a reaction and moves the denormalised counter on
-- `memes` in the same transaction, so the counter cannot drift from the event
-- rows. Returns the new count and whether the actor now holds the reaction —
-- exactly what the client needs to reconcile its optimistic update.
--
-- The counter moves by ±1 rather than being recomputed with COUNT(*) over
-- reaction_events. Recomputing would be self-healing, but it would also mean
-- every pre-existing counter value needs a matching event row to survive the
-- first reaction — a backfill of one row per historical reaction, which is
-- unbounded in size on popular content. A relative update inherits whatever
-- the counter already held and needs no backfill at all. The increment is a
-- single UPDATE statement, so concurrent reactions serialise on the row lock
-- and cannot lose a write.
CREATE OR REPLACE FUNCTION public.toggle_reaction(
  p_meme_id   UUID,
  p_reaction  TEXT,
  p_actor_key TEXT
)
RETURNS TABLE (total BIGINT, reacted BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_removed  INTEGER;
  v_added    INTEGER;
  v_delta    INTEGER;
  v_total    BIGINT;
BEGIN
  IF p_reaction NOT IN ('laugh', 'fire', 'skull') THEN
    RAISE EXCEPTION 'unsupported reaction: %', p_reaction;
  END IF;

  IF p_actor_key IS NULL OR length(p_actor_key) = 0 THEN
    RAISE EXCEPTION 'actor_key required';
  END IF;

  -- Withdraw if this actor already reacted; otherwise record it.
  DELETE FROM public.reaction_events
   WHERE meme_id = p_meme_id
     AND reaction = p_reaction
     AND actor_key = p_actor_key;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed > 0 THEN
    v_delta := -1;
  ELSE
    -- DO NOTHING absorbs the race where two concurrent requests from the same
    -- actor both saw "not yet reacted"; the loser adds no row and no count.
    INSERT INTO public.reaction_events (meme_id, reaction, actor_key)
    VALUES (p_meme_id, p_reaction, p_actor_key)
    ON CONFLICT (meme_id, reaction, actor_key) DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;
    v_delta := v_added;
  END IF;

  -- GREATEST(...,0) guards against a counter that was already at 0 while a
  -- stale event row implied otherwise; the column is BIGINT NOT NULL with no
  -- CHECK, so a negative value would persist and render as "-1 reactions".
  UPDATE public.memes m
     SET laugh_count = CASE WHEN p_reaction = 'laugh'
                            THEN GREATEST(m.laugh_count + v_delta, 0)
                            ELSE m.laugh_count END,
         fire_count  = CASE WHEN p_reaction = 'fire'
                            THEN GREATEST(m.fire_count + v_delta, 0)
                            ELSE m.fire_count END,
         skull_count = CASE WHEN p_reaction = 'skull'
                            THEN GREATEST(m.skull_count + v_delta, 0)
                            ELSE m.skull_count END
   WHERE m.id = p_meme_id
  RETURNING CASE p_reaction
              WHEN 'laugh' THEN m.laugh_count
              WHEN 'fire'  THEN m.fire_count
              ELSE m.skull_count
            END
    INTO v_total;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'meme not found: %', p_meme_id;
  END IF;

  RETURN QUERY SELECT v_total, (v_removed = 0);
END;
$$;


-- =========================================================
-- 3. Keep engagement counters out of <lastmod>
-- =========================================================
-- public.memes.updated_at is maintained by the memes_updated_at trigger, and
-- sitemap/query.js derives each URL's <lastmod> from it (see lastModifiedOf).
-- That is the behaviour we want for an admin retitling an asset: the lastmod
-- moves and crawlers recheck the page.
--
-- A reaction is not a content change. Left alone, the generic trigger would
-- stamp updated_at = NOW() on every tap, so a single popular meme could
-- rewrite its own lastmod hundreds of times a day, republish through the
-- sitemap, and fire an IndexNow ping each time — telling search engines the
-- page changed when the page did not. That burns crawl budget and trains
-- crawlers to distrust our lastmod values.
--
-- So memes gets its own trigger function that ignores counter-only updates.
-- The generic update_updated_at() is left untouched because blog_posts still
-- uses it (migration 003).
--
-- The comparison copies OLD's counters onto a probe copy of NEW and asks
-- whether anything *else* differs. Written this way rather than as an explicit
-- column list so that any column added to memes later is treated as content
-- by default — the safe direction to fail.
CREATE OR REPLACE FUNCTION public.memes_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_probe public.memes;
BEGIN
  v_probe := NEW;
  v_probe.download_count := OLD.download_count;
  v_probe.laugh_count    := OLD.laugh_count;
  v_probe.fire_count     := OLD.fire_count;
  v_probe.skull_count    := OLD.skull_count;
  v_probe.updated_at     := OLD.updated_at;

  IF v_probe IS NOT DISTINCT FROM OLD THEN
    -- Engagement-only change: hold lastmod steady.
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memes_updated_at ON public.memes;
CREATE TRIGGER memes_updated_at
  BEFORE UPDATE ON public.memes
  FOR EACH ROW EXECUTE FUNCTION public.memes_touch_updated_at();
