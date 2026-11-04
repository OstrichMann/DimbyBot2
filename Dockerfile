# Fluxer voice uses LiveKit's glibc binaries and FFmpeg pipe decoding.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
COPY scripts/postinstall-prisma.mjs scripts/prepare-husky.mjs scripts/
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn db:generate && yarn build:bot \
    && yarn install --production --frozen-lockfile \
    && test -f node_modules/.prisma/client/default.js

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg wget \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg
COPY package.json yarn.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/dist/util/prismaDatasourceUrl.js ./src/util/prismaDatasourceUrl.js
COPY --chmod=755 entrypoint.sh healthcheck.sh ./
RUN mkdir -p /app/storage/fluxer && chown -R node:node /app/storage
USER node
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/server.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD /app/healthcheck.sh
