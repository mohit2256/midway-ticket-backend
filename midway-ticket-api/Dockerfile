# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build


# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

USER nestjs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# FIX: migrations (src/migrations/*.ts) were never executed anywhere in the
# deploy pipeline — not in this Dockerfile, not in railway.json, not as a
# Railway pre-deploy step. TypeORM's `synchronize` was also off in production
# (correctly — it's unsafe with the partitioned `tickets` table), which meant
# NO tables were ever created on a fresh database. Every real request
# (fairs, login, bookings...) failed with `relation "..." does not exist`.
#
# `typeorm migration:run` is idempotent — TypeORM tracks applied migrations
# in its own `migrations` table and skips ones already run, so this is safe
# to execute on every container start, not just the first one.
CMD ["sh", "-c", "node node_modules/.bin/typeorm migration:run -d dist/config/typeorm-cli.datasource.js && node dist/main"]
