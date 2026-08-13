#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
BASE_URL="${1:-http://127.0.0.1:${APP_PORT:-8766}}"

cd "${PROJECT_ROOT}"

echo "[1/4] Compose service status"
sudo docker compose ps

echo "[2/4] Frontend health: ${BASE_URL}/healthz"
test "$(curl --fail --silent --show-error --max-time 10 "${BASE_URL}/healthz")" = "ok"

echo "[3/4] Backend health through the frontend gateway"
curl --fail --silent --show-error --max-time 10 "${BASE_URL}/api/health"
echo

echo "[4/4] Required response headers"
headers="$(curl --fail --silent --show-error --head --max-time 10 "${BASE_URL}/")"
grep -qi '^X-Content-Type-Options: nosniff' <<<"${headers}"
grep -qi '^X-Frame-Options: DENY' <<<"${headers}"
grep -qi '^Content-Security-Policy:' <<<"${headers}"

echo "Verification passed: ${BASE_URL}"
