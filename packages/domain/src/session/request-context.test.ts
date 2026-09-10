import { afterEach, describe, expect, test } from 'bun:test';
import { isSessionRuntimePinned, resetSessionRuntimePins } from '@piplus/pi-client/runtime-pins';
import {
  setWaitingOnChild,
  clearWaitingOnChild,
  isWaitingOnChild,
  countWaitingChildren,
  isWaitedOnByParent,
  setCrossProjectWait,
  clearCrossProjectWait,
  isCrossProjectWaiting,
} from './request-context';

// pin 是进程内单例状态：每个用例结束后必须复位，避免跨用例串味
// （等待标记由各用例的 finally 清理，这里只兜底清 pin 计数）。
afterEach(() => {
  resetSessionRuntimePins();
});

// 回归：waitingOnChild 从「每父一条 entry」改为「每父 × 每子多条 entry」。
// 旧实现并行 spawn_session(wait=true) 时后一次 set 覆盖前一次，且任一 wait 循环退出时
// clear(parent) 会把另一个仍在进行的等待一并清掉 → 父会话失去 runtime safety timeout 的
// 豁免 1，被 idle-reclaim/自身超时强杀。以下用例在旧实现下必须 FAIL。

describe('waitingOnChild 并行多条目语义', () => {
  test('并行等待两子互不覆盖：清理其一后另一仍在等待（count 2 → 1）', () => {
    const parent = 'rc_parent_parallel_coexist';
    try {
      setWaitingOnChild(parent, 'req_1', 'rc_child_1');
      setWaitingOnChild(parent, 'req_2', 'rc_child_2');

      expect(isWaitingOnChild(parent)).toBe(true);
      expect(countWaitingChildren(parent)).toBe(2);

      // 模拟先返回的 waitForChildWriteback 在 finally 中只清理自己那个子会话
      clearWaitingOnChild(parent, 'rc_child_1');

      // 旧实现：第二条 set 已覆盖第一条，此 clear（忽略第二参数）清掉全部 → 以下断言 FAIL
      expect(isWaitingOnChild(parent)).toBe(true);
      expect(countWaitingChildren(parent)).toBe(1);
    } finally {
      clearWaitingOnChild(parent);
    }
  });

  test('isWaitedOnByParent 对并行两子各自独立；清理 c1 后 c1 为 false、c2 仍 true', () => {
    const parent = 'rc_parent_parallel_match';
    try {
      setWaitingOnChild(parent, 'req_1', 'rc_child_match_1');
      setWaitingOnChild(parent, 'req_2', 'rc_child_match_2');

      expect(isWaitedOnByParent(parent, 'rc_child_match_1')).toBe(true);
      expect(isWaitedOnByParent(parent, 'rc_child_match_2')).toBe(true);

      clearWaitingOnChild(parent, 'rc_child_match_1');

      expect(isWaitedOnByParent(parent, 'rc_child_match_1')).toBe(false);
      expect(isWaitedOnByParent(parent, 'rc_child_match_2')).toBe(true);
    } finally {
      clearWaitingOnChild(parent);
    }
  });

  test('不带 child 的 clear 清空全部', () => {
    const parent = 'rc_parent_clear_all';
    try {
      setWaitingOnChild(parent, 'req_1', 'rc_child_all_1');
      setWaitingOnChild(parent, 'req_2', 'rc_child_all_2');
      expect(countWaitingChildren(parent)).toBe(2);

      clearWaitingOnChild(parent);

      expect(isWaitingOnChild(parent)).toBe(false);
      expect(countWaitingChildren(parent)).toBe(0);
      expect(isWaitedOnByParent(parent, 'rc_child_all_1')).toBe(false);
      expect(isWaitedOnByParent(parent, 'rc_child_all_2')).toBe(false);
    } finally {
      clearWaitingOnChild(parent);
    }
  });

  test('对不存在的父/子清理是幂等 no-op，不影响其他父的条目', () => {
    const parent = 'rc_parent_idempotent';
    const otherParent = 'rc_parent_idempotent_other';
    try {
      setWaitingOnChild(parent, 'req_1', 'rc_child_idem_1');

      expect(() => clearWaitingOnChild('rc_parent_never_exists')).not.toThrow();
      expect(() => clearWaitingOnChild(parent, 'rc_child_never_exists')).not.toThrow();
      expect(() => clearWaitingOnChild(parent, 'rc_child_never_exists')).not.toThrow();

      // 不存在的 child 清理不得误伤同父下的其他条目
      expect(isWaitingOnChild(parent)).toBe(true);
      expect(countWaitingChildren(parent)).toBe(1);
      expect(isWaitedOnByParent(parent, 'rc_child_idem_1')).toBe(true);
      expect(isWaitingOnChild(otherParent)).toBe(false);
      expect(countWaitingChildren(otherParent)).toBe(0);
    } finally {
      clearWaitingOnChild(parent);
      clearWaitingOnChild(otherParent);
    }
  });

  test('同一 child 重复 set 只刷新，不产生重复条目', () => {
    const parent = 'rc_parent_refresh';
    try {
      setWaitingOnChild(parent, 'req_old', 'rc_child_refresh');
      setWaitingOnChild(parent, 'req_new', 'rc_child_refresh');

      expect(countWaitingChildren(parent)).toBe(1);
      expect(isWaitedOnByParent(parent, 'rc_child_refresh')).toBe(true);
      // 注：entry 内部 requestId 是否刷新已无外部可观测出口（getWaitingOnChild 已删除，无生产调用方）——
      // 「刷新而非新增条目」由上面的 count===1 与 pin refcount 用例（重复 set 不叠加 pin）共同锁定。
    } finally {
      clearWaitingOnChild(parent);
    }
  });
});

