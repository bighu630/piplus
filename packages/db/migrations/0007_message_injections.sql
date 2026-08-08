CREATE TABLE IF NOT EXISTS message_injections (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  message_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_blocks_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_injections_session_time ON message_injections(session_id, created_at);
