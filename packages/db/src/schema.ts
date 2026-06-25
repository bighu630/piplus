import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const nullableTimestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull(),
  status: text('status').notNull().default('active'),
  projectPath: text('project_path').notNull().default(''),
  sourceType: text('source_type').notNull().default('existing'),
  sourceUrl: text('source_url').notNull().default(''),
  archivedAt: nullableTimestamp('archived_at'),
  archivedBy: text('archived_by'),
  lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const roleTemplates = sqliteTable('role_templates', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  version: text('version').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  basePrompt: text('base_prompt').notNull().default(''),
  configJson: text('config_json').notNull().default('{}'),
  createdBy: text('created_by'),
  ownerType: text('owner_type').notNull().default('system'),
  visibility: text('visibility').notNull().default('public'),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(true),
  archivedAt: nullableTimestamp('archived_at'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  parentSessionId: text('parent_session_id'),
  rootSessionId: text('root_session_id').notNull(),
  depth: integer('depth').notNull().default(0),
  roleTemplateId: text('role_template_id').notNull(),
  piSessionId: text('pi_session_id').notNull(),
  piSessionLocatorJson: text('pi_session_locator_json').notNull().default('{}'),
  requestedByMessageId: text('requested_by_message_id'),
  title: text('title').notNull(),
  titleSource: text('title_source').notNull().default('default'),
  status: text('status').notNull().default('active'),
  runtimeStatus: text('runtime_status').notNull().default('idle'),
  lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }).notNull(),
  lastRunAt: nullableTimestamp('last_run_at'),
  lastStopAt: nullableTimestamp('last_stop_at'),
  lastRuntimeError: text('last_runtime_error'),
  createdBy: text('created_by').notNull(),
  archivedAt: nullableTimestamp('archived_at'),
  archivedBy: text('archived_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  roleBasePromptSnapshot: text('role_base_prompt_snapshot').notNull().default(''),
  userSuppliedPrompt: text('user_supplied_prompt').notNull().default(''),
  parentSuppliedPrompt: text('parent_supplied_prompt').notNull().default(''),
  compiledPrompt: text('compiled_prompt').notNull().default(''),
  currentModelProvider: text('current_model_provider'),
  currentModelId: text('current_model_id'),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  piMessageId: text('pi_message_id'),
  messageKind: text('message_kind').notNull().default('normal'),
  sourceSessionId: text('source_session_id'),
  role: text('role').notNull(),
  contentText: text('content_text').notNull(),
  contentBlocksJson: text('content_blocks_json'),
  contentVersion: integer('content_version').notNull().default(0),
  requestId: text('request_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sessionEvents = sqliteTable('session_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  parentMessageId: text('parent_message_id'),
  sequence: integer('sequence').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sessionSyncStates = sqliteTable('session_sync_states', {
  sessionId: text('session_id').primaryKey(),
  syncStatus: text('sync_status').notNull().default('idle'),
  lastSyncedAt: nullableTimestamp('last_synced_at'),
  lastPiMessageId: text('last_pi_message_id'),
  lastPiEventId: text('last_pi_event_id'),
  lastError: text('last_error'),
  retryCount: integer('retry_count').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const schema = {
  users,
  projects,
  roleTemplates,
  sessions,
  messages,
  sessionEvents,
  sessionSyncStates,
  auditEvents,
};

// --- better-auth tables ---
export const authUser = sqliteTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const authSession = sqliteTable('auth_session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => authUser.id),
});

export const authAccount = sqliteTable('auth_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUser.id),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const authVerification = sqliteTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
});

export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};
