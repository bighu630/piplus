FROM vimcaw/bun-git:latest
WORKDIR /app

# 换清华 Alpine 源 + 安装常用工具
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories && \
    apk add --no-cache curl python3 py3-pip ca-certificates bash && \
    mkdir -p /home/app

ENV HOME=/root
ENV API_HOST=0.0.0.0
ENV API_PORT=3000
ENV PIPLUS_SERVE_WEB=1
ENV PIPLUS_WEB_DIST=/app/apps/web/dist
# Build with: docker build --build-arg APP_VERSION=$(jq -r '.version' apps/desktop/package.json) -t piplus:latest .
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY . .

RUN bun install && \
    cd apps/web && bunx vite build && \
    mkdir -p /root/.pi/agent /root/.config/piplus

# 以 root 运行
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
