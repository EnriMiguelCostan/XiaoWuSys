# XiaoWuSys screens (Next.js, UI only). Build context: XiaoWuSys-main/ (not Web/), because
# Web/ depends on ../shared/client-core:
#   docker build -f Web/Dockerfile -t xiaowusys-web .
# N2: this image never receives backend secrets (DATABASE_URL, PG_LISTEN_URL, JWT_SECRET,
# TEST_DATABASE_URL); next.config.ts refuses to build or start if it does.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY shared/client-core /app/shared/client-core
COPY Web /app/Web

WORKDIR /app/Web
RUN npm ci && npm install ../shared/client-core

# Optional fixed API address, inlined at build time. Empty: the browser uses the address it
# opened the page with, on port 5000 (works for the shop computer and LAN tablets).
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/Web

# client-core sits at ../shared/client-core, where node_modules/@xiaowu/client-core links to
COPY --from=builder /app/shared/client-core /app/shared/client-core
COPY --from=builder /app/Web/.next ./.next
COPY --from=builder /app/Web/public ./public
COPY --from=builder /app/Web/node_modules ./node_modules
COPY --from=builder /app/Web/package.json ./package.json
COPY --from=builder /app/Web/next.config.ts ./next.config.ts

RUN chown -R node:node /app/Web/.next
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["npm", "run", "start"]
