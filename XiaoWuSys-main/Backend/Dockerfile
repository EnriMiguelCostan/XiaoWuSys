# XiaoWuSys API (Express 5 + SQLite offline cache). Build context: XiaoWuSys-main/Backend
#   docker build -t xiaowusys-backend ./Backend
# Secrets (DATABASE_URL, JWT_SECRET, ...) are never baked in: pass them at run time
# (docker compose reads Backend/.env). The SQLite cache lives on the /data volume.
FROM node:22-trixie-slim

WORKDIR /app/Backend

# Dependencies first, so source edits do not reinstall them (sqlite3 and bcrypt ship
# prebuilt binaries for linux-x64 / arm64 glibc)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Source (node_modules, .env, *.db and tests are excluded by .dockerignore)
COPY . .

RUN mkdir -p /data && chown -R node:node /data /app/Backend
ENV NODE_ENV=production \
    LOCAL_DB_PATH=/data/local_cache.db \
    PORT=5000 \
    HOST=0.0.0.0
VOLUME ["/data"]
USER node

EXPOSE 5000

# node:*-slim has no curl: poll with Node's own fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/api/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.js"]
