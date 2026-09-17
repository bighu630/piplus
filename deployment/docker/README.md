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

`docker-compose.yml` 用 `${VAR:-默认值}` 从**项目根目录的 `.env`** 读取配置。
没有 `.env` 时全部走默认值，与旧版硬编码行为完全一致，因此升级不需要改任何东西。

1. 把 `deployment/docker/.env.example` 的内容**追加**到项目根目录 `.env`。

   > 模板放在 `deployment/docker/` 下，是因为项目根目录的 `.env` 已被 `.gitignore` 忽略，
   > 模板本身不会被 compose 读取。若根目录已有本地开发用的 `.env`（含 `AUTH_SECRET`、
   > `APP_PASSWORD`、`CORS_ORIGINS` 等），**不要覆盖，只追加需要的条目**。

2. 按实际部署地址修改 `PUBLIC_WEB_ORIGIN`。

3. 复核插值结果（只解析配置，不启动容器、不拉取镜像）：

```bash
docker compose config          # 打印最终生效的配置
docker compose config -q       # 只校验语法，静默
```

示例：

```env
PUBLIC_WEB_ORIGIN=https://your-domain.example.com
PI_AGENT_DIR=/data/piplus_data/pi/agent
PIPLUS_CONFIG_DIR=/data/piplus_data/piplus
PIPLUS_PORT=3008
```

### 环境变量说明

`docker-compose.yml` 消费的全部变量（默认值 = 不设置时的取值，与插值表达式一致）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PUBLIC_WEB_ORIGIN` | `piplus.whosworld.fun` | 对外访问的 Web 域名或地址。**运行时**生效，注入前端页面与 API 的 CORS 策略；改完 `docker compose up -d` 重启即可，无需重建镜像。不带协议时按 `https://` 归一化。 |
| `PI_AGENT_DIR` | `/data/piplus_data/pi/agent` | 宿主机上的 Pi agent 数据目录，挂载到容器内 `/root/.pi/agent`。 |
| `PIPLUS_CONFIG_DIR` | `/data/piplus_data/piplus` | 宿主机上的 Piplus 配置目录，挂载到容器内 `/root/.config/piplus`。 |
| `PIPLUS_PORT` | `3008` | 宿主机监听端口（容器内固定 `3000`）。 |

注意事项：

- `PUBLIC_WEB_ORIGIN` 的名字与 `apps/api/src/app.ts` 实际读取的一致；`API_HOST`、`API_PORT`、
  `DATABASE_URL` 等由 `apps/api/src/server-config.ts` 读取。
- `PI_AGENT_DIR`、`PIPLUS_CONFIG_DIR`、`PIPLUS_PORT` 是 **compose 自己的插值变量**，代码里没有任何
  地方读取它们，也**不会被注入容器**（`docker compose config` 可验证 environment 段里没有它们）：
  它们只决定宿主侧的挂载源路径与监听端口，容器内路径固定为 `/root/.pi/agent`、
  `/root/.config/piplus`，端口固定 `3000`。
- **默认不设置 `CORS_ORIGINS`。** 它优先级高于 `PUBLIC_WEB_ORIGIN`（见 `apps/api/src/app.ts`
  的 `parseCorsOrigins` 分支）：需要多个 origin 时才在 `.env` 设置，并去掉 `docker-compose.yml`
  中对应行的注释。二者同时设置时 `CORS_ORIGINS` 生效。
- **为什么不用 `env_file: .env`。** 根目录 `.env` 里除本文件所需变量外，通常还有本地开发用的
  `CORS_ORIGINS`、`APP_PASSWORD` 等；`env_file` 会把它们整包注入容器，其中 `CORS_ORIGINS`
  会静默改写 CORS 判定，属于破坏性行为变更。插值方式只取白名单变量，不会顺带注入无关配置。
- 路径类变量建议写绝对路径。Compose v2+ 也会展开 `~`，但写绝对路径更直观、且不依赖 compose 版本。

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

### 版本号 `APP_VERSION` 从哪来

版本号在**构建期**烘焙进镜像，运行时改不了，因此它不属于上面那张 compose 变量表：

- `.github/workflows/build-release.yml` 在打 tag 时执行 `VERSION=${GITHUB_REF_NAME#v}`，
  再以 `docker build --build-arg APP_VERSION=$VERSION` 构建并推送 `:<version>` 与 `:latest`。
- `Dockerfile` 中 `ARG APP_VERSION=dev` 只是缺省值（本地直接 `docker build` 不带参时生效），
  随后 `ENV APP_VERSION=$APP_VERSION` 交给 `apps/web/vite.config.ts`，在构建期写入前端常量
  `__APP_VERSION__`（由 `apps/web/src/components/Sidebar.tsx` 展示）。

具体到本仓库：**不要把 `APP_VERSION` 写进 `.env`** —— `deployment/docker/.env.example`
已不再提供这一行，写死的版本号必然随发版过期。
它只对「从源码构建」这一条路径有意义，且必须用上面的 `--build-arg` 显式传入 —— `docker build` 不会读 `.env`。
拉取镜像部署时它完全无效，要看当前运行版本请查镜像 tag（`docker compose images`、`docker inspect`），
真实来源是 git tag。

## 数据挂载

默认挂载关系如下（即 `docker-compose.yml` 中的插值默认值）：

- `/data/piplus_data/pi/agent` → `/root/.pi/agent`
- `/data/piplus_data/piplus` → `/root/.config/piplus`

如果你的目录不在默认位置，请在根目录 `.env` 中改写 `PI_AGENT_DIR` 与 `PIPLUS_CONFIG_DIR`。
修改前请确认目标目录已存在并已放入原有数据 —— 路径改错的表现是「历史数据不见了」。
用 `docker compose config` 可以确认最终生效的挂载路径。

## 域名变更

`PUBLIC_WEB_ORIGIN` 在容器运行时生效，修改后只需重启即可（无需重建镜像）：

```bash
docker compose up -d
```

需要配置多个域名时，改用 `CORS_ORIGINS`（逗号分隔）替代 `PUBLIC_WEB_ORIGIN`，
并去掉 `docker-compose.yml` 中 `CORS_ORIGINS` 那一行的注释：

```env
CORS_ORIGINS=https://a.example.com,https://b.example.com
```

`CORS_ORIGINS` 优先级更高，两者同时设置时以它为准。

## 停止

```bash
docker compose down
```
