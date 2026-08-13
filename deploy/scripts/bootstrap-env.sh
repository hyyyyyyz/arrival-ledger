#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

cd "${PROJECT_ROOT}"

if [[ -f "${ENV_FILE}" ]]; then
    echo "ENV_STATUS=existing"
    stat -c 'ENV_MODE=%a ENV_OWNER=%U:%G' "${ENV_FILE}"
    exit 0
fi

umask 077
SESSION_SECRET="$(openssl rand -hex 32)"
ADMIN_PASSWORD="$(openssl rand -hex 12)"
TEMP_ENV="$(mktemp "${PROJECT_ROOT}/.env.tmp.XXXXXX")"

cleanup() {
    rm -f -- "${TEMP_ENV}"
}
trap cleanup EXIT

{
    printf 'TZ=Asia/Shanghai\n'
    printf 'DATA_ROOT=/home/jackson/arrival-manager-data\n'
    printf 'BIND_ADDRESS=0.0.0.0\n'
    printf 'APP_PORT=8766\n'
    printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET}"
    printf 'BOOTSTRAP_ADMIN_USERNAME=admin\n'
    printf 'BOOTSTRAP_ADMIN_DISPLAY_NAME=管理员\n'
    printf 'BOOTSTRAP_ADMIN_PASSWORD=%s\n' "${ADMIN_PASSWORD}"
    printf 'COOKIE_SECURE=false\n'
    printf 'MAX_UPLOAD_BYTES=12582912\n'
    printf 'BACKEND_IMAGE=arrival-ledger-backend:local\n'
    printf 'FRONTEND_IMAGE=arrival-ledger-frontend:local\n'
    printf 'CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest\n'
} >"${TEMP_ENV}"

chmod 0600 "${TEMP_ENV}"
mv -- "${TEMP_ENV}" "${ENV_FILE}"
trap - EXIT

echo "ENV_STATUS=created"
echo "ADMIN_USERNAME=admin"
echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}"
stat -c 'ENV_MODE=%a ENV_OWNER=%U:%G' "${ENV_FILE}"
