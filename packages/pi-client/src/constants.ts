/** 非 worker 会话 idle runtime 回收 TTL（ms）—— domain 层与 client 层定时器共用，单一来源。
 *  可由 PIPLUS_IDLE_RUNTIME_TTL_MS 环境变量覆盖；非法值回退默认 30 分钟。 */
export const NON_WORKER_IDLE_RUNTIME_TTL_MS = (() => {
  const raw = typeof process !== 'undefined' ? process.env.PIPLUS_IDLE_RUNTIME_TTL_MS?.trim() : undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30 * 60 * 1000;
})();

/** 读取正数 ms 环境变量（调用时读取，支持测试动态设置）；非法/<=0/空值回落默认值。 */
function resolvePositiveMsEnv(name: string, fallback: number): number {
  const raw = typeof process !== 'undefined' ? process.env[name]?.trim() : undefined;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

/** closeRuntime 流式重试 / pin 与 ask-pending 豁免后重新检查的间隔（ms）。
 *  env PIPLUS_CLOSE_RUNTIME_RETRY_MS，默认 30s；非法/<=0 回落默认。
 *  注意：调用时读取 env，不用模块级 const（便于测试动态覆盖）。 */
export function resolveCloseRuntimeRetryIntervalMs(): number {
  return resolvePositiveMsEnv('PIPLUS_CLOSE_RUNTIME_RETRY_MS', 30_000);
}

/** 流式 runtime 连续无进展多久后强制回收（ms，卡死兜底）。
 *  env PIPLUS_FORCED_RECLAIM_NO_PROGRESS_MS，默认 30 分钟；非法/<=0 回落默认。
 *  注意：调用时读取 env，不用模块级 const（便于测试动态覆盖）。 */
export function resolveForcedReclaimNoProgressMs(): number {
  return resolvePositiveMsEnv('PIPLUS_FORCED_RECLAIM_NO_PROGRESS_MS', 1_800_000);
}
