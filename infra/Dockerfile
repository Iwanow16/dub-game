# syntax=docker/dockerfile:1.7
# DubRoom images (§21, §22.5). Build context: repository root.
#   --target app    Node services (api, game-server, media-worker) + CLI and seed tooling
#   --target caddy  reverse proxy with the web client, Clip Studio and /help baked in

ARG NODE_IMAGE=node:22-alpine
ARG CADDY_IMAGE=caddy:2-alpine

# ---------- build ----------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true
RUN npm install -g --no-fund --no-audit pnpm@10.33.0
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
RUN pnpm -r --if-present build
# production node_modules per service (bundles keep only direct npm deps external)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    for s in api game-server media-worker; do \
      pnpm --filter "@dubroom/$s" --prod deploy --legacy "/out/$s" && \
      rm -rf "/out/$s/src" "/out/$s/dist" && cp -r "apps/$s/dist" "/out/$s/dist"; \
    done

# ---------- Node services ----------
FROM ${NODE_IMAGE} AS app
# ffmpeg for the media worker, fonts for drawtext (synthetic clips), bash/curl for scripts
RUN apk add --no-cache ffmpeg font-dejavu bash curl tini \
 && addgroup -g 10001 dubroom && adduser -D -H -u 10001 -G dubroom dubroom
WORKDIR /app
COPY --from=build /out/api /app/api
COPY --from=build /out/game-server /app/game-server
COPY --from=build /out/media-worker /app/media-worker
COPY --from=build /src/packages/clip-format/dist/dubroom-clip.js /app/bin/dubroom-clip.js
COPY --from=build /src/scripts /app/scripts
COPY --from=build /src/content /app/content
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} DATA_DIR=/data \
    DUBROOM_CLI="node /app/bin/dubroom-clip.js" NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER 10001:10001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/api/dist/main.js"]

# ---------- reverse proxy + static sites ----------
FROM ${CADDY_IMAGE} AS caddy
# The stock binary carries cap_net_bind_service; under no-new-privileges + cap_drop ALL such a
# binary can't be exec'd. We listen on :8080, so drop the file capability (cp doesn't copy xattrs).
RUN cp /usr/bin/caddy /tmp/caddy && mv /tmp/caddy /usr/bin/caddy
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv/web
COPY --from=build /src/apps/studio/dist /srv/studio
COPY --from=build /src/apps/help/dist /srv/help
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
USER 10001:10001
