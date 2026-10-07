import { useEffect, useRef, useState } from 'react';

/**
 * 让「瞬时完成」的加载态至少可见 `minMs` 毫秒。
 *
 * 用途：本地/AppImage 的历史接口几乎 0 延迟，`isFetchingNextPage` 从 true 变回 false
 * 可能只隔一个微任务，`加载中…` 一帧都不渲染，用户看到的就是内容瞬间插入造成的顶端闪跳。
 * 这里只对「过快完成」的加载补足展示时长：
 * - `active` 为 true：立即可见，并记录本次的最短展示截止时刻；
 * - `active` 变 false：未到截止时刻则延迟收起，到点立即收起；
 * - 重新激活会重算截止时刻，不会把上一次的余量算进本次；
 * - 网页端正常有网络延迟时（≥ minMs），不产生任何额外延迟。
 *
 * 截止时刻存 ref 而非派生自 state：即使 `minMs` 在 hold 期间变化导致 effect 重跑，
 * 也能从已记录的截止时刻继续计算，不会提前收起。
 */
export function useMinDuration(active: boolean, minMs: number): boolean {
  const [hold, setHold] = useState(false);
  // 本次激活的最短展示截止时刻（绝对时间戳）；null 表示当前没有需要补足的窗口
  const holdUntilRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (active) {
      clearPending();
      holdUntilRef.current = Date.now() + minMs;
      setHold(false);
      return;
    }

    const holdUntil = holdUntilRef.current;
    if (holdUntil === null) {
      setHold(false);
      return;
    }
    const remain = holdUntil - Date.now();
    if (remain <= 0) {
      holdUntilRef.current = null;
      clearPending();
      setHold(false);
      return;
    }
    setHold(true);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      holdUntilRef.current = null;
      setHold(false);
    }, remain);
    return clearPending;
  }, [active, minMs]);

  // 卸载时清理挂起的定时器，避免对已卸载组件 setState
  useEffect(() => () => clearPending(), []);

  return active || hold;
}
