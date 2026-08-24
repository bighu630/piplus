import type { ActiveSessionRuntime } from '../runtime-registry';
import type { PiSlashCommandInfo } from '../types';
import type { ClientDeps } from './deps';

export const BUILTIN_COMMANDS: PiSlashCommandInfo[] = [
  { name: 'help', description: '显示帮助信息', source: 'extension' },
  { name: 'model', description: '显示 / 切换模型', source: 'extension' },
  { name: 'compact', description: '压缩上下文', source: 'extension' },
  { name: 'session', description: '查看会话信息', source: 'extension' },
  { name: 'stats', description: '查看会话统计', source: 'extension' },
  { name: 'thinking', description: '显示 / 切换思考层级', source: 'extension' },
  { name: 'reload', description: '重新加载扩展', source: 'extension' },
  { name: 'active-tools', description: '显示当前激活的工具', source: 'extension' },
];

/** Check if a message should be treated as a slash command */
export function isSlashCommandMessage(content: string): boolean {
  return /^\s*\//.test(content);
}

export function parseSlashCommand(content: string): { name: string; args: string } {
  const match = content.trim().match(/^\/(\S+)(?:\s+(.*))?$/);
  if (!match) return { name: '', args: '' };
  return { name: match[1], args: (match[2] || '').trim() };
}

/** Execute a builtin slash command and return the response text */
export async function executeBuiltinCommand(
  name: string,
  args: string,
  sessionId: string,
  session: ActiveSessionRuntime | undefined,
  allCommands: PiSlashCommandInfo[],
): Promise<string | null> {
  const info = session;
  switch (name) {
    case 'help': {
      const lines = allCommands.map((c) => `  /${c.name} — ${c.description || ''}`);
      return `可用命令：\n${lines.join('\n')}`;
    }
    case 'model': {
      if (info?.model) {
        let text = `当前模型：${info.model.label} (${info.model.provider}/${info.model.id})`;
        if (info.agentSession) {
          const thinking = info.agentSession.thinkingLevel;
          text += `\n思考层级：${thinking}`;
          const ctx = info.agentSession.getContextUsage();
          if (ctx) text += `\n上下文用量：${ctx.tokens ?? '?'} / ${ctx.contextWindow} (${ctx.percent ?? '?'}%)`;
        }
        return text;
      }
      return '未设置模型。';
    }
    case 'session':
      return `会话 ID：${sessionId}`;
    case 'stats': {
      if (info?.agentSession) {
        try {
          const stats = info.agentSession.getSessionStats();
          return [
            `消息数：${stats.totalMessages}`,
            `  - 用户消息：${stats.userMessages}`,
            `  - 助手消息：${stats.assistantMessages}`,
            `  - 工具调用：${stats.toolCalls}`,
            `  - 工具结果：${stats.toolResults}`,
            `Token 用量：${stats.tokens.total.toLocaleString()}`,
            `  - 输入：${stats.tokens.input.toLocaleString()}`,
            `  - 输出：${stats.tokens.output.toLocaleString()}`,
            `费用：$${stats.cost.toFixed(4)}`,
            stats.contextUsage
              ? `上下文：${stats.contextUsage.tokens ?? '?'} / ${stats.contextUsage.contextWindow} (${stats.contextUsage.percent ?? '?'}%)`
              : '',
          ].filter(Boolean).join('\n');
        } catch {
          return '获取统计信息失败。';
        }
      }
      return '会话统计暂不可用（runtime 未连接）。';
    }
    case 'compact': {
      if (info?.agentSession) {
        try {
          await info.agentSession.compact();
          return '上下文已压缩。';
        } catch {
          return '压缩失败，请稍后重试。';
        }
      }
      return '无法压缩（runtime 未连接）。';
    }
    case 'thinking': {
      if (info?.agentSession) {
        const level = info.agentSession.thinkingLevel;
        const available = info.agentSession.getAvailableThinkingLevels?.() ?? [];
        return `思考层级：${level}${available.length ? `（可用：${available.join(', ')}）` : ''}`;
      }
      return '思考层级暂不可用（runtime 未连接）。';
    }
    case 'reload':
      return '扩展重载功能需通过 Pi 终端执行。';
    case 'active-tools': {
      if (info?.agentSession) {
        const tools = info.agentSession.getActiveToolNames();
        return `激活的工具：${tools.join(', ') || '(无)'}`;
      }
      return '工具列表暂不可用（runtime 未连接）。';
    }
    default:
      return null; // Unknown command — let agentSession handle it
  }
}

export function collectCommands(agentSession: any): PiSlashCommandInfo[] {
  const commands: PiSlashCommandInfo[] = [];

  // Extension commands
  try {
    const extensionCommands = agentSession.extensionRunner?.getRegisteredCommands();
    if (Array.isArray(extensionCommands)) {
      for (const cmd of extensionCommands) {
        commands.push({
          name: cmd.name,
          description: cmd.description,
          source: 'extension' as const,
        });
      }
    }
  } catch {
    // Extension runner may not be ready
  }

  // Prompt templates
  try {
    const promptTemplates = agentSession.promptTemplates;
    if (Array.isArray(promptTemplates)) {
      for (const pt of promptTemplates) {
        commands.push({
          name: pt.name,
          description: pt.description,
          source: 'prompt' as const,
        });
      }
    }
  } catch {
    // Resource loader may not be ready
  }

  // Skills
  try {
    const skillsResult = agentSession.resourceLoader?.getSkills();
    if (skillsResult?.skills && Array.isArray(skillsResult.skills)) {
      for (const skill of skillsResult.skills) {
        commands.push({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: 'skill' as const,
        });
      }
    }
  } catch {
    // Resource loader may not be ready
  }

  return commands;
}

export async function getCommands(deps: ClientDeps, sessionId: string): Promise<PiSlashCommandInfo[]> {
  const session = deps.runtimeRegistry.get(sessionId);
  const dynamic = session?.commands ?? [];
  // Merge builtins + dynamic, deduplicate by name
  const seen = new Set<string>();
  const merged: PiSlashCommandInfo[] = [];
  for (const cmd of [...BUILTIN_COMMANDS, ...dynamic]) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      merged.push(cmd);
    }
  }
  return merged;
}

export async function executeCommand(deps: ClientDeps, sessionId: string, content: string): Promise<string | null> {
  const session = deps.runtimeRegistry.get(sessionId) ?? null;
  const { name, args } = parseSlashCommand(content);
  if (!name) return null;
  // Merge builtins + dynamic for /help display
  const dynamic = session?.commands ?? [];
  const seen = new Set<string>();
  const allCommands: PiSlashCommandInfo[] = [];
  for (const cmd of [...BUILTIN_COMMANDS, ...dynamic]) {
    if (!seen.has(cmd.name)) { seen.add(cmd.name); allCommands.push(cmd); }
  }
  return executeBuiltinCommand(name, args, sessionId, session as any, allCommands);
}
