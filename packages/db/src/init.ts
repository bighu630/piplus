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

function ensureRoleDefaultModelsColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('projects')").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'role_default_models')) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN role_default_models TEXT NOT NULL DEFAULT '{}'");
  }
}

function ensureGitConfigColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('projects')").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'git_config_json')) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN git_config_json TEXT NOT NULL DEFAULT '{}'");
  }
}

function ensureRoleConfigColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('projects')").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'role_config_json')) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN role_config_json TEXT NOT NULL DEFAULT '{}'");
  }
}

function ensureSessionPinnedAtColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>;
  const hasColumn = columns.some((col) => col.name === 'pinned_at');
  if (!hasColumn) {
    sqlite.exec('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER');
  }
}

function ensureProjectPinnedAtColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('projects')").all() as Array<{ name: string }>;
  const hasColumn = columns.some((col) => col.name === 'pinned_at');
  if (!hasColumn) {
    sqlite.exec('ALTER TABLE projects ADD COLUMN pinned_at INTEGER');
  }
}

function ensureMessageRequestIdColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('messages')").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'request_id')) {
    sqlite.exec('ALTER TABLE messages ADD COLUMN request_id TEXT');
  }
}

function ensureProjectTodosTable(sqlite: Database) {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_todos'").all();
  if (tables.length === 0) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS project_todos (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_project_todos_project ON project_todos(project_id)');
  }
}

function ensureModelFallbacksColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'model_fallbacks_json')) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN model_fallbacks_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function ensureSessionWorktreePathColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'worktree_path')) {
    sqlite.exec('ALTER TABLE sessions ADD COLUMN worktree_path TEXT');
  }
}

function ensureCrossProjectSourceColumn(sqlite: Database) {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === 'cross_project_source_json')) {
    sqlite.exec('ALTER TABLE sessions ADD COLUMN cross_project_source_json TEXT');
  }
}

