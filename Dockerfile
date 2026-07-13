FROM oven/bun:latest
WORKDIR /app

RUN apt-get update -qq && apt-get install -y -qq git 2>&1 | tail -3 && \
    mkdir -p /home/app && \
    echo "app:x:1000:1000::/home/app:/bin/sh" >> /etc/passwd && \
    echo "app:x:1000:" >> /etc/group

ENV HOME=/home/app
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
    mkdir -p /home/app/.pi/agent /home/app/.config/piplus && \
    chown -R 1000:1000 /app /home/app

USER app
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
