-- ─────────────────────────────────────────────────────────────────────────────
-- 006 — notifications
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to run more than once.
--
-- Notifications are an account-only feature: read/unread state has to hang off
-- a durable identity, and a guest has none. Guests never see the bell at all
-- (see client/src/components/NotificationBell.jsx) — this is the one part of
-- the site that genuinely requires signing in, alongside uploads and admin.
--
-- Everything here is written and read through the service-role server
-- (server/routes/notifications.js), scoped to req.user.id. The client never
-- queries these tables with the anon key, so there are no per-user RLS
-- policies to maintain — the "who can see what" rule lives in one place
-- instead of being duplicated between SQL policies and route handlers.
-- ─────────────────────────────────────────────────────────────────────────────


-- =========================================================
-- 1. Language dimension
-- =========================================================
-- Notification targeting is specified in terms of a user's category *or*
-- language preference. Category already exists on memes and needs nothing.
-- Language did not exist anywhere: no column on memes, no preference on
-- profiles, nothing tagging content as Tamil or English.
--
-- These columns add that dimension so language targeting is wired end to end,
-- but they start NULL — which means language-segmented sends match nobody and
-- language-based new-content matching is inert until content and users are
-- actually tagged. Category-based matching works immediately.
--
-- Deliberately free text rather than CHECK (language IN ('ta','en')): the real
-- taxonomy is a product decision, and a constraint guessed here would have to
-- be dropped the first time a third language shows up. Add one once the set
-- is settled.
ALTER TABLE public.memes
  ADD COLUMN IF NOT EXISTS language TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_language TEXT;

COMMENT ON COLUMN public.memes.language IS
  'Short language code for the content, e.g. ta, en. NULL = untagged.';
COMMENT ON COLUMN public.profiles.preferred_language IS
  'User''s preferred content language, matched against memes.language for notifications. NULL = no preference (matches everything).';

CREATE INDEX IF NOT EXISTS memes_language_idx
  ON public.memes (language) WHERE is_published;


-- =========================================================
-- 2. notifications
-- =========================================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL = site-wide broadcast, delivered to everyone (optionally narrowed by
  -- segment_language below). A broadcast is ONE row, not one row per user, so
  -- an announcement to 100k accounts is a single insert.
  user_id     UUID        REFERENCES auth.users(id) ON DELETE CASCADE,

  type        TEXT        NOT NULL CHECK (type IN ('new_content', 'announcement', 'system', 'milestone')),
  title       TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  message     TEXT        CHECK (message IS NULL OR char_length(message) <= 2000),

  -- Where clicking the notification goes, as a site-relative path.
  link        TEXT,
  thumbnail   TEXT,

  -- Broadcast narrowing. NULL = every user. Only consulted when user_id IS NULL.
  segment_language TEXT,

  -- Idempotency key. Publishing the same meme twice, or crossing the same
  -- download milestone twice, must not produce a duplicate notification.
  -- Enforced by the partial unique index below rather than by application
  -- code, so a retried request cannot slip a second row past it.
  dedupe_key  TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A broadcast cannot be segmented per-user and targeted at one user at once.
  CONSTRAINT notifications_segment_only_on_broadcast
    CHECK (segment_language IS NULL OR user_id IS NULL)
);

-- The per-user feed query: "my notifications, newest first".
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON public.notifications (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- The broadcast half of the same query.
CREATE INDEX IF NOT EXISTS notifications_broadcast_idx
  ON public.notifications (created_at DESC)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key
  ON public.notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.notifications;
CREATE POLICY "Service role only" ON public.notifications USING (FALSE);


-- =========================================================
-- 3. notification_reads
-- =========================================================
-- Read state lives here rather than as a `read_status` boolean on
-- notifications, because a broadcast is a single row shared by every user —
-- a column on it could only ever record "somebody read this", which is not a
-- useful thing to know. A join table is the only shape that gives each user
-- their own read state over shared rows.
--
-- Absence of a row means unread. Nothing writes "unread" explicitly, so
-- marking all as read is an insert, never an update, and is naturally
-- idempotent.
CREATE TABLE IF NOT EXISTS public.notification_reads (
  notification_id UUID        NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id)           ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

-- Supports the unread-count probe, which the client polls every 60s and is by
-- far the hottest query here.
CREATE INDEX IF NOT EXISTS notification_reads_user_idx
  ON public.notification_reads (user_id);

ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.notification_reads;
CREATE POLICY "Service role only" ON public.notification_reads USING (FALSE);


-- =========================================================
-- 4. Visibility helper
-- =========================================================
-- "Which notifications does this user see?" — defined once, so the feed
-- query, the unread count and mark-all-read cannot drift apart.
--
-- A user sees their own rows, plus broadcasts whose segment they match. An
-- unsegmented broadcast (segment_language IS NULL) reaches everyone; a
-- segmented one reaches only users whose preferred_language matches, and
-- therefore reaches nobody while that column is still NULL everywhere.
CREATE OR REPLACE FUNCTION public.visible_notifications(p_user_id UUID)
RETURNS SETOF public.notifications
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT n.*
    FROM public.notifications n
   WHERE n.user_id = p_user_id
      OR (
        n.user_id IS NULL
        AND (
          n.segment_language IS NULL
          OR n.segment_language = (
            SELECT p.preferred_language FROM public.profiles p WHERE p.id = p_user_id
          )
        )
      );
$$;


-- =========================================================
-- 5. RPC: unread_notification_count
-- =========================================================
CREATE OR REPLACE FUNCTION public.unread_notification_count(p_user_id UUID)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)
    FROM public.visible_notifications(p_user_id) n
   WHERE NOT EXISTS (
     SELECT 1 FROM public.notification_reads r
      WHERE r.notification_id = n.id AND r.user_id = p_user_id
   );
