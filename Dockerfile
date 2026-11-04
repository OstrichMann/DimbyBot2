# LiveKit's native Linux binaries require glibc; Alpine/musl is unsupported.
FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY docker/ytdlp-requirements.txt /tmp/ytdlp-requirements.txt
# Native build tools (e.g. sodium) + ffmpeg for any runtime checks during build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    build-essential \
    autoconf \
    automake \
    libtool \
    g++ \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && . /opt/venv/bin/activate \
    && pip3 install --no-cache-dir -r /tmp/ytdlp-requirements.txt \
    && ln -sf /opt/venv/bin/yt-dlp /usr/bin/yt-dlp

COPY package.json yarn.lock ./
COPY scripts/postinstall-prisma.mjs scripts/prepare-husky.mjs scripts/
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn db:generate && yarn build:bot \
    && yarn install --production --frozen-lockfile \
    && test -f node_modules/.prisma/client/default.js

# --- runtime image ---
FROM node:24-bookworm-slim

WORKDIR /app

# Runtime: ffmpeg + Python for the copied venv; yt-dlp venv is built in the builder stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    ffmpeg \
    gosu \
    wget \
    && ln -s /usr/sbin/gosu /usr/local/bin/su-exec \
    && rm -rf /var/lib/apt/lists/*

ENV FFMPEG_PATH=/usr/bin/ffmpeg

COPY --from=builder /opt/venv /opt/venv
RUN ln -sf /opt/venv/bin/yt-dlp /usr/bin/yt-dlp

COPY package.json yarn.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# prisma.config.ts imports this compiled helper; `src/` is otherwise omitted from the runtime image.
COPY --from=builder /app/dist/util/prismaDatasourceUrl.js ./src/util/prismaDatasourceUrl.js

# Runtime environment (inject via compose/K8s; do not bake secrets into the image):
#   Required for Lavalink: LAVALINK_HOST, LAVALINK_PORT, LAVALINK_PASSWORD, LAVALINK_NODE_ID, LAVALINK_SECURE
#   Bot: BOT_TOKEN, CLIENT_ID, and other vars from .env.example
#   Autoplay (Spotify Web API — same app as Lavalink Spotify plugin):
#     LAVALINK_SPOTIFY_CLIENT_ID, LAVALINK_SPOTIFY_CLIENT_SECRET
#   Optional autoplay overrides: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
#   MusicBrainz fallback: MUSICBRAINZ_CONTACT or MUSICBRAINZ_CONTACT_URL; MUSICBRAINZ_SIMILAR=off to disable

COPY entrypoint.sh entrypoint.sh
COPY healthcheck.sh healthcheck.sh
RUN sed -i 's/\r$//' entrypoint.sh healthcheck.sh \
    && chmod +x entrypoint.sh healthcheck.sh \
    && mkdir -p /app/storage \
    && chown -R node:node /app/dist /app/prisma /app/storage \
    && chown node:node /app \
    && chown node:node /app/package.json /app/yarn.lock /app/prisma.config.ts \
        /app/src/util/prismaDatasourceUrl.js \
        /app/entrypoint.sh /app/healthcheck.sh

# Entrypoint runs as root: generate lavaNodesConfig.js, chown /app/storage (and other writable paths), then su-exec node.
USER root

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]

# healthcheck.sh probes GET /health on BOT_API_PORT (Express bot API).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD /bin/sh /app/healthcheck.sh
