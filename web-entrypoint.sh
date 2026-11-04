#!/bin/sh
set -eu
export PORT="${PORT:-3000}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
if [ -z "${DATABASE_URL:-}" ]; then
    : "${POSTGRES_USER:?Set POSTGRES_USER}"
    : "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}"
    : "${POSTGRES_DB:?Set POSTGRES_DB}"
    DATABASE_URL="$(node -e 'const e=encodeURIComponent;const p=process.env;process.stdout.write(`postgresql://${e(p.POSTGRES_USER)}:${e(p.POSTGRES_PASSWORD)}@${p.POSTGRES_INTERNAL_HOST||"fluxer-db"}:5432/${e(p.POSTGRES_DB)}`)')"
    export DATABASE_URL
fi
if [ -f /app/server.js ]; then exec node /app/server.js; fi
if [ -f /app/src/web/server.js ]; then exec node /app/src/web/server.js; fi
echo "Fluxer Dashboard standalone server.js is missing" >&2
exit 1
