#!/bin/sh
set -eu
mkdir -p /app/dist /app/storage/fluxer
chown node:node /app
chown -R node:node /app/dist /app/storage/fluxer
for directory in /app/node_modules/.prisma /app/node_modules/@prisma; do
    if [ -d "$directory" ]; then chown -R node:node "$directory"; fi
done
exec gosu node /usr/local/bin/fluxer-entrypoint.sh "$@"
