# Piplus Docker 部署

本文说明如何用单容器、单端口的方式部署 Piplus。

## 前提条件

- 已安装 Docker
- 已安装 Docker Compose（`docker compose`）
- 可访问 Docker Hub（首次构建需要拉取 `oven/bun` 基础镜像）

## 配置

1. 复制 `deployment/docker/.env.example` 到项目根目录 `.env`。
2. 按实际部署地址修改 `PUBLIC_WEB_ORIGIN`。

示例：

```env
PUBLIC_WEB_ORIGIN=https://your-domain.example.com
PI_AGENT_DIR=/home/your-user/.pi/agent
PIPLUS_CONFIG_DIR=/home/your-user/.config/piplus
```

### 环境变量说明

- `PUBLIC_WEB_ORIGIN`：对外访问的 Web 域名或地址。该值在容器运行时生效，会被自动注入到前端页面和 API 的 CORS 策略中，修改后只需重启容器即可。
- `PI_AGENT_DIR`：宿主机上的 Pi agent 数据目录，挂载到容器内 `/home/app/.pi/agent`。
- `PIPLUS_CONFIG_DIR`：宿主机上的 Piplus 配置目录，挂载到容器内 `/home/app/.config/piplus`。

## 启动

在项目根目录执行：

```bash
docker compose up -d --build
```

启动后，容器会：

- 监听 `3000` 端口
- 由 API 同时提供 HTTP API、WebSocket 和前端静态资源
- 以非 root `app` 用户运行

## 数据挂载

默认挂载关系如下：

- `~/.pi/agent` → `/home/app/.pi/agent`
- `~/.config/piplus` → `/home/app/.config/piplus`

如果你的目录不在默认位置，请在 `.env` 中改写 `PI_AGENT_DIR` 与 `PIPLUS_CONFIG_DIR`。

## 域名变更

`PUBLIC_WEB_ORIGIN` 在容器运行时生效，修改后只需重启即可（无需重建镜像）：

```bash
docker compose up -d
```

## 停止

```bash
docker compose down
```
