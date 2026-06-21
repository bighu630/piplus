# Project Delete & Archive

日期：2026-06-16

## 1. 语义

- **归档**：项目及子 session 标记为 archived，数据保留
- **删除**：级联物理删除数据库关联记录，不动文件系统

## 2. API

### 归档
```http
POST /api/v1/projects/:projectId/archive
```
行为：设 project + 子 sessions 的 status = 'archived'

### 删除
```http
DELETE /api/v1/projects/:projectId
```
行为：按 session 级联删除 messages / events / sync_states / sessions，再删 project / audit

## 3. 前端

侧栏项目卡片右侧增加归档和删除按钮，删除需二次确认
