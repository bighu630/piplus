# 拆分巨型文件——顺手发现的小问题（未混入重构 commit）

日期：2026-08-23　分支：refactor/split-giant-files　基线：4b6676b

以下问题在拆分过程中发现，按"纯重构不顺手修"原则**均未改动**，建议后续单独处理：

1. ✅（已处理）原 sessions.ts 模块级 `buildFileTree` 为死代码——已在独立 commit 中删除
   - 位置：现 `apps/api/src/routes/sessions/file-tree.ts`
   - 被 `registerSessionRoutes` 内部同名函数遮蔽，全仓无调用点（约 40 行无效代码）。已按要求逐字保留并有注释说明；建议单独 commit 删除。

2. **`describeImagesWithModel` 视觉识别链路超时仅靠 `VISION_RELAY_TIMEOUT_MS` 常量**，未见重试/降级指标上报；如需可观测性可后续补充（行为不变前提下）。

3. **pi-client `createPiClient()` 中 `resolvedModel` 的异步预热为 fire-and-forget**（IIFE 无 catch），若 `modelRegistry.getAvailable()` reject 会产生未处理 rejection。属存量问题，本次未动。

4. **流程教训（非代码）**：本次执行中平台会话中断导致 Task 1 被重复派发，两个 worker 曾在同一 worktree 并发写同一批文件。最终代码经 reviewer 行级多重集比对 + 全量测试/typecheck 验证为自洽纯重构，但并行派发应保证「一个 worktree/分支同一时间只有一个 worker」，或使用 wait=true 确认任务生命周期。
