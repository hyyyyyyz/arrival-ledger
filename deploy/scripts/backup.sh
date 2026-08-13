#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
DATA_ROOT="${DATA_ROOT:-/home/jackson/arrival-manager-data}"
BACKUP_ROOT="${BACKUP_ROOT:-${DATA_ROOT}/backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_ARCHIVE="${BACKUP_ROOT}/arrival-ledger-${TIMESTAMP}.tar.gz"
TEMP_ARCHIVE="${FINAL_ARCHIVE}.partial"
BACKEND_WAS_RUNNING=false

cd "${PROJECT_ROOT}"
mkdir -p "${BACKUP_ROOT}"

if sudo docker compose ps --status running --services | grep -qx backend; then
    BACKEND_WAS_RUNNING=true
fi

restart_backend() {
    rm -f -- "${TEMP_ARCHIVE}"
    if [[ "${BACKEND_WAS_RUNNING}" == true ]]; then
        sudo docker compose start backend >/dev/null
    fi
}
trap restart_backend EXIT

if [[ "${BACKEND_WAS_RUNNING}" == true ]]; then
    echo "Stopping backend briefly for a consistent SQLite/media snapshot..."
    sudo docker compose stop --timeout 30 backend
fi

for required_dir in db media uploads; do
    if [[ ! -d "${DATA_ROOT}/${required_dir}" ]]; then
        echo "Missing data directory: ${DATA_ROOT}/${required_dir}" >&2
        exit 1
    fi
done

sudo tar -C "${DATA_ROOT}" -czf - db media uploads >"${TEMP_ARCHIVE}"
mv -- "${TEMP_ARCHIVE}" "${FINAL_ARCHIVE}"

echo "Backup created: ${FINAL_ARCHIVE}"
