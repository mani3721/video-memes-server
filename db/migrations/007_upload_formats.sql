-- ─────────────────────────────────────────────────────────────────────────────
-- 007 — accept the image formats uploads already allow
--
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to run more than once.
--
-- Why: routes/upload.js accepts image/jpeg and image/webp — they are in its
-- ALLOWED map with size limits, and its own 415 message advertises "MP4, WebM,
-- GIF, PNG, JPEG, WebP, MP3, WAV" to the user. But memes.format only permitted
-- ('MP4','WebM','GIF','PNG','MP3','WAV'), so every JPEG and WebP upload was
-- rejected by this CHECK *after* the file and its thumbnail had already been
-- written to Spaces. The user saw "File uploaded to Spaces but metadata save
-- failed. Contact support." and an orphaned pair of objects was left behind.
--
-- Verified against the live database before writing this: inserts with
-- format='JPEG' and format='WEBP' were both rejected by the constraint, while
-- MP4/GIF/PNG/MP3/WAV were accepted.
--
-- 'WebM' is already permitted and needs nothing here — that one was purely a
-- code bug (the old ext.toUpperCase() produced 'WEBM'), fixed in upload.js.
--
-- The constraint is the contract between the upload allowlist and the column.
-- Adding to ALLOWED in upload.js without adding here breaks uploads again, so
-- both sides carry a pointer to the other.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.memes DROP CONSTRAINT IF EXISTS memes_format_check;

ALTER TABLE public.memes
  ADD CONSTRAINT memes_format_check
  CHECK (format IN ('MP4', 'WebM', 'GIF', 'PNG', 'JPEG', 'WEBP', 'MP3', 'WAV'));