$$;


-- =========================================================
-- 6. RPC: mark_all_notifications_read
-- =========================================================
-- ON CONFLICT DO NOTHING makes this safe to call repeatedly and safe against
-- two tabs racing.
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.notification_reads (notification_id, user_id)
  SELECT n.id, p_user_id
    FROM public.visible_notifications(p_user_id) n
  ON CONFLICT (notification_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


-- =========================================================
-- 7. RPC: notify_new_content
-- =========================================================
-- Fans a newly published meme out to the users plausibly interested in it.
--
-- "Interested" is derived from existing behaviour rather than a preferences
-- screen nobody has filled in: a user who has favorited at least one meme in
-- this category has demonstrated interest in the category. If both the meme
-- and the user carry a language, they must agree; an untagged meme or an
-- untagged user is treated as "no signal" and does not block the match.
--
-- One INSERT ... SELECT rather than a row-per-user loop in JS, so publishing
-- stays a single round trip no matter how many recipients there are.
CREATE OR REPLACE FUNCTION public.notify_new_content(p_meme_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_meme    public.memes;
  v_count   INTEGER;
BEGIN
  SELECT * INTO v_meme FROM public.memes WHERE id = p_meme_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'meme not found: %', p_meme_id;
  END IF;

  -- Never notify about something that is not publicly visible yet.
  IF NOT v_meme.is_published THEN
    RETURN 0;
  END IF;

  INSERT INTO public.notifications
    (user_id, type, title, message, link, thumbnail, dedupe_key)
  SELECT DISTINCT
         f.user_id,
         'new_content',
         'New ' || v_meme.category || ' you might like',
         v_meme.title,
         -- Prefix mirrors assetPathPrefix in client/src/utils/seo.js and
         -- server/lib/sitemap/urls.js: sounds live under /sound/. Building it
         -- correctly here saves every notification click a redirect hop.
         CASE WHEN v_meme.category = 'sounds' THEN '/sound/' ELSE '/meme/' END || p_meme_id,
         v_meme.thumbnail_url,
         'new_content:' || p_meme_id
    FROM public.favorites f
    JOIN public.memes fm ON fm.id = f.meme_id
   WHERE f.user_id IS NOT NULL
     AND fm.category = v_meme.category
     -- Don't tell someone about their own upload; they get milestones instead.
     AND (v_meme.uploader_id IS NULL OR f.user_id <> v_meme.uploader_id)
     AND (
       v_meme.language IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.id = f.user_id AND p.preferred_language IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.profiles p
                   WHERE p.id = f.user_id AND p.preferred_language = v_meme.language)
     )
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


-- =========================================================
-- 8. RPC: notify_download_milestone
-- =========================================================
-- Congratulates an uploader when their content crosses a download threshold.
-- Called from the download tracker, which fires on every download, so this
-- has to be cheap and must not notify twice for the same threshold — hence the
-- dedupe_key carrying the threshold value.
CREATE OR REPLACE FUNCTION public.notify_download_milestone(p_meme_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_meme      public.memes;
  v_threshold BIGINT;
  v_count     INTEGER;
BEGIN
  SELECT * INTO v_meme FROM public.memes WHERE id = p_meme_id;
  IF NOT FOUND OR v_meme.uploader_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Highest threshold the current count has reached, if any.
  SELECT MAX(t) INTO v_threshold
    FROM unnest(ARRAY[100, 500, 1000, 5000, 10000, 50000, 100000]::BIGINT[]) AS t
   WHERE v_meme.download_count >= t;

  IF v_threshold IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.notifications
    (user_id, type, title, message, link, thumbnail, dedupe_key)
  VALUES (
    v_meme.uploader_id,
    'milestone',
    'Your upload reached ' || v_threshold || ' downloads!',
    v_meme.title,
    CASE WHEN v_meme.category = 'sounds' THEN '/sound/' ELSE '/meme/' END || p_meme_id,
    v_meme.thumbnail_url,
    'milestone:' || p_meme_id || ':' || v_threshold
  )
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
