import { describe, expect, test } from 'bun:test';
import { RuntimeRegistry, type ActiveSessionRuntime } from '../runtime-registry';
import type { ClientDeps } from './deps';
import { steerSession, stopSession } from './messaging';

type FakeAgentSession = {
  steered: string[];
  calls: string[];
  isStreaming: boolean;
  steer: (content: string) => Promise<void>;
  getSteeringMessages: () => readonly string[];
  clearQueue: () => { steering: string[]; followUp: string[] };
  abort: () => Promise<void>;
};

function makeDeps() {
  const registry = new RuntimeRegistry();
  const deps: ClientDeps = {
    runtimeRegistry: registry,
    modelRuntime: {} as never,
    modelRegistry: {} as never,
    ensureModel: async () => ({}) as never,
    client: undefined as unknown as ClientDeps['client'],
  };
  return { registry, deps };
}

function attachFakeAgentSession(session: ActiveSessionRuntime): FakeAgentSession {
  const fake: FakeAgentSession = {
    steered: [],
    calls: [],
    isStreaming: true,
    async steer(content: string) {
      fake.steered.push(content);
    },
    getSteeringMessages() {
      return fake.steered;
    },
    clearQueue() {
      fake.calls.push('clearQueue');
      return { steering: [], followUp: [] };
    },
    async abort() {
      fake.calls.push('abort');
    },
  };
  session.agentSession = fake as never;
  return fake;
}

describe('steerSession（运行中插话）', () => {
  test('queues content on the live agent session and reports queue length', async () => {
    const { registry, deps } = makeDeps();
    const session = registry.ensure('s1');
    const fake = attachFakeAgentSession(session);

    const result = await steerSession(deps, 's1', '插话内容');

    expect(fake.steered).toEqual(['插话内容']);
    expect(result).toEqual({ sessionId: 's1', queued: 1 });
    await steerSession(deps, 's1', '第二条');
    expect(fake.steered).toEqual(['插话内容', '第二条']);
  });

  test('throws pi_session_runtime_unavailable when no runtime exists', async () => {
    const { deps } = makeDeps();
    await expect(steerSession(deps, 'missing', 'x')).rejects.toThrow('pi_session_runtime_unavailable');
  });

  test('throws pi_session_runtime_unavailable when runtime has no agentSession', async () => {
    const { registry, deps } = makeDeps();
    registry.ensure('s2');
    await expect(steerSession(deps, 's2', 'x')).rejects.toThrow('pi_session_runtime_unavailable');
  });

  test('throws session_stopped after stop was requested', async () => {
    const { registry, deps } = makeDeps();
    const session = registry.ensure('s-stop');
    const fake = attachFakeAgentSession(session);
    session.stopped = true;

    await expect(steerSession(deps, 's-stop', 'x')).rejects.toThrow('session_stopped');
    // 必须拒绝且不入队，否则会绕过 stopSession 的 clearQueue
    expect(fake.steered).toEqual([]);
  });

  test('throws session_not_streaming when no run is active (idle agent would silently queue)', async () => {
    const { registry, deps } = makeDeps();
    const session = registry.ensure('s-idle');
    const fake = attachFakeAgentSession(session);
    fake.isStreaming = false;

    await expect(steerSession(deps, 's-idle', 'x')).rejects.toThrow('session_not_streaming');
    expect(fake.steered).toEqual([]);
  });
});

describe('stopSession 清空插话队列', () => {
  test('clears the queued steer messages before aborting, and again after abort settles', async () => {
    const { registry, deps } = makeDeps();
    const session = registry.ensure('s3');
    const fake = attachFakeAgentSession(session);

    await steerSession(deps, 's3', 'stop 前的插话');
    const result = await stopSession(deps, 's3');
    // abort 的 finally 在微任务里补清一次，落定后再断言
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({ status: 'stopped' });
    expect(session.stopped).toBe(true);
    // abort 不会清空队列，必须显式 clearQueue：先清一次，abort 收尾后再清一次
    expect(fake.calls.indexOf('clearQueue')).toBeLessThan(fake.calls.indexOf('abort'));
    expect(fake.calls.at(-1)).toBe('clearQueue');
  });
});
