#!/bin/sh
set -eu
# DATABASE_URL is explicit, or built from this independent Compose database's credentials.
if [ -z "${DATABASE_URL:-}" ]; then
    : "${POSTGRES_USER:?Set POSTGRES_USER}"
    : "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}"
    : "${POSTGRES_DB:?Set POSTGRES_DB}"
    DATABASE_URL="$(node -e 'const e=encodeURIComponent;const p=process.env;process.stdout.write(`postgresql://${e(p.POSTGRES_USER)}:${e(p.POSTGRES_PASSWORD)}@${p.POSTGRES_INTERNAL_HOST||"fluxer-db"}:5432/${e(p.POSTGRES_DB)}`)')"
    export DATABASE_URL
fi
mkdir -p /app/storage/fluxer
exec "$@"
