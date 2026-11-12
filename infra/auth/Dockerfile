FROM node:26.12.1-trixie-slim AS build
RUN npm install --global pnpm@12.14.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs vite.config.ts tsconfig.base.json tsconfig.effect.json ./
COPY patches ./patches
COPY scripts/lib/cached-tests.ts ./scripts/lib/
COPY infra/task-cache/src/remoteCache.ts ./infra/task-cache/src/
COPY infra/auth/package.json ./infra/auth/
RUN pnpm install --filter t3code-auth --frozen-lockfile --ignore-scripts --config.allow-unused-patches=true
COPY infra/auth ./infra/auth
RUN cd infra/auth && pnpm exec vp pack

FROM node:26.12.1-trixie-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /repo/infra/auth/dist ./dist
COPY --from=build /repo/infra/auth/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/auth/ok').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
