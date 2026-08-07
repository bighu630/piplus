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
