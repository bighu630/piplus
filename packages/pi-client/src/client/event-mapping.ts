import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiSessionStreamEvent } from '../types';

export function mapAgentSessionEvent(
  sessionId: string,
  runId: string,
  event: AgentSessionEvent,
): PiSessionStreamEvent | null {
  if (event.type === 'message_start' && event.message.role === 'assistant') {
    return { type: 'message_start', sessionId, runId };
  }

  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
    return {
      type: 'text_delta',
      sessionId,
      runId,
      delta: event.assistantMessageEvent.delta,
    };
  }

  // Activity without UI payload (thinking deltas, tool-call construction,
  // text start/end): forwarded so runtime safety timers reset during
  // long thinking/tool phases — the agent is alive, just not emitting
  // user-visible text.
  if (event.type === 'message_update') {
    const t = event.assistantMessageEvent.type;
    if (t === 'thinking_start' || t === 'thinking_delta' || t === 'thinking_end' ||
        t === 'toolcall_start' || t === 'toolcall_delta' || t === 'toolcall_end' ||
        t === 'text_start' || t === 'text_end') {
      return { type: 'activity', sessionId, runId };
    }
  }

  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
    return { type: 'activity', sessionId, runId };
  }

  // 工具结果消息（role=toolResult）落库：单独转发为 tool_result_end。
  // 必须与 assistant 的 message_end 分开：assistant 的 complete 会推进流式快照 phase，
  // 而工具结果只应触发消息列表刷新，不能污染流式状态。
  if (event.type === 'message_end' && event.message.role === 'toolResult') {
    return { type: 'tool_result_end', sessionId, runId };
  }

  if (event.type === 'message_end' && event.message.role === 'assistant') {
    return { type: 'message_end', sessionId, runId };
  }

  if (event.type === 'compaction_start') {
    return { type: 'compaction_start', sessionId, reason: event.reason };
  }

  if (event.type === 'compaction_end') {
    return {
      type: 'compaction_end',
      sessionId,
      reason: event.reason,
      aborted: event.aborted,
      errorMessage: event.errorMessage,
    };
  }

  if (event.type === 'auto_retry_end' && event.success === false) {
    return { type: 'error', sessionId, runId: `auto_retry_${crypto.randomUUID().slice(0, 10)}`, error: event.finalError ?? 'auto_retry_failed' };
  }

  return null;
}