// A2 接线：domain 的等待状态（豁免 1/3 的唯一依据）与 pi-client 的回收豁免必须共用同一份
// pin refcount。以下用例要求 set/clear 与 pin/unpin 严格配对；旧实现（完全不 pin）下
// isSessionRuntimePinned 恒为 false，全部 FAIL。
describe('等待状态 → pi-client runtime pin 接线（refcount 严格配对）', () => {
  test('并行等待两子：清其一只解除对应 pin，全部清完才解除父会话 pin；重复 clear 不欠计数', () => {
    const parent = 'pin_parent_parallel';
    const child1 = 'pin_child_1';
    const child2 = 'pin_child_2';
    try {
      setWaitingOnChild(parent, 'req_1', child1);
      expect(isSessionRuntimePinned(parent)).toBe(true);

      setWaitingOnChild(parent, 'req_2', child2);
      expect(countWaitingChildren(parent)).toBe(2);

      // 只退出一个 wait 循环：父仍在等 child2 → 父会话的回收豁免必须保持
      clearWaitingOnChild(parent, child1);
      expect(isSessionRuntimePinned(parent)).toBe(true);

      // 幂等重复 clear：不得二次 unpin（否则 child2 的等待失去保护 → 父被强杀）
      clearWaitingOnChild(parent, child1);
      expect(isSessionRuntimePinned(parent)).toBe(true);

      clearWaitingOnChild(parent, child2);
      expect(isSessionRuntimePinned(parent)).toBe(false);
    } finally {
      clearWaitingOnChild(parent);
    }
  });

  test('同一 (父,子) 重复 set 只刷新不重复 pin：一次 clear 即完全解除', () => {
    const parent = 'pin_parent_refresh';
    const child = 'pin_child_refresh';
    try {
      setWaitingOnChild(parent, 'req_old', child);
      setWaitingOnChild(parent, 'req_new', child);
      expect(countWaitingChildren(parent)).toBe(1);

      clearWaitingOnChild(parent, child);
      // 若重复 set 叠加了 refcount，这里仍会 pinned → 泄漏
      expect(isSessionRuntimePinned(parent)).toBe(false);
    } finally {
      clearWaitingOnChild(parent);
    }
  });

  test('clearWaitingOnChild(parent) 全清：按实际条目数逐条解除 pin', () => {
    const parent = 'pin_parent_clear_all';
    try {
      setWaitingOnChild(parent, 'req_1', 'pin_child_all_1');
      setWaitingOnChild(parent, 'req_2', 'pin_child_all_2');
      expect(isSessionRuntimePinned(parent)).toBe(true);

      clearWaitingOnChild(parent);
      expect(countWaitingChildren(parent)).toBe(0);
      expect(isSessionRuntimePinned(parent)).toBe(false);
    } finally {
      clearWaitingOnChild(parent);
    }
  });

  test('不存在条目的 clear 不产生欠计数：其他父的 pin 不受影响', () => {
    const parent = 'pin_parent_idem';
    const otherParent = 'pin_parent_idem_other';
    try {
      setWaitingOnChild(parent, 'req_1', 'pin_child_idem_1');
      setWaitingOnChild(otherParent, 'req_1', 'pin_child_idem_other');
      expect(isSessionRuntimePinned(parent)).toBe(true);
      expect(isSessionRuntimePinned(otherParent)).toBe(true);

      clearWaitingOnChild('pin_parent_never_exists');
      clearWaitingOnChild(parent, 'pin_child_never_exists');
      clearWaitingOnChild(parent, 'pin_child_never_exists');

      expect(isSessionRuntimePinned(parent)).toBe(true);
      expect(isSessionRuntimePinned(otherParent)).toBe(true);

      clearWaitingOnChild(parent);
      expect(isSessionRuntimePinned(parent)).toBe(false);
      // 清一个父不得欠计数到其他父头上
      expect(isSessionRuntimePinned(otherParent)).toBe(true);

      clearWaitingOnChild(otherParent);
      expect(isSessionRuntimePinned(otherParent)).toBe(false);
    } finally {
      clearWaitingOnChild(parent);
      clearWaitingOnChild(otherParent);
    }
  });
});

// 跨项目等待（豁免 3）：目标项目的会话是顶层会话，父的 safety timeout 只认这个内存标记，
// 同样必须 pin 住 pi-client 的回收豁免。
describe('跨项目等待标记 → pi-client runtime pin 接线', () => {
  test('set 时 pin、clear 时解除、重复 set/clear 幂等且互不影响其他会话', () => {
    const sessionA = 'pin_cross_a';
    const sessionB = 'pin_cross_b';
    try {
      setCrossProjectWait(sessionA, 'req_a');
      setCrossProjectWait(sessionB, 'req_b');
      expect(isCrossProjectWaiting(sessionA)).toBe(true);
      expect(isSessionRuntimePinned(sessionA)).toBe(true);
      expect(isSessionRuntimePinned(sessionB)).toBe(true);

      // 重复 set 同一会话只是刷新 entry，不得叠加 refcount
      setCrossProjectWait(sessionA, 'req_a2');

      clearCrossProjectWait(sessionA);
      expect(isSessionRuntimePinned(sessionA)).toBe(false);

      // 重复 clear 幂等：不得欠计数、不得误伤 sessionB
      clearCrossProjectWait(sessionA);
      expect(isSessionRuntimePinned(sessionB)).toBe(true);

      clearCrossProjectWait(sessionB);
      expect(isSessionRuntimePinned(sessionB)).toBe(false);
    } finally {
      clearCrossProjectWait(sessionA);
      clearCrossProjectWait(sessionB);
    }
  });
});
