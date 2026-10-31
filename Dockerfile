# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm install --workspaces --include-workspace-root

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY apps/server ./apps/server

RUN npm run build:shared && npm run build:web && npm run build:server

# Production Runtime Image
FROM node:22-bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist

RUN mkdir -p /app/data /app/uploads /app/release/desktop

EXPOSE 3001
EXPOSE 40000-40400/udp
EXPOSE 40000-40400/tcp

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]

