CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  archived_at INTEGER,
  archived_by TEXT,
  last_activity_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS role_templates (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  base_prompt TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_by TEXT,
  owner_type TEXT NOT NULL,
  visibility TEXT NOT NULL,
  is_builtin INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  parent_session_id TEXT,
  root_session_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  role_template_id TEXT NOT NULL,
  pi_session_id TEXT NOT NULL,
  pi_session_locator_json TEXT NOT NULL DEFAULT '{}',
  requested_by_message_id TEXT,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL,
  status TEXT NOT NULL,
  runtime_status TEXT NOT NULL,
  last_activity_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_stop_at INTEGER,
  last_runtime_error TEXT,
  created_by TEXT NOT NULL,
  archived_at INTEGER,
  archived_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  role_base_prompt_snapshot TEXT NOT NULL,
  user_supplied_prompt TEXT NOT NULL,
  parent_supplied_prompt TEXT NOT NULL,
  compiled_prompt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  pi_message_id TEXT,
  message_kind TEXT NOT NULL,
  source_session_id TEXT,
  role TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_blocks_json TEXT,
  content_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  parent_message_id TEXT,
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_sync_states (
  session_id TEXT PRIMARY KEY NOT NULL,
  sync_status TEXT NOT NULL,
  last_synced_at INTEGER,
  last_pi_message_id TEXT,
  last_pi_event_id TEXT,
  last_error TEXT,
  retry_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES auth_user(id)
);

CREATE TABLE IF NOT EXISTS auth_account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_user(id),
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
