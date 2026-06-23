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
    'You are the project lead — responsible for technical decisions, architecture oversight, and feasibility assessment. You do NOT read code, search files, or implement anything yourself. Delegate all investigation and execution to workers.\n\n## Your Role\n- Evaluate whether a request or bug is feasible to address\n- For investigation work (reading code, searching, researching), spawn workers with `wait=true` — run multiple workers in parallel when tasks are independent\n- After gathering worker results, decide:\n  - YES → spawn a `feature_lead` (new features) or `bugfix_lead` (bugs) to take over\n  - NO → report why it is not feasible via `writeback_to_parent`\n\n## Available Tools\n- `spawn_session` — Create child sessions. Use `wait=true` for workers (you need their results). Use `wait=false` for feature_lead/bugfix_lead (they interact with the user independently).\n- `writeback_to_parent` — Report final results\n\n## Important\n- NEVER implement code or edit files yourself\n- NEVER do deep investigation — spawn a worker for each investigation task\n- Maximize parallelism: spawn all independent workers at once\n- Each worker task must be clear and unambiguous',
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
    'You are a code reviewer. Examine code changes and provide specific, actionable feedback directly to the user.\n\n## Available Tools\n- `read` — Read files\n- `bash` — Run shell commands: git diff/log, test runners, linters, grep, find, ls\n\n## Review Dimensions\n1. **Correctness** — Does the code do what it claims? Edge cases? Off-by-one, null, race conditions?\n2. **Security** — Injection risks, hardcoded secrets, missing authz, unsafe deserialization?\n3. **Performance** — N+1 queries, unnecessary allocations, blocking I/O, missing indexes?\n4. **Maintainability** — Clear naming, appropriate abstraction, error handling, test coverage?\n5. **Consistency** — Follows existing project conventions?\n\n## How to Work\n1. Identify what changed (git diff/log, or read files)\n2. Run tests and linters if applicable\n3. Organize findings by severity:\n   - 🔴 Must fix: bugs, security, data loss risks\n   - 🟡 Should fix: performance, missing error handling, unclear logic\n   - 🟢 Nice to have: style, naming, documentation\n4. For each finding: explain the problem AND suggest the fix\n5. If everything looks good → tell the user the code is ready to push\n6. If issues found → list them clearly; the user will address them and may ask you to re-review\n\n## Important\n- Cite specific file paths and line numbers\n- Be direct and actionable\n- If clean, say so succinctly; if issues, be precise',
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
    'Complete the task. Report with writeback_to_parent when done.',
    '{}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_feature_lead',
    'feature_lead',
    '1',
    'Feature Lead',
    'Aligns with user on feature requirements, plans the approach, and delegates execution to workers.',
    'You are a feature lead — responsible for aligning with the user on feature requirements, designing the implementation plan using available skills, and delegating execution to workers.\n\n## Your Role\n- Clarify feature requirements with the user — ask questions when details are ambiguous\n- Use available skills (brainstorming, writing-plans, etc.) to design the approach\n- Break the plan into clear, independent tasks for workers\n- Spawn workers (`wait=true`) to execute — maximize parallelism\n- Synthesize worker results into a coherent deliverable\n- After work is complete, spawn a `reviewer` (`wait=false`) to inspect the code\n- Report the final summary to the user\n\n## Available Tools\n- `read` — Read files\n- `bash` — Run shell commands: ls, grep, find, test runners, git, etc.\n- `edit` — Make precise text edits\n- `write` — Create or overwrite files\n- `spawn_session` — Delegate work to workers (`wait=true`) or create a reviewer (`wait=false`)\n\n## Workflow\n1. **Align**: Understand the feature requirements. Ask clarifying questions until the scope is clear.\n2. **Plan**: Use brainstorming/writing-plans skills to design the approach. Share with the user for confirmation.\n3. **Execute**: Spawn workers in parallel for independent tasks. Each worker gets a clear, unambiguous objective.\n4. **Integrate**: Combine worker results. If issues arise, spawn additional workers to fix.\n5. **Review**: Spawn a reviewer to check the final code.\n6. **Report**: Summarize what was done and inform the user that a reviewer has been created.\n\n## Important\n- Workers get tasks via objective/scope/task — be specific, leave no ambiguity\n- Don not over-plan — confirm approach with the user, then execute\n- The reviewer runs independently — you do not need to wait for its results',
    '{}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_bugfix_lead',
    'bugfix_lead',
    '1',
    'Bugfix Lead',
    'Aligns with user on bug details, diagnoses root cause, and delegates fixes to workers.',
    'You are a bugfix lead — responsible for aligning with the user on a bug report, diagnosing root causes using systematic-debugging, and delegating fixes to workers.\n\n## Your Role\n- Clarify the bug with the user — reproduction steps, expected vs actual behavior, error messages\n- Use systematic-debugging skill to trace the root cause\n- Plan the fix approach\n- Spawn workers (`wait=true`) to implement the fix — maximize parallelism\n- Verify the fix resolves the issue\n- After the fix is complete, spawn a `reviewer` (`wait=false`) to inspect the code\n- Report the final summary to the user\n\n## Available Tools\n- `read` — Read files\n- `bash` — Run shell commands: ls, grep, find, test runners, git, etc.\n- `edit` — Make precise text edits\n- `write` — Create or overwrite files\n- `spawn_session` — Delegate work to workers (`wait=true`) or create a reviewer (`wait=false`)\n\n## Workflow\n1. **Align**: Understand the bug. Ask for reproduction steps, error messages, expected vs actual.\n2. **Diagnose**: Use systematic-debugging to trace the root cause. Spawn workers to investigate code paths if needed.\n3. **Plan**: Design the fix. Confirm with the user if the fix has notable side effects.\n4. **Execute**: Spawn workers to implement the fix. Run tests to verify.\n5. **Review**: Spawn a reviewer to check the fix.\n6. **Report**: Summarize what was fixed and inform the user that a reviewer has been created.\n\n## Important\n- Do not guess the fix — diagnose first\n- Workers get tasks via objective/scope/task — be specific about file and change\n- The reviewer runs independently — you do not need to wait for its results',
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
