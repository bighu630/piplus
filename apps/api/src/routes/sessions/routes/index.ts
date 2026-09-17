import type { Hono } from 'hono';
import { createPiClient } from '@piplus/pi-client';
import type { PiClient } from '@piplus/pi-client';
import { registerWebSocketRoutes } from '../../../ws/server';
import { registerChatRoutes } from './chat';
import { registerModelConfigRoutes } from './model-config';
import { registerFilesRoutes } from './files';
import { registerGitRoutes } from './git';
import { registerSessionControlRoutes, registerRuntimeRoutes } from './runtime';
import { registerAskQuestionRoutes } from './ask-question';

/**
 * 组装 sessions 相关路由。调用顺序与拆分前 registerSessionRoutes 内的路由注册顺序一致：
 * chat（info / planner-role-prompt / chat/messages）→ model-config（model / thinking-level）→
 * control（stop / archive）→ files → git → runtime（context-usage / compact / restore-runtime / commands）→
 * WebSocket 路由。
 *
 * 拆分前函数体内没有跨 handler 的可变闭包状态，各子注册函数仅需 piClient。
 */
export function registerSessionRoutes(app: Hono, piClient: PiClient = createPiClient()) {
  registerChatRoutes(app, piClient);
  registerModelConfigRoutes(app, piClient);
  registerSessionControlRoutes(app, piClient);
  registerFilesRoutes(app);
  registerGitRoutes(app);
  registerRuntimeRoutes(app, piClient);
  registerAskQuestionRoutes(app);

  registerWebSocketRoutes(app);
}
