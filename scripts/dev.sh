#!/usr/bin/env bash
# Démarre MongoDB si besoin, puis NestJS en mode watch (rechargement à chaud).
set -e
cd "$(dirname "$0")/.."
bash scripts/ensure-mongo.sh
exec npx nest start --watch
