FROM node:26.12.1-bookworm-slim AS build
RUN npm install --global pnpm@12.14.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "t3code-relay..."
RUN pnpm --filter t3code-relay run build

FROM node:26.12.1-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    RELAY_MIGRATIONS_DIR=/app/migrations/postgres
WORKDIR /app
COPY --from=build --chown=node:node /repo/infra/relay/dist ./dist
COPY --from=build --chown=node:node /repo/infra/relay/migrations ./migrations
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/node.mjs"]
