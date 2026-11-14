-- Indexes + uniqueness for the D1 tables imported from the Supabase CSVs.
-- The CSV import created tables with primary keys only. These restore the
-- uniqueness rules Postgres enforced (the app relies on them: a duplicate
-- insert returns 409 and is treated as "already exists") and the indexes the
-- API filters / sorts on. Safe to re-run.

CREATE INDEX IF NOT EXISTS memes_category ON memes (category);
CREATE INDEX IF NOT EXISTS memes_published_hot_dl ON memes (is_published, is_hot DESC, download_count DESC);
CREATE INDEX IF NOT EXISTS memes_published_created ON memes (is_published, created_at DESC);
CREATE INDEX IF NOT EXISTS memes_created ON memes (created_at DESC);
CREATE INDEX IF NOT EXISTS memes_uploader ON memes (uploader_id);
CREATE UNIQUE INDEX IF NOT EXISTS memes_spaces_key ON memes (spaces_key);

CREATE INDEX IF NOT EXISTS profiles_role ON profiles (role);

CREATE UNIQUE INDEX IF NOT EXISTS favorites_user_meme ON favorites (user_id, meme_id);
CREATE INDEX IF NOT EXISTS favorites_meme ON favorites (meme_id);

CREATE INDEX IF NOT EXISTS collections_user ON collections (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS collection_items_col_meme ON collection_items (collection_id, meme_id);
CREATE INDEX IF NOT EXISTS collection_items_user ON collection_items (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS reaction_events_actor ON reaction_events (meme_id, reaction, actor_key);
CREATE INDEX IF NOT EXISTS reaction_events_actor_key ON reaction_events (actor_key);

CREATE INDEX IF NOT EXISTS download_events_created_meme ON download_events (created_at, meme_id);

CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications (dedupe_key);
CREATE INDEX IF NOT EXISTS notification_reads_user ON notification_reads (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_slug ON blog_posts (slug);
CREATE INDEX IF NOT EXISTS blog_posts_status_pub ON blog_posts (status, published_at DESC);

CREATE TABLE IF NOT EXISTS download_history (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT,
  "meme_id" TEXT,
  "created_at" TEXT
);
CREATE INDEX IF NOT EXISTS download_history_user ON download_history (user_id, created_at DESC);
