# Project Directory Binding Design

日期：2026-06-15

## 1. 目标

为项目增加“真实目录绑定”能力，使每个项目都对应一个本地目录。

## 2. 绑定模式

### 2.1 绑定现有目录

用户直接输入任意目录路径，系统验证后绑定到该目录。

约束：
- 目录必须存在
- 目录必须可读
- 最好可写（供后续 agent 使用）

项目名规则：
- 默认建议值 = 目录 basename
- 用户可手动改写项目名

### 2.2 GitHub clone

用户输入 GitHub URL，系统自动 clone 到统一的默认根目录下。

默认根目录：

```bash
PROJECTS_ROOT=~/projects
```

项目目录规则：
- 目标目录 = `~/projects/<repoName>`
- `repoName` 取 GitHub 仓库名
- clone 成功后，项目目录即为 clone 后目录

约束：
- 目标目录已存在则报错，不覆盖
- clone 失败则不创建项目记录

项目名规则：
- 默认建议值 = 仓库名
- 用户可手动改写项目名

## 3. 数据模型

`projects` 表新增字段：

```ts
projectPath: text('project_path').notNull()
sourceType: text('source_type').notNull().default('existing')
sourceUrl: text('source_url')
```

含义：
`project_path`：项目实际绑定的目录
- `source_type`：`existing` / `git_clone`
- `source_url`：clone 模式下记录 GitHub URL，现有目录模式为空
- `name`：项目显示名称，支持用户自定义；默认值由目录名或仓库名预填充


## 4. API 设计

### 4.1 创建项目

#### existing

```json
{
  "mode": "existing",
  "path": "/any/path/project-a"
}
```

#### git_clone

```json
{
  "mode": "git_clone",
  "repo_url": "https://github.com/foo/bar"
}
```

### 4.2 后端行为

#### existing
1. 校验路径存在且为目录
2. 解析项目名 = basename(path)
3. 写入 project 记录
4. 自动创建 planner session

#### git_clone
1. 读取 `PROJECTS_ROOT`（默认 `~/projects`）
2. 解析仓库名
3. 目标路径 = `~/projects/<repoName>`
4. 若路径已存在则报错
5. 执行 `git clone`
6. clone 成功后写入 project 记录
7. 自动创建 planner session

## 5. 前端交互

### 5.1 创建项目表单

增加两种模式：
- 绑定现有目录
- GitHub clone

### 5.2 输入项

#### existing
- 目录路径输入框

#### git_clone
- GitHub URL 输入框
- 只读提示：`将克隆到默认目录：~/projects`

## 6. 后续 runtime 约束

所有 session / runtime 的 cwd 应优先使用 `projectPath`，而不是 `process.cwd()`。

## 7. 不做的事

- 不做项目名和目录名分离配置
- 不做存在目录覆盖 clone
- 不做项目级权限或协作模型
- 不做远程仓库自动同步

## 8. 结论

这是一个以“项目 = 真实本地目录”为核心的绑定模型。现有目录模式用于直接接入已有工作区；GitHub clone 模式统一落到 `~/projects`，保持目录结构可预期且对后续 agent 执行友好。
