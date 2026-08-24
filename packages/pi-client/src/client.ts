import {
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { RuntimeRegistry } from './runtime-registry';
import type { PiClient, PiToolDef } from './types';

export { mapAgentSessionEvent } from './client/event-mapping';

import * as commandsModule from './client/commands';
import * as contextModule from './client/context';
import * as lifecycle from './client/session-lifecycle';
import * as messaging from './client/messaging';
import * as modelConfig from './client/model-config';
import * as providers from './client/providers';
import * as toolsModule from './client/tools';
import type { ClientDeps } from './client/deps';

const runtimeRegistry = new RuntimeRegistry();
const modelRuntime = await ModelRuntime.create();
const modelRegistry = new ModelRegistry(modelRuntime);

export function createPiClient(): PiClient {
  let resolvedModel: any;
  (async () => {
    const available = await modelRegistry.getAvailable();
    resolvedModel = available[0];
  })();

  async function ensureModel(): Promise<any> {
    if (resolvedModel) return resolvedModel;
    const available = await modelRegistry.getAvailable();
    resolvedModel = available[0];
    return resolvedModel;
  }

  const client: PiClient = {
    async createSession(input) {
      return lifecycle.createSession(deps, input);
    },
    async restoreRuntime(sessionId, locator, cwd) {
      return lifecycle.restoreRuntime(deps, sessionId, locator, cwd);
    },
    async ensureRuntime(sessionId, options) {
      return lifecycle.ensureRuntime(deps, sessionId, options);
    },
    async injectPromptIfNeeded(sessionId) {
      return messaging.injectPromptIfNeeded(deps, sessionId);
    },
    async subscribeSession(sessionId, listener) {
      return messaging.subscribeSession(deps, sessionId, listener);
    },
    async getHistory(_sessionId, locator, cursor, limit = 50) {
      return messaging.getHistory(deps, _sessionId, locator, cursor, limit);
    },
    async sendMessage(sessionId, content, options) {
      return messaging.sendMessage(deps, sessionId, content, options);
    },
    async stopSession(sessionId) {
      return messaging.stopSession(deps, sessionId);
    },
    async closeRuntime(sessionId) {
      return lifecycle.closeRuntime(deps, sessionId);
    },

    /** 删除/归档会话时释放 runtime 并删除 registry 条目（含 createSession 的 piSessionId 别名条目）。 */
    async disposeSession(sessionId, locator) {
      return lifecycle.disposeSession(deps, sessionId, locator);
    },

    /**
     * Close all idle runtimes so they pick up new settings on next restore.
     * Running sessions are left untouched.
     */
    async reloadIdleRuntimes() {
      return providers.reloadIdleRuntimes(deps);
    },
    async listAvailableModels() {
      return modelConfig.listAvailableModels(deps);
    },

    async getCurrentModel(sessionId) {
      return modelConfig.getCurrentModel(deps, sessionId);
    },

    async completeModel(input) {
      return modelConfig.completeModel(deps, input);
    },

    async setSessionModel(sessionId, locator, modelRef, cwd) {
      return modelConfig.setSessionModel(deps, sessionId, locator, modelRef, cwd);
    },

    async getThinkingLevel(sessionId, locator, cwd) {
      return modelConfig.getThinkingLevel(deps, sessionId, locator, cwd);
    },

    async getAvailableThinkingLevels(sessionId, locator, cwd) {
      return modelConfig.getAvailableThinkingLevels(deps, sessionId, locator, cwd);
    },

    async setThinkingLevel(sessionId, locator, level, cwd) {
      return modelConfig.setThinkingLevel(deps, sessionId, locator, level, cwd);
    },

    async bindToolRuntime(sessionId, tools, handler, cwd) {
      return toolsModule.bindToolRuntime(deps, sessionId, tools, handler, cwd);
    },

    async getContextUsage(sessionId, locator) {
      return contextModule.getContextUsage(deps, sessionId, locator);
    },

    async compactSession(sessionId, locator, cwd) {
      return contextModule.compactSession(deps, sessionId, locator, cwd);
    },

    async getCommands(sessionId) {
      return commandsModule.getCommands(deps, sessionId);
    },

    async executeCommand(sessionId, content) {
      return commandsModule.executeCommand(deps, sessionId, content);
    },

    async registerTools(_tools) {
      return toolsModule.registerTools(deps, _tools);
    },

    async registerProvider(providerName, config) {
      return providers.registerProvider(deps, providerName, config);
    },

    async setProviderApiKey(provider, apiKey) {
      return providers.setProviderApiKey(deps, provider, apiKey);
    },

    async removeProviderApiKey(provider) {
      return providers.removeProviderApiKey(deps, provider);
    },

    async getProviderAuthStatus(provider) {
      return providers.getProviderAuthStatus(deps, provider);
    },

    isFirstConversation(sessionId) {
      return runtimeRegistry.isFirstConversation(sessionId);
    },

    getRuntimeState(sessionId) {
      return runtimeRegistry.getRuntimeState(sessionId);
    },
  };

  const deps: ClientDeps = {
    runtimeRegistry,
    modelRuntime,
    modelRegistry,
    ensureModel,
    client,
  };

  return client;
}
