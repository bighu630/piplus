/**
 * 订阅被拒（`subscription.denied`）的处理策略。
 *
 * 后端在 `subscribe_session` 归属校验未通过时会回发该事件（apps/api/src/ws/session.ts）：
 * - 常见原因之一是认证握手与 subscribe 竞争（连接刚建立、连接身份尚未写入）→ 延迟重订阅可自愈；
 * - 若会话确实不属于当前用户，重订阅会持续失败 → 必须封顶重试次数，避免无限重试循环。
 */

/** 首次被拒后的最多重试次数（不含首次订阅本身）。 */
export const SUBSCRIPTION_DENIED_MAX_RETRIES = 2;
/** 重订阅的延迟：给认证态/服务端状态收敛留出时间。 */
export const SUBSCRIPTION_DENIED_RETRY_DELAY_MS = 3000;

export type SubscriptionDeniedOutcome = 'retry' | 'give-up';

export interface SubscriptionDeniedDecision {
  /** 本次是第几次被拒（1-based） */
  attempt: number;
  outcome: SubscriptionDeniedOutcome;
  /** 是否安排一次延迟重订阅 */
  retry: boolean;
  /** 是否向用户提示（首次与最终放弃时提示，重试期间不刷屏） */
  notify: boolean;
}

/** 根据历史被拒次数决定：继续重试还是放弃，以及是否需要提示用户。 */
export function decideSubscriptionDenied(previousAttempts: number): SubscriptionDeniedDecision {
  const attempt = Math.max(0, Math.floor(previousAttempts)) + 1;
  const retry = attempt <= SUBSCRIPTION_DENIED_MAX_RETRIES;
  const giveUp = attempt === SUBSCRIPTION_DENIED_MAX_RETRIES + 1;
  return {
    attempt,
    outcome: retry ? 'retry' : 'give-up',
    retry,
    notify: attempt === 1 || giveUp,
  };
}

/** 用户可见提示文案（复用系统通知机制，不新造提示通道）。 */
export function subscriptionDeniedNotice(outcome: SubscriptionDeniedOutcome): { title: string; body: string } {
  if (outcome === 'retry') {
    return {
      title: 'PiPlus：会话实时消息订阅失败',
      body: '无法订阅当前会话的实时消息，正在自动重试…',
    };
  }
  return {
    title: 'PiPlus：会话实时消息订阅失败',
    body: '多次订阅当前会话失败（可能该会话不属于当前用户）。该会话将不会实时更新，请刷新页面或重新登录。',
  };
}
