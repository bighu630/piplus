import { createDb } from '@piplus/db/client';
import { finalizeForcedRuntimeReclaim } from '@piplus/domain';
import type { ForcedRuntimeDisposeInfo } from '@piplus/pi-client/runtime-lifecycle-hooks';
import { registerForcedRuntimeDisposeHandler } from '@piplus/pi-client/runtime-lifecycle-hooks';
import { getDbPath } from './db-context';
import { socketHub } from './ws/server';
import { createEvent } from './ws/protocol';

/**
 * pi-client 卡死兜底强杀（forced runtime dispose）→ domain 状态收敛 → WS 广播的接线。
 *
 * pi-client 的 closeRuntime 在「连续无进展」超时后仍会 dispose 在途 runtime（僵尸兜底），
 * 该动作会 abort 在途 turn；被强杀的 run 走不到 doCleanup，会话会永久停在 running，
 * 迟到的子会话 writeback 因「父会话非 idle」跳过 auto-wake，结果永久躺在 DB 里（线上事故）。
 *
 * 这里把两个 Wave1 能力接成闭环：
 *   pi-client 强杀通知 hook → domain.finalizeForcedRuntimeReclaim（lastRunAt 护栏条件收敛）
 *   → socketHub 广播 session.runtime_status_changed(idle)（与 routes/sessions/routes/chat.ts 同形）
 * → 前端状态灯复位；随后迟到的 writeback 能触发 auto-wake 把父会话拉起。
 */

/** 模块级函数引用：registerForcedRuntimeDisposeHandler 内部用 Set 去重，重复 createApp 不会叠加。 */
async function handleForcedRuntimeDispose(info: ForcedRuntimeDisposeInfo): Promise<void> {
  // 每次调用按当前配置取 db（与 routes 层一致；测试切 DATABASE_URL 后仍指向正确库）
  await finalizeForcedRuntimeReclaim({
    db: createDb(`file:${getDbPath()}`),
    sessionId: info.sessionId,
    disposedAt: info.disposedAt,
    attempts: info.attempts,
    noProgressMs: info.noProgressMs,
    onRuntimeStatusChange: async ({ sessionId, projectId, runtimeStatus, error }) => {
      socketHub.sendToSession(
        sessionId,
        createEvent('session.runtime_status_changed', { runtime_status: runtimeStatus, error }, { project_id: projectId, session_id: sessionId }),
      );
    },
  });
}

/** 幂等注册（handler 为模块级函数引用）：可在 createApp() 中反复调用。 */
export function registerRuntimeReclaimHook(): void {
  registerForcedRuntimeDisposeHandler(handleForcedRuntimeDispose);
}
