# syntax=docker/dockerfile:1.7

FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /workspace

RUN corepack enable
COPY . .
RUN --mount=type=cache,id=symphony-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @symphony/server --prod deploy --legacy /opt/symphony
RUN mkdir -p /opt/symphony/ui && cp -R apps/web/dist/. /opt/symphony/ui/

FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS runtime

ENV NODE_ENV=production
ENV SYMPHONY_DATABASE_PATH=/var/lib/symphony/symphony.sqlite3
ENV SYMPHONY_UI_ROOT=/opt/symphony/ui
ENV SYMPHONY_WORKSPACE_ROOT=/var/lib/symphony/workspaces
WORKDIR /opt/symphony

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git procps tini \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && groupadd --gid 10001 symphony \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent symphony \
    && mkdir -p /var/lib/symphony/workspaces /tmp/symphony \
    && chown -R 10001:10001 /var/lib/symphony /tmp/symphony

COPY --from=build --chown=10001:10001 /opt/symphony /opt/symphony

USER 10001
VOLUME ["/var/lib/symphony"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main.js"]
