import React, { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

/**
 * 可复用的高度展开/收起动画容器。
 *
 * - 展开：height `0 → auto` + 淡入；收起：反向动画，退出动画结束后由 AnimatePresence 卸载子节点
 * - 复用 `key`（`epoch`）保证「关 → 开」必重新挂载：AnimatePresence 对同 key 的重入会复用同一
 *   React 实例（子组件 state 不复位），每次重新展开递增 `epoch` 换 key，从而恢复「重新展开时子项
 *   状态复位」的既有语义；配合 `mode="wait"` 让旧节点退出动画结束后新节点才挂载
 * - `initial={false}`：首屏已展开的内容不播放进入动画（避免打开会话时整屏卡片一起动）
 * - 尊重 `prefers-reduced-motion`：系统开启「减弱动态」时时长归零（等价直接显隐）
 * - 只替换原先「条件挂载的包裹 div」，不改变卡片内部 DOM 结构与测试标识
 *
 * 样式分两层：外层 motion.div 只负责高度动画与裁剪，内层 div 承载 `testId` / `className`
 * （含 padding / border）。Tailwind preflight 下 `box-sizing: border-box`，若 padding/border
 * 与高度动画同层，`height: 0` 仍会被 padding 撑出残留高度，收起终态会跳变。
 */
export interface CollapseProps {
  open: boolean;
  children: React.ReactNode;
  /** 传给内容容器的 `data-testid`（沿用各卡片原有测试标识） */
  testId?: string;
  /** 附加到内容容器的 class（如原有的边框 / 内边距） */
  className?: string;
  /** 动画时长（秒），默认 0.18s */
  duration?: number;
}

function Collapse({ open, children, testId, className, duration = 0.18 }: CollapseProps) {
  // 用户在系统层面开启「减弱动态」时不做高度动画（duration=0 仍会走完挂载/卸载语义）
  const reduceMotion = useReducedMotion();
  // 每次「关 → 开」递增 epoch：AnimatePresence 对同 key 的重入会复用实例、导致子组件 state 不复位，
  // 换 key 可强制重新挂载，保证子项恢复默认（render 期派生 state，React 官方支持的模式）
  const [epoch, setEpoch] = useState(0);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setEpoch((n) => n + 1);
  }

  return (
    <AnimatePresence initial={false} mode="wait">
      {open && (
        <motion.div
          key={`collapse-${epoch}`}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : duration, ease: 'easeInOut' }}
          style={{ overflow: 'hidden' }}
        >
          <div data-testid={testId} className={className}>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default Collapse;
