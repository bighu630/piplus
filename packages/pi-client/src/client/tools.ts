import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { PiToolDef } from '../types';
import type { ClientDeps } from './deps';
import { collectCommands } from './commands';

export async function bindToolRuntime(
  deps: ClientDeps,
  sessionId: string,
  tools: PiToolDef[],
  handler: (toolName: string, args: Record<string, unknown>, context: { sessionId: string }) => Promise<unknown>,
  cwd?: string,
): Promise<void> {
  const session = deps.runtimeRegistry.ensure(sessionId, undefined, cwd);
  session.toolDefs = tools;
  session.toolHandler = handler;

  if (session.agentSession) {
    session.agentSession.dispose();
    if (session.idleCleanupTimer) { clearTimeout(session.idleCleanupTimer); session.idleCleanupTimer = undefined; }
  }

  const loader = new DefaultResourceLoader({
    cwd: session.cwd,
    agentDir: getAgentDir(),
    extensionFactories: [
      (pi) => {
        for (const toolDef of tools) {
          pi.registerTool({
            name: toolDef.name,
            label: toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters as any,
            execute: async (_toolCallId, params) => {
              const result = await handler(toolDef.name, params as Record<string, unknown>, { sessionId });
              return {
                content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
                details: {},
              };
            },
          });
        }
      },
    ],
  });
  await loader.reload();

  const sessionManager = SessionManager.open(session.locator.sessionFile);
  const sessionContext = sessionManager.buildSessionContext();
  console.log('[pi-client] bindToolRuntime start', {
    sessionId,
    locatorFile: session.locator.sessionFile,
    cwd: session.cwd,
    sessionContextModelProvider: sessionContext.model?.provider ?? null,
    sessionContextModelId: sessionContext.model?.modelId ?? null,
    registryModelProvider: session.model?.provider ?? null,
    registryModelId: session.model?.id ?? null,
  });
  const options: Parameters<typeof createAgentSession>[0] = {
    cwd: session.cwd,
    resourceLoader: loader,
    sessionManager,
    modelRuntime: deps.modelRuntime,
  };

  if (sessionContext.model) {
    const available = await deps.modelRegistry.getAvailable();
    const restored = available.find((m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId);
    if (restored) {
      options.model = restored;
      console.log('[pi-client] bindToolRuntime restored session model', {
        sessionId,
        provider: restored.provider,
        id: restored.id,
      });
    } else {
      options.model = await deps.ensureModel();
      console.log('[pi-client] bindToolRuntime session model not in registry, fallback default', {
        sessionId,
        provider: options.model?.provider ?? null,
        id: options.model?.id ?? null,
      });
    }
  } else if (session.model) {
    const available = await deps.modelRegistry.getAvailable();
    const cached = available.find(
      (candidate: any) => candidate.provider === session.model!.provider && candidate.id === session.model!.id,
    );
    if (cached) {
      options.model = cached;
      console.log('[pi-client] bindToolRuntime using cached registry model', {
        sessionId,
        provider: cached.provider,
        id: cached.id,
      });
    } else {
      options.model = await deps.ensureModel();
      console.log('[pi-client] bindToolRuntime cached model not found in registry, fallback default', {
        sessionId,
        provider: options.model?.provider ?? null,
        id: options.model?.id ?? null,
      });
    }
  } else {
    options.model = await deps.ensureModel();
    console.log('[pi-client] bindToolRuntime no cached model, fallback default', {
      sessionId,
      provider: options.model?.provider ?? null,
      id: options.model?.id ?? null,
    });
  }

  const { session: agentSession } = await createAgentSession(options);
  session.agentSession = agentSession;
  if (agentSession.model) {
    session.model = {
      provider: agentSession.model.provider,
      id: agentSession.model.id,
      label: agentSession.model.name ?? `${agentSession.model.provider}/${agentSession.model.id}`,
    };
  }
  // Collect slash commands from extensions, prompt templates, and skills
  try {
    session.commands = collectCommands(agentSession);
    console.log('[pi-client] bindToolRuntime collected commands', { sessionId, count: session.commands.length });
  } catch (err) {
    console.warn('[pi-client] bindToolRuntime failed to collect commands', { sessionId, error: String(err) });
  }

  console.log('[pi-client] bindToolRuntime done', {
    sessionId,
    provider: session.model?.provider ?? null,
    id: session.model?.id ?? null,
  });
}

export async function registerTools(deps: ClientDeps, _tools: PiToolDef[]): Promise<void> {
  // Stub: tools are registered in-memory only.
  // Real PI SDK adapter will register tools with the PI agent runtime.
}
