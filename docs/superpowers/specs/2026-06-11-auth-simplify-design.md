# Auth 体系简化设计

日期：2026-06-11

## 1. 目标

把当前 better-auth 多用户认证体系简化为单用户局域网场景。

## 2. 删除

- `apps/api/src/auth/better-auth.ts`
- `apps/api/src/auth/auth.ts`
- `apps/api/src/auth/routes.ts`
- `apps/api/src/auth/session.ts`
- `packages/db/src/schema.ts` 中 `authUser/authSession/authAccount/authVerification` 定义
- `packages/db/migrations/0001_initial.sql` 中 auth 建表语句
- `packages/db/src/init.ts` 中 auth seed 逻辑

## 3. 后端 auth 模型

### 环境变量

```bash
APP_PASSWORD=xxx
```

不设时默认 `piplus-local`，启动打印警告。

### 路由

```
POST /api/v1/auth/login  → 比对 APP_PASSWORD，匹配返回 { token }
GET  /api/v1/auth/check  → 验证 token 有效性，返回 { ok: true }
```

token 生成：HMAC-SHA256(APP_PASSWORD, timestamp)，base64url 编码。

### 中间件

```ts
// apps/api/src/middleware/auth.ts
export async function requireAuth(c, next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token || !verifyToken(token)) {
    return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid token' } }, 401);
  }
  c.set('userId', 'local-user');
  c.set('userName', 'Piplus');
  await next();
}
```

### 用户身份

固定为 `local-user`，`createdBy` 永远使用此值。

## 4. 前端变化

- 登录页：只输入密码，无 email 字段
- token 存 localStorage
- `useAuthSession` → GET /api/v1/auth/check
- login mutation → POST /api/v1/auth/login，只传 password
- logout → 清 localStorage

## 5. 测试影响

- 现有 API 测试普遍依赖 `x-user-id: user_seed` header fallback，中间件新实现需保留此 dev 兼容
- auth 测试可简化为纯 token 校验测试
