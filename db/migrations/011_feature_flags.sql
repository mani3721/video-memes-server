-- Feature flags — admin-controlled on/off switches for site features.
CREATE TABLE IF NOT EXISTS feature_flags (
  key        text        PRIMARY KEY,
  enabled    boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the three initial flags (no-op if they already exist).
INSERT INTO feature_flags (key, enabled) VALUES
  ('feed_tab',     true),
  ('stickers_tab', true)
ON CONFLICT (key) DO NOTHING;
