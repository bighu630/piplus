# 移动端单面板会话布局 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在手机端实现目录树与右侧内容区互斥显示，默认展示会话树，选择会话后自动切到内容区，并提供返回目录树入口；桌面端保持现有并排布局与折叠逻辑不变。

**架构：** 在 `App.tsx` 增加移动端面板状态与屏幕宽度判定，将 Sidebar 与主内容区按断点切换显示。`Sidebar.tsx` 增加移动端模式支持，隐藏桌面折叠/拖拽语义，保留树与选择交互本身不变。通过顶部按钮控制移动端在 `sidebar` / `content` 间切换。

**技术栈：** React、TypeScript、Tailwind、现有 hooks 与组件组合

---

### 任务 1：实现 `App.tsx` 的移动端面板状态

**文件：**
- 修改：`apps/web/src/App.tsx`

- [ ] 新增移动端断点检测与当前面板状态
- [ ] 会话选择后在移动端自动切换到内容面板
- [ ] 在内容头部增加返回目录树按钮
- [ ] 调整 Sidebar / main 容器类名以支持单面板切换

### 任务 2：适配 `Sidebar.tsx` 的移动端展示行为

**文件：**
- 修改：`apps/web/src/components/Sidebar.tsx`

- [ ] 增加移动端模式 props
- [ ] 移动端下关闭桌面宽度/折叠交互，仅全宽显示树
- [ ] 保持树节点、项目、新建会话等原有行为不变

### 任务 3：验证与收尾

**文件：**
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/components/Sidebar.tsx`

- [ ] 运行针对 `apps/web` 的类型检查或构建验证
- [ ] 进行代码审查并修复问题直到通过
