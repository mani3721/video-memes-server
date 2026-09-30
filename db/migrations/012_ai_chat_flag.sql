-- AI Chat tab flag — kill switch for the ModelScope-backed assistant.
-- The free tier is a hard 2,000 requests/day for the whole account, so the
-- tab needs to be hideable without a redeploy when the quota is exhausted.
INSERT INTO feature_flags (key, enabled) VALUES
  ('ai_chat_tab', true)
ON CONFLICT (key) DO NOTHING;
