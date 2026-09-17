# 基础镜像固定 bun 版本，不要用 latest：仓库 bun.lock 为 lockfileVersion 2，
# 只有 bun >= 1.4.0 能解析；更旧的 bun 会报 "Unknown lockfile version" 并静默忽略 lockfile。
# oven/bun:1.4.2-alpine：Alpine 3.22，多架构 index digest
# sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f（metadata 可经 registry API 校验）。
FROM oven/bun:1.4.2-alpine
WORKDIR /app

# 换清华 Alpine 源 + 安装常用工具（官方 Alpine 镜像不含 git，需显式安装）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories && \
    apk add --no-cache curl git python3 py3-pip ca-certificates bash && \
    mkdir -p /home/app

ENV HOME=/root
ENV API_HOST=0.0.0.0
ENV API_PORT=3000
ENV PIPLUS_SERVE_WEB=1
ENV PIPLUS_WEB_DIST=/app/apps/web/dist
# Production mode: disables the x-user-id dev auth fallback (see middleware/auth.ts).
ENV NODE_ENV=production
# Build with: docker build --build-arg APP_VERSION=$(jq -r '.version' apps/desktop/package.json) -t piplus:latest .
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY . .

# --frozen-lockfile：lockfile 与 package.json 不一致时构建直接失败，避免静默忽略/依赖漂移
RUN bun install --frozen-lockfile && \
    cd apps/web && bunx vite build && \
    mkdir -p /root/.pi/agent /root/.config/piplus

# 以 root 运行
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
