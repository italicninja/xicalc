# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Build toolchain for better-sqlite3 (used only if no prebuilt binary matches).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install deps against the lockfile first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Default DB location. On Railway, mount a Volume here so it survives redeploys.
ENV DATABASE_PATH=/data/xicalc.db
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
