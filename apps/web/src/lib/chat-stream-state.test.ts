import { describe, expect, test } from 'bun:test';
import {
  INITIAL_CHAT_STREAM_SNAPSHOT,
  createThrottledFlusher,
  reduceChatStreamSnapshot,
} from './chat-stream-state';

describe('chat stream state reducer', () => {
  test('start 重置：phase=streaming、内容清空、错误清空', () => {
    const snap = reduceChatStreamSnapshot(
      { ...INITIAL_CHAT_STREAM_SNAPSHOT, phase: 'streaming', streamingContent: '旧内容', runtimeErrors: [{ runId: 'r1', error: '旧错误' }] },
      { type: 'start', delta: '' },
    );
    expect(snap.phase).toBe('streaming');
    expect(snap.streamingContent).toBe('');
    expect(snap.runtimeErrors).toEqual([]);
  });

  test('delta 累积：连续 2 次追加内容', () => {
    let snap = reduceChatStreamSnapshot(INITIAL_CHAT_STREAM_SNAPSHOT, { type: 'start', delta: '' });
    snap = reduceChatStreamSnapshot(snap, { type: 'delta', delta: '你' });
    snap = reduceChatStreamSnapshot(snap, { type: 'delta', delta: '好' });
    expect(snap.phase).toBe('streaming');
    expect(snap.streamingContent).toBe('你好');
  });

  test('complete 保留 streamingContent 且仅切换 phase', () => {
    const snap = reduceChatStreamSnapshot(
      { ...INITIAL_CHAT_STREAM_SNAPSHOT, phase: 'streaming', streamingContent: '完整内容' },
      { type: 'complete' },
    );
    expect(snap.phase).toBe('complete');
    expect(snap.streamingContent).toBe('完整内容');
  });

  test('error 清空内容并记录运行时错误', () => {
    const snap = reduceChatStreamSnapshot(
      { ...INITIAL_CHAT_STREAM_SNAPSHOT, phase: 'streaming', streamingContent: '半截内容' },
      { type: 'error', error: 'agent 循环失败', runId: 'run-1' },
    );
    expect(snap.phase).toBe('error');
    expect(snap.streamingContent).toBe('');
    expect(snap.runtimeErrors).toEqual([{ runId: 'run-1', error: 'agent 循环失败' }]);
  });

  test('runtime_idle 全清回初始快照', () => {
    const snap = reduceChatStreamSnapshot(
      { phase: 'streaming', streamingContent: '残留内容', streamNote: 'start · streaming', runtimeErrors: [{ runId: 'r1', error: '错误' }] },
      { type: 'runtime_idle' },
    );
    expect(snap).toEqual(INITIAL_CHAT_STREAM_SNAPSHOT);
  });

  test('start 的 streamNote 两种分支', () => {
    const withDelta = reduceChatStreamSnapshot(INITIAL_CHAT_STREAM_SNAPSHOT, { type: 'start', delta: '有内容' });
    const withoutDelta = reduceChatStreamSnapshot(INITIAL_CHAT_STREAM_SNAPSHOT, { type: 'start', delta: '' });
    expect(withDelta.streamNote).toBe('start · streaming');
    expect(withoutDelta.streamNote).toBe('start');
  });

  test('初始常量不可变使用：reduce 不修改输入快照', () => {
    const original = { ...INITIAL_CHAT_STREAM_SNAPSHOT };
    reduceChatStreamSnapshot(INITIAL_CHAT_STREAM_SNAPSHOT, { type: 'delta', delta: '新内容' });
    reduceChatStreamSnapshot(INITIAL_CHAT_STREAM_SNAPSHOT, { type: 'error', error: '错误', runId: 'r1' });
    expect(INITIAL_CHAT_STREAM_SNAPSHOT).toEqual(original);
    expect(INITIAL_CHAT_STREAM_SNAPSHOT.phase).toBe('idle');
    expect(INITIAL_CHAT_STREAM_SNAPSHOT.streamingContent).toBe('');
  });

  test('空 delta 追加无变化', () => {
    const snap = reduceChatStreamSnapshot(
      { ...INITIAL_CHAT_STREAM_SNAPSHOT, phase: 'streaming', streamingContent: '已有内容' },
      { type: 'delta', delta: '' },
    );
    expect(snap.streamingContent).toBe('已有内容');
    expect(snap.phase).toBe('streaming');
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createThrottledFlusher', () => {
  test('连续 push 只 flush 最后一次（合并节流）', async () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    flusher.push(2);
    flusher.push(3);
    await wait(30);
    expect(flushed).toEqual([3]);
    flusher.dispose();
  });

  test('immediate=true 立即 flush，不等节流窗口', () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 50);
    flusher.push(1);
    flusher.push(2, true);
    expect(flushed).toEqual([2]);
    flusher.dispose();
  });

  test('immediate 打断 pending：立即 flush 后不再有定时器 flush', async () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    flusher.push(2, true);
    expect(flushed).toEqual([2]);
    await wait(30);
    expect(flushed).toEqual([2]);
    flusher.dispose();
  });

  test('flush 后再次 push 重新起定时器', async () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    await wait(20);
    expect(flushed).toEqual([1]);
    flusher.push(2);
    await wait(20);
    expect(flushed).toEqual([1, 2]);
    flusher.dispose();
  });

  test('dispose 后不再 flush', async () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    flusher.dispose();
    flusher.push(2);
    await wait(30);
    expect(flushed).toEqual([]);
  });

  test('无 pending timer 时 immediate 也立即 flush', () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 50);
    flusher.push(1, true);
    expect(flushed).toEqual([1]);
    flusher.dispose();
  });
});
