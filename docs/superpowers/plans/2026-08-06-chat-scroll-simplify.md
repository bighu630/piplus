# Chat 滚动跟随简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TabChat 的 5 个滚动 effect + 4 个 ref 收敛为单一状态机（显式跟随开关），修复 smooth/瞬时吸附冲突、scrollIntoView 滚错容器、渲染前快照误判等"不跟随"问题。

**Architecture:** 单一 `useLayoutEffect` 统一处理三类事件（会话切换跳底 / 触顶加载补偿 / 底部跟随吸底），跟随判定改为"距底 < 100px"显式开关，全部滚动用 `container.scrollTo` 瞬时模式（无 smooth 动画竞争）。

**Tech Stack:** React 19 + TypeScript。仅改 `apps/web/src/components/TabChat.tsx`。

**Worktree:** `/home/ivhu/.config/piplus/projects/piplus/.worktrees/chat-scroll-simplify`（分支 `feature/chat-scroll-simplify`）。

---

## Task 1: 滚动逻辑收敛为单一状态机

**Files:**
- Modify: `apps/web/src/components/TabChat.tsx`

### 删除（现有机制 ①③④ 及其附属状态）

- `messagesEndRef`（useRef 声明 + JSX 中 `<div ref={messagesEndRef} />` 删除）
- `prevDisplayMessagesRef`、`lastChangeTypeRef`、`sessionJustSwitchedRef`
- `scrollToBottom` 函数（scrollIntoView 版本）
- `useLayoutEffect [displayMessages]`（id 比对 + prepend 补偿 + prevScrollHeightRef 记录）
- `useLayoutEffect [streamingContent]`（流式吸附）
- `useEffect [displayMessages, streamingContent, selectedSessionId]`（综合跟随 + 双 rAF 切会话）
- **保留**：sentinel IntersectionObserver 加载 effect（机制②）、scroll 监听 effect（机制⑤，阈值改为常量）

### 新增

模块级常量：

```ts
// 距容器底部多少像素内视为"在底部"（跟随吸底与按钮显示共用）
const FOLLOW_THRESHOLD = 100;
```

状态/ref（替换被删的）：

```tsx
const prevSessionIdRef = useRef<string | null | undefined>(selectedSessionId);
```

单一滚动协调 effect（放在原多个 effect 的位置，deps 覆盖消息/流式/会话）：

```tsx
// 单一滚动协调：会话切换跳底 / 触顶加载补偿 / 底部跟随（统一瞬时 scrollTo，无 smooth 动画竞争）
useLayoutEffect(() => {
  const container = scrollContainerRef.current;
  if (!container) return;

  const sessionSwitched = prevSessionIdRef.current !== selectedSessionId;
  prevSessionIdRef.current = selectedSessionId;

  if (sessionSwitched) {
    // 会话切换：真实消息渲染后（layout effect 时机）直接跳底，无需 rAF
    container.scrollTop = container.scrollHeight;
    setIsNearBottom(true);
    isNearBottomRef.current = true;
    prevScrollHeightRef.current = container.scrollHeight;
    return;
  }

  const prevHeight = prevScrollHeightRef.current;
  prevScrollHeightRef.current = container.scrollHeight;

  const heightDelta = prevHeight === null ? 0 : container.scrollHeight - prevHeight;

  // 触顶加载更早消息（高度增加且视口锚定在顶部）：补偿 scrollTop 保持阅读位置
  if (heightDelta > 0 && container.scrollTop < FOLLOW_THRESHOLD && !isNearBottomRef.current) {
    container.scrollTop += heightDelta;
    return;
  }

  // 底部跟随：用户停留在底部附近时，任何内容变化（流式 delta/append/乐观消息）都瞬时吸底
  if (isNearBottomRef.current) {
    container.scrollTop = container.scrollHeight;
    setIsNearBottom(true);
  }
}, [displayMessages, streamingContent, selectedSessionId]);
```

scroll 监听 effect 阈值改为常量：

```tsx
const near = container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_THRESHOLD;
```

`handleScrollToBottom` 重写（瞬时跳底 + 开启跟随，无 smooth——避免与后续 80ms 流式吸附竞争）：

```tsx
const handleScrollToBottom = () => {
  const container = scrollContainerRef.current;
  if (!container) return;
  container.scrollTop = container.scrollHeight;
  setIsNearBottom(true);
  isNearBottomRef.current = true;
};
```

### 语义核对清单（对照现状，逐条确认不回归）

1. 流式输出时若用户在底部 → 每 80ms delta 变化跟随吸底（瞬时，原为瞬时+平滑混用）
2. 流式中用户滚离底部（>100px）→ 跟随关，不再被抢滚动；滚回底部 → 跟随开
3. 触顶加载更早消息 → scrollTop 补偿，视口内容不跳（原为 id 比对，现为 scrollTop<100px 判定——sentinel 触顶加载必然满足）
4. 切会话 → 跳底（原为双 rAF 后 scrollToBottom('auto')，现为 layout effect 直接跳底；query 异步到达时由后续渲染的 near=true 分支续跳）
5. 回到底部按钮 → 点击即跳底 + 开启跟随
6. 发送消息（乐观消息插入 displayMessages）→ 在底部则跟随，不在则不打扰
7. 消息不足一屏（near 恒 true）→ 内容变化跳底无副作用
8. 滚动监听初始化 `checkNearBottom()` 在挂载时执行（保留）

### 验证

```bash
cd apps/web && bunx tsc --noEmit   # 无错误
cd apps/web && bun test            # 21 pass
cd apps/web && bun run build       # 构建成功
```

grep 自查：`messagesEndRef`、`prevDisplayMessagesRef`、`lastChangeTypeRef`、`sessionJustSwitchedRef`、`scrollIntoView`、`scrollToBottom` 无残留。

### 提交

```bash
git add -A && git commit -m "refactor(web): 滚动跟随收敛为单一状态机（显式底部开关，统一瞬时吸底）"
```