function ensureBuiltinRows(sqlite: Database) {
  const now = Date.now();
  const seedPassword = Bun.password.hashSync('seed123', 'bcrypt');
  const forceRolePrompts = Bun.env.PIPLUS_FORCE_ROLE_PROMPTS === 'true';

  const PLANNER_PROMPT = '你是项目负责人——负责技术决策、架构监督和可行性评估。你不读取代码、不搜索文件、不亲自实现任何功能。将所有调查和执行工作委派给执行者。\n\n## 你的职责\n- 对于技术选型、架构设计、模块划分和整体规划，直接与用户本人讨论——不要将此对齐工作委派给 `feature_lead`。如有需要，你可以创建 `worker` 会话来调研技术方案。\n- 评估一个需求或 bug 是否可以处理\n- 对于调研工作（读代码、搜索、研究），使用 `spawn_session` 创建 worker 子会话并设置 `wait=true` —— 如果任务独立，可以并行运行多个 worker\n- 收集 worker 结果后，决定：\n  - 可行 → 创建 `feature_lead`（新功能）或 `bugfix_lead`（Bug）来接手\n    - 将你的调研发现、相关文件路径、代码引用和任何上下文信息打包到 `spawn_session` 的 `objective`、`scope` 和 `task` 字段中，让后续负责人能立刻开始工作\n  - 不可行 → 向用户报告原因\n\n## 可用工具\n- `spawn_session` — 创建子会话。对 worker 使用 `wait=true`（你需要他们的结果）。对 feature_lead/bugfix_lead 使用 `wait=false`（他们独立与用户交互）。\n\n## 重要\n- 绝对不要自己实现代码或编辑文件\n- 绝对不要深入调研——为每个调研任务创建 worker 子会话\n- 对需求/Bug 场景不要做深入的调查或需求挖掘——深入的调查和用户意图对齐由后续的 feature_lead（需求）或 bugfix_lead（Bug）会话直接与用户沟通完成\n- 最大化并行性：同时创建所有独立的 worker\n- 每个 worker 的任务必须清晰明确，没有歧义';
  const BLANK_PROMPT = '你是一个有能力的 AI 助手。直接简洁地回复。';
  const REVIEWER_PROMPT = '你是一个代码审查者。检查代码变更并提供具体、可操作的反馈。\n\n完成后通过 `writeback_to_parent` 报告你的发现。你可能会收到后续消息要求你在修复后继续审查——只需从上次离开的地方继续即可。\n\n## 可用工具\n- `read` — 读取文件\n- `bash` — 运行 shell 命令：git diff/log、测试、linter、grep、find、ls\n- `writeback_to_parent` — 将审查结果报告给请求审查的会话\n\n## 审查维度\n1. **正确性** — 代码是否实现了它声称的功能？边界情况？Off-by-one、null、竞态条件？\n2. **安全性** — 注入风险、硬编码密钥、缺少认证、不安全的反序列化？\n3. **性能** — N+1 查询、不必要的分配、阻塞 I/O、缺少索引？\n4. **可维护性** — 命名清晰、抽象适当、错误处理、测试覆盖？\n5. **一致性** — 遵循现有项目约定？\n\n## 工作方式\n1. 识别变更内容（git diff/log，或读取文件）\n2. 运行测试和 linter（如适用）\n3. 按严重级别组织发现：\n   - 🔴 必须修复：Bug、安全、数据丢失风险\n   - 🟡 应该修复：性能、缺少错误处理、逻辑不清晰\n   - 🟢 建议改进：风格、命名、文档\n4. 对每个发现：解释问题并建议修复\n5. 如果一切正常 → 通过 `writeback_to_parent` 报告批准\n6. 如果发现问题 → 通过 `writeback_to_parent` 列出问题；修复后可能会被要求重新审查\n\n## 重要\n- 引用具体的文件路径和行号\n- 直接且可操作\n- 如果代码干净，简洁说明；如果有问题，精准指出\n- 当被要求继续审查时，复用已有上下文——你已经了解代码\n- **每次审查结束时必须调用 `writeback_to_parent`**——无论是首次审查还是修复后的重新审查。在等待下一步指令之前始终将你的发现写回。';
  const WORKER_PROMPT = '完成任务。完成后使用 writeback_to_parent 汇报结果。';
  const FEATURE_LEAD_PROMPT = '你是需求负责人——负责与用户对齐功能需求，使用可用技能设计方案，并委派执行给 worker。\n\n## 你的职责\n- 与用户澄清功能需求——当细节不明确时提出问题\n- 使用可用技能（brainstorming、writing-plans 等）设计方案\n- 将计划分解为清晰、独立的 worker 任务\n- 创建 worker（`wait=true`）来执行 —— 最大化并行性\n- 将 worker 的结果整合为连贯的可交付物\n- 所有实现工作完成后，执行审查循环：\n  1. 创建一个 `reviewer`（`wait=true`）来审查代码\n  2. 如果 reviewer 发现问题，创建 worker（`wait=true`）来修复\n  3. 使用 `send_message_to_session`（`wait=true`）让同一个 reviewer 继续审查\n  4. 重复直到 reviewer 批准\n- 向用户报告最终总结\n\n## 可用工具\n- `read` — 读取文件\n- `bash` — 运行 shell 命令：ls、grep、find、测试等\n- `edit` — 精确的文本编辑\n- `write` — 创建或覆盖文件\n- `spawn_session` — 将工作委派给 worker 或创建 reviewer。对 worker 和 reviewer 使用 `wait=true`\n- `send_message_to_session` — 向已存在的子会话发送后续消息。用于修复后通知同一个 reviewer 继续审查。目标 session_id 来自 `spawn_session` 的返回值\n\n## 工作流程\n1. **探索**：在与用户交流前先使用 `read`、`bash`、`ls`、`grep` 了解相关代码库。知道什么已存在、正在使用什么模式、改动将落在哪里\n2. **对齐**：理解了代码后，向用户澄清需求细节。提出精准、有依据的问题——不要问那些你自己读代码就能回答的问题。继续直到范围明确\n3. **计划**：使用 brainstorming/writing-plans 技能设计方案。与用户确认\n4. **工作区隔离**：执行前，使用 `using-git-worktrees` 技能为本次功能创建隔离的 git worktree。避免干扰其他任务\n5. **执行**：并行创建 worker 来处理独立任务。每个 worker 获得清晰、无歧义的目标\n6. **整合**：合并 worker 结果。如果出现问题，创建额外 worker 修复\n7. **审查循环**：创建 reviewer（wait=true）→ 发现问题 → 用 worker 修复 → send_message_to_session 继续审查 → 重复直到通过\n8. **报告**：向用户总结完成的工作并提示用户是否需要合并代码\n\n## 重要\n- 你只能创建 `worker` 和 `reviewer` 会话\n- 永远不要创建 `planner`、`feature_lead`、`bugfix_lead` 或 `blank` 会话\n- worker 通过 objective/scope/task 获得任务——要具体，不留歧义\n- 不要过度规划——与用户确认方案后再执行\n- 请务必将方案告知用户并等待用户确认方案以及是否启用git worktree,然后才开始正式执行\n- 保存 reviewer 的 session_id（来自 spawn_session 的返回值）——之后需要用于 send_message_to_session\n- 保持审查循环紧凑：修复 → 通知 reviewer → 重复直到通过';
  const BUGFIX_LEAD_PROMPT = '你是 Bug 负责人——负责与用户对齐 Bug 报告，使用 systematic-debugging 诊断根因，并委派修复给 worker。\n\n## 你的职责\n- 与用户澄清 Bug——重现步骤、预期行为和实际行为、错误信息\n- 使用 systematic-debugging 技能追踪根因\n- 规划修复方案\n- 创建 worker（`wait=true`）来实施修复 —— 最大化并行性\n- 验证修复是否解决该问题\n- 修复完成后，执行审查循环：\n  1. 创建一个 `reviewer`（`wait=true`）来审查代码\n  2. 如果 reviewer 发现问题，创建 worker（`wait=true`）来修复\n  3. 使用 `send_message_to_session`（`wait=true`）让同一个 reviewer 继续审查\n  4. 重复直到 reviewer 批准\n- 向用户报告修复总结\n\n## 可用工具\n- `read` — 读取文件\n- `bash` — 运行 shell 命令：ls、grep、find、测试等\n- `edit` — 精确的文本编辑\n- `write` — 创建或覆盖文件\n- `spawn_session` — 将工作委派给 worker 或创建 reviewer。对 worker 和 reviewer 使用 `wait=true`\n- `send_message_to_session` — 向已存在的子会话发送后续消息。用于修复后通知同一个 reviewer 继续审查。目标 session_id 来自 `spawn_session` 的返回值\n\n## 工作流程\n1. **探索**：使用 `read`、`bash`、`ls`、`grep` 了解相关代码库——定位 Bug 区域，追踪调用路径，检查现有测试\n2. **对齐**：在理解 Bug 相关代码后，向用户澄清细节。提出精准问题——不要问代码已经回答了的问题。获取重现步骤、错误信息、预期和实际行为\n3. **诊断**：使用 systematic-debugging 追踪根因。如有需要创建 worker 调查代码路径\n4. **计划**：设计修复方案。如果修复有显著副作用，与用户确认\n5. **工作区隔离**：执行前，使用 `using-git-worktrees` 技能为本次修复创建隔离的 git worktree。避免干扰其他任务\n6. **执行**：创建 worker 实施修复。运行测试验证\n7. **审查循环**：创建 reviewer（wait=true）→ 发现问题 → 用 worker 修复 → send_message_to_session 继续审查 → 重复直到通过\n8. **报告**：向用户总结修复了什么\n\n## 重要\n- 你只能创建 `worker` 和 `reviewer` 会话\n- 永远不要创建 `planner`、`feature_lead`、`bugfix_lead` 或 `blank` 会话\n- 不要猜测修复方案——先诊断\n- worker 通过 objective/scope/task 获得任务——要具体，关于文件和修改\n- 请务必将方案告知用户并等待用户确认方案以及是否启用git worktree,然后才开始正式执行\n- 保存 reviewer 的 session_id（来自 spawn_session 的返回值）——之后需要用于 send_message_to_session\n- 保持审查循环紧凑：修复 → 通知 reviewer → 重复直到通过';

  sqlite.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)`).run('user_seed', 'seed@local', seedPassword, 'Seed User', now);

  const updateBuiltinRoleStmt = sqlite.prepare(`UPDATE role_templates SET base_prompt = ?, version = ?, config_json = ?, updated_at = ? WHERE id = ? AND visibility = 'builtin'`);

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_planner',
    'planner',
    '内置',
    '规划者',
    '规划并协调工作。将大目标分解为结构化的步骤。',
    PLANNER_PROMPT,
    '{"icon":"Star"}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );
  if (forceRolePrompts) {
    updateBuiltinRoleStmt.run(
      PLANNER_PROMPT,
      '内置',
      '{"icon":"Star"}',
      now,
      'role_planner',
    );
  }

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_blank',
    'blank',
    '内置',
    '空白',
    '一个极简的无预设会话。没有内置工作流或角色设定。',
    BLANK_PROMPT,
    '{"icon":"User"}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );
  if (forceRolePrompts) {
    updateBuiltinRoleStmt.run(
      BLANK_PROMPT,
      '内置',
      '{"icon":"User"}',
      now,
      'role_blank',
    );
  }

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_reviewer',
    'reviewer',
    '内置',
    '审查者',
    '审查代码并返回简洁的批评意见或确认。',
    REVIEWER_PROMPT,
    '{"icon":"Eye"}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );
  if (forceRolePrompts) {
    updateBuiltinRoleStmt.run(
      REVIEWER_PROMPT,
      '内置',
      '{"icon":"Eye"}',
      now,
      'role_reviewer',
    );
  }

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_worker',
    'worker',
    '内置',
    '执行者',
    '执行具体的工作项，不增加流程开销。',
    WORKER_PROMPT,
    '{"icon":"Circle"}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );
  if (forceRolePrompts) {
    updateBuiltinRoleStmt.run(
      WORKER_PROMPT,
      '内置',
      '{"icon":"Circle"}',
      now,
      'role_worker',
    );
  }

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_feature_lead',
    'feature_lead',
    '内置',
    '需求负责人',
    '与用户对齐需求，规划方法，并委派执行给执行者。',
    FEATURE_LEAD_PROMPT,
    '{"icon":"Triangle"}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );
  if (forceRolePrompts) {
    updateBuiltinRoleStmt.run(
      FEATURE_LEAD_PROMPT,
      '内置',
      '{"icon":"Triangle"}',
      now,
      'role_feature_lead',
    );
  }

  sqlite.prepare(`INSERT OR IGNORE INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'role_bugfix_lead',
    'bugfix_lead',
    '内置',
    'Bug 负责人',
    '与用户对齐 Bug 详情，诊断根因，并委派修复给执行者。',
    BUGFIX_LEAD_PROMPT,
    '{"icon":"Bug"}',
    null,
    'system',
    'public',
    1,
    now,
    now,
  );
  if (forceRolePrompts) {
    updateBuiltinRoleStmt.run(
      BUGFIX_LEAD_PROMPT,
      '内置',
      '{"icon":"Bug"}',
      now,
      'role_bugfix_lead',
    );
  }

  // Update existing built-in rows: set version to '内置' and add icon if missing
  const existing = sqlite.prepare("SELECT id, config_json, version FROM role_templates WHERE is_builtin = 1").all() as Array<{ id: string; config_json: string; version: string }>;
  const iconMap: Record<string, string> = {
    role_planner: 'Star', role_blank: 'User', role_reviewer: 'Eye',
    role_worker: 'Circle', role_feature_lead: 'Triangle', role_bugfix_lead: 'Bug',
  };
  for (const row of existing) {
    if (row.version === '内置' && row.config_json.includes('"icon"')) continue;
    try {
      const config = JSON.parse(row.config_json ?? '{}');
      if (!config.icon && iconMap[row.id]) config.icon = iconMap[row.id];
      sqlite.prepare('UPDATE role_templates SET version = ?, config_json = ?, updated_at = ? WHERE id = ?').run(
        '内置',
        JSON.stringify(config),
        Date.now(),
        row.id,
      );
    } catch { /* skip */ }
  }
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
  ensureRoleDefaultModelsColumn(sqlite);
  ensureGitConfigColumn(sqlite);
  ensureRoleConfigColumn(sqlite);
  ensureMessageRequestIdColumn(sqlite);
  ensureSessionPinnedAtColumn(sqlite);
  ensureProjectPinnedAtColumn(sqlite);
  ensureProjectTodosTable(sqlite);
  ensureBuiltinRows(sqlite);
  ensureModelFallbacksColumn(sqlite);
  ensureSessionWorktreePathColumn(sqlite);
  ensureCrossProjectSourceColumn(sqlite);
  sqlite.close();
}

if (import.meta.main) {
  const home = Bun.env.HOME ?? process.env.HOME ?? '/tmp';
  createSeedDb(`${home}/.config/piplus/piplus.sqlite`);
  console.log('db seeded');
}
