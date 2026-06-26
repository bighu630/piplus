# Sidebar 折叠态与 GitHub 入口 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 调整侧边栏折叠态为纯展开入口，并在展开态底部新增 GitHub 仓库跳转按钮。

**架构：** 仅在 `Sidebar` 组件内部做条件渲染调整，不改动上层状态与接口。展开态延续现有结构，折叠态渲染精简版头部与项目首字母列表，底部功能区仅在展开态显示。

**技术栈：** React、TypeScript、`lucide-react`、Tailwind 类名样式

---

### 任务 1：更新 Sidebar 折叠态与底部操作

**文件：**
- 修改：`apps/web/src/components/Sidebar.tsx`
- 参考：`docs/superpowers/specs/2026-06-26-sidebar-collapsed-github-design.md`

- [ ] **步骤 1：补充图标与辅助函数**

在 `lucide-react` 导入中加入 GitHub 图标（以库内实际导出名称为准），并新增用于生成项目首字母的辅助函数，处理空字符串回退为 `?`。

- [ ] **步骤 2：实现 GitHub 跳转按钮**

在组件内新增 GitHub 按钮点击处理函数，调用：`window.open('https://github.com/bighu630/piplus', '_blank', 'noopener,noreferrer')`。

- [ ] **步骤 3：调整折叠态头部行为**

将折叠态头部保留为单一展开按钮；展开态继续显示现有标题与折叠按钮。

- [ ] **步骤 4：调整折叠态主体区**

让折叠态主体区仅渲染项目首字母列表。每个首字母项点击后仅执行 `onToggleSidebar()`，不执行 `onSelectProject()`、`toggleProject()` 或任何会话操作。

- [ ] **步骤 5：隐藏折叠态其余元素**

确保折叠态下不渲染新建项目按钮、搜索、过滤器、会话树和底部功能区。

- [ ] **步骤 6：扩展展开态底部区**

在展开态底部中，保持 `退出登录` 与 `设置` 的现有行为，在设置按钮左侧新增 GitHub 图标按钮。

- [ ] **步骤 7：运行针对性检查**

运行：`pnpm exec tsc --noEmit -p apps/web/tsconfig.json`
预期：通过，且不引入 `Sidebar.tsx` 相关类型错误。

- [ ] **步骤 8：人工快速检查差异**

运行：`git diff -- apps/web/src/components/Sidebar.tsx docs/superpowers/specs/2026-06-26-sidebar-collapsed-github-design.md docs/superpowers/plans/2026-06-26-sidebar-collapsed-github.md`
预期：仅包含本次侧边栏交互与文档变更。
