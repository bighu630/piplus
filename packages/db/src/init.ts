import { Database } from 'bun:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function findMigrationFile(): string {
  const candidates = [
    join(import.meta.dir, '../migrations/0001_initial.sql'),
    join(import.meta.dir, '../../migrations/0001_initial.sql'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('migration file not found');
}

function ensureSessionLocatorColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>;
  const hasColumn = columns.some((col) => col.name === 'pi_session_locator_json');
  if (!hasColumn) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN pi_session_locator_json TEXT NOT NULL DEFAULT '{}'");
  }
}

function ensureSessionModelColumns(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>;
  for (const col of ['current_model_provider', 'current_model_id']) {
    if (!columns.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
    }
  }
}

function ensureProjectPathColumns(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('projects')").all() as Array<{ name: string }>;
  for (const col of ['project_path', 'source_type', 'source_url']) {
    if (!columns.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }
}

function ensureBuiltinRows(sqlite: Database) {
  const now = Date.now();
  const seedPassword = Bun.password.hashSync('seed123', 'bcrypt');

  sqlite.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)`).run('user_seed', 'seed@local', seedPassword, 'Seed User', now);

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_planner',
    'planner',
    '1',
    'Planner',
    'Plans and coordinates work. Breaks large goals into structured steps.',
    'You are a Planner. Organize the task into manageable steps. Output a structured plan.',
    '{}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_blank',
    'blank',
    '1',
    'Blank',
    'A minimal, no-preset session. No embedded workflow or persona.',
    'You are a capable AI assistant. Respond directly and concisely.',
    '{}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_reviewer',
    'reviewer',
    '1',
    'Reviewer',
    'Reviews work and returns concise critiques or confirmations.',
    'You are a Reviewer. Evaluate the target work carefully and respond with focused findings.',
    '{}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_worker',
    'worker',
    '1',
    'Worker',
    'Executes concrete work items without adding process overhead.',
    'You are a Worker. Complete the given task directly and report the result.',
    '{}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );
}

export function createSeedDb(path: string) {
  const sqlite = new Database(path, { create: true });

  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
  if (tables.length === 0) {
    const migrationFile = findMigrationFile();
    const sql = readFileSync(migrationFile, 'utf-8');
    sqlite.exec(sql);
  }

  ensureSessionLocatorColumn(sqlite);
  ensureSessionModelColumns(sqlite);
  ensureProjectPathColumns(sqlite);
  ensureBuiltinRows(sqlite);
  sqlite.close();
}

if (import.meta.main) {
  createSeedDb('piplus.sqlite');
  console.log('db seeded');
}
