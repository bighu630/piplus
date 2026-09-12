# Piplus Docker 部署

本文说明如何用单容器、单端口的方式部署 Piplus。

## 前提条件

- 已安装 Docker
- 已安装 Docker Compose（`docker compose`）
- 可访问 Docker Hub（拉取预构建镜像 `iambighu/piplus`；从源码构建时还需要 `oven/bun:1.4.2-alpine` 基础镜像）

## 基础镜像与 lockfile

`Dockerfile` 基于 `oven/bun:1.4.2-alpine`（bun 1.4.2 + Alpine 3.22）。**不要改成 `latest` 或其他未固定版本**：

- 构建上下文中的 `bun.lock` 是 `lockfileVersion: 2`（bun 1.4.0 起）。bun < 1.4.0 会报 `Unknown lockfile version` 并**静默忽略 lockfile**，导致镜像内依赖脱离锁文件约束。
- 构建命令为 `bun install --frozen-lockfile`：存在 `bun.lock` 但内容与 `package.json` 不一致时构建**直接失败**，而不是静默漂移。更新依赖后请同步提交 `bun.lock`。
- `bun.lock` 已纳入版本控制：fresh clone / CI 构建都能拿到 lockfile，`--frozen-lockfile` 因此才真正生效（该提交先于本 Dockerfile 改动合入）。
- 升级 bun 时同步修改 `Dockerfile` 的镜像 tag 与本节的版本号，并确认新版本能解析现有 `lockfileVersion`。

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
- `PI_AGENT_DIR`：宿主机上的 Pi agent 数据目录，挂载到容器内 `/root/.pi/agent`。
- `PIPLUS_CONFIG_DIR`：宿主机上的 Piplus 配置目录，挂载到容器内 `/root/.config/piplus`。

## 启动

`docker-compose.yml` 使用 Docker Hub 上的**预构建镜像** `iambighu/piplus:latest`（没有 `build:` 段），compose 只拉取、不在本地构建。在项目根目录执行：

```bash
docker compose pull && docker compose up -d
```

启动后，容器会：

- 监听 `3000` 端口
- 由 API 同时提供 HTTP API、WebSocket 和前端静态资源
- 以 root 用户运行（家目录 `/root`，与 pi 默认行为一致）

## 从源码构建（可选）

需要从本仓库源码出镜像时，直接用 `docker build`（compose 不再承担构建）：

```bash
docker build \
  --build-arg APP_VERSION=$(jq -r '.version' apps/desktop/package.json) \
  -t iambighu/piplus:latest .
```

镜像名/tag 与 compose 中的 `image:` 一致，构建完直接 `docker compose up -d` 即可用本地镜像。
若想让 compose 自己构建，可在 `docker-compose.yml` 的 `piplus` 服务里加一行 `build: .`（可选，不需要时保持注释）。

## 数据挂载

默认挂载关系如下：

- `~/.pi/agent` → `/root/.pi/agent`
- `~/.config/piplus` → `/root/.config/piplus`

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
