import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
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

// 这些用例断言的是「节流窗口行为」：用假时钟推进时间，而不是真实 sleep 后碰运气。
// 真实等待会让测试随机器负载抖动（实测：单独跑全过，满载下必挂），
// 并且无法区分「窗口没到」与「实现没 flush」。
describe('createThrottledFlusher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('连续 push 只 flush 最后一次（合并节流）', () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    flusher.push(2);
    flusher.push(3);
    expect(flushed).toEqual([]); // 窗口未到：一次都不应该 flush
    jest.advanceTimersByTime(5);
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

  test('immediate 打断 pending：立即 flush 后不再有定时器 flush', () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    flusher.push(2, true);
    expect(flushed).toEqual([2]);
    jest.advanceTimersByTime(30);
    expect(flushed).toEqual([2]);
    flusher.dispose();
  });

  test('flush 后再次 push 重新起定时器', () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    jest.advanceTimersByTime(5);
    expect(flushed).toEqual([1]);
    flusher.push(2);
    expect(flushed).toEqual([1]); // 第二次 flush 要等新的窗口，而不是沿用旧窗口
    jest.advanceTimersByTime(5);
    expect(flushed).toEqual([1, 2]);
    flusher.dispose();
  });

  test('dispose 后不再 flush，且不残留定时器', () => {
    const flushed: number[] = [];
    const flusher = createThrottledFlusher<number>((v) => flushed.push(v), 5);
    flusher.push(1);
    flusher.dispose();
    expect(jest.getTimerCount()).toBe(0);
    flusher.push(2);
    jest.advanceTimersByTime(30);
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
