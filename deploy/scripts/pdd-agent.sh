#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "${script_dir}/../.." && pwd -P)"
compose_file="${repo_root}/deploy/pdd-agent/docker-compose.pdd-agent.yml"

export PDD_AGENT_DATA_ROOT="${PDD_AGENT_DATA_ROOT:-/var/lib/arrival-ledger/pdd}"
export PDD_AGENT_UID="${PDD_AGENT_UID:-10002}"
export PDD_AGENT_GID="${PDD_AGENT_GID:-10002}"
export ARRIVAL_LEDGER_APP_NETWORK="${ARRIVAL_LEDGER_APP_NETWORK:-arrival-ledger_app}"
export PDD_SECCOMP_PROFILE="${PDD_SECCOMP_PROFILE:-${repo_root}/deploy/pdd-agent/seccomp_profile.json}"

compose() {
  docker compose \
    --project-directory "${repo_root}" \
    -f "${compose_file}" \
    --profile pdd-agent \
    "$@"
}

usage() {
  cat <<'EOF'
Usage: deploy/scripts/pdd-agent.sh COMMAND [ARGUMENT]

Commands:
  init                   Create private host directories and placeholder config (run as root)
  build                  Build the pinned Playwright PDD Agent image
  start                  Start Xvfb, noVNC, and the idle PDD Agent container
  stop                   Stop the PDD Agent without deleting profiles or state
  status                 Show container status and the loopback-only port mapping
  logs                   Follow desktop service logs (never logs browser contents)
  doctor                 Validate configuration and the bundled browser without opening PDD
  accounts               List configured PDD account keys and profile paths
  login-check ACCOUNT [WAIT_SECONDS]
                         Open one account's visible browser for manual login/verification;
                         optionally poll the same page for 1-3600 seconds without terminal input
  dry-run ACCOUNT        Read one account once and create a local snapshot; never uploads it
  commit ACCOUNT SNAPSHOT_FILE
                         Upload one reviewed dry-run snapshot without re-opening PDD

noVNC is deliberately not exposed publicly. From a Mac, first run:
  ssh -N -L 6080:127.0.0.1:6080 <ssh-user>@<server-ip>
Then open http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
EOF
}

validate_runtime_settings() {
  if [[ ! "${PDD_AGENT_UID}" =~ ^[0-9]+$ ]] \
    || (( 10#${PDD_AGENT_UID} < 1000 || 10#${PDD_AGENT_UID} > 60000 )); then
    echo "error: PDD_AGENT_UID must be an integer between 1000 and 60000" >&2
    exit 2
  fi
  if [[ ! "${PDD_AGENT_GID}" =~ ^[0-9]+$ ]] \
    || (( 10#${PDD_AGENT_GID} < 1000 || 10#${PDD_AGENT_GID} > 60000 )); then
    echo "error: PDD_AGENT_GID must be an integer between 1000 and 60000" >&2
    exit 2
  fi
  if [[ "${PDD_AGENT_DATA_ROOT}" != /* || "${PDD_AGENT_DATA_ROOT}" == "/" ]]; then
    echo "error: PDD_AGENT_DATA_ROOT must be an absolute, non-root directory" >&2
    exit 2
  fi

  local canonical_root
  canonical_root="$(realpath -m -- "${PDD_AGENT_DATA_ROOT}")"
  if [[ "${canonical_root}" != "${PDD_AGENT_DATA_ROOT}" ]]; then
    echo "error: PDD_AGENT_DATA_ROOT must be canonical and must not traverse symlinks" >&2
    exit 2
  fi
  if [[ -e "${PDD_AGENT_DATA_ROOT}" && ! -d "${PDD_AGENT_DATA_ROOT}" ]] \
    || [[ -L "${PDD_AGENT_DATA_ROOT}" ]]; then
    echo "error: PDD_AGENT_DATA_ROOT must be a real directory, not a file or symlink" >&2
    exit 2
  fi
}

require_account_key() {
  local account_key="${1:-}"
  if [[ ! "${account_key}" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    echo "error: ACCOUNT must be a configured lowercase account_key" >&2
    exit 2
  fi
  printf '%s' "${account_key}"
}

require_runtime_config() {
  local config_dir="${PDD_AGENT_DATA_ROOT}/config"
  local env_file="${config_dir}/.env.local"
  local accounts_file="${config_dir}/pdd-accounts.json"
  local password_file="${config_dir}/vnc-password"

  for file in "${env_file}" "${accounts_file}" "${password_file}"; do
    if [[ ! -r "${file}" ]]; then
      echo "error: missing or unreadable runtime file: ${file}; run init and configure it" >&2
      exit 1
    fi
  done
  if grep -Eq 'CHANGE_ME|example\.invalid' "${env_file}" "${password_file}"; then
    echo "error: runtime config still contains a placeholder; edit ${config_dir} before starting" >&2
    exit 1
  fi
}

require_main_network() {
  if ! docker network inspect "${ARRIVAL_LEDGER_APP_NETWORK}" >/dev/null 2>&1; then
    echo "error: Docker network ${ARRIVAL_LEDGER_APP_NETWORK} does not exist" >&2
    echo "start the main arrival-ledger Compose project before starting the PDD Agent" >&2
    exit 1
  fi
}

init_runtime() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "error: init must run as root so bind mounts can be assigned to UID/GID ${PDD_AGENT_UID}:${PDD_AGENT_GID}" >&2
    echo "run: sudo env PDD_AGENT_DATA_ROOT=${PDD_AGENT_DATA_ROOT} $0 init" >&2
    exit 1
  fi

  local config_dir="${PDD_AGENT_DATA_ROOT}/config"
  install -d -o root -g "${PDD_AGENT_GID}" -m 0750 "${PDD_AGENT_DATA_ROOT}"
  install -d -o root -g "${PDD_AGENT_GID}" -m 0750 "${config_dir}"
  install -d -o "${PDD_AGENT_UID}" -g "${PDD_AGENT_GID}" -m 0700 \
    "${PDD_AGENT_DATA_ROOT}/profiles" \
    "${PDD_AGENT_DATA_ROOT}/state" \
    "${PDD_AGENT_DATA_ROOT}/logs"

  if [[ ! -e "${config_dir}/.env.local" ]]; then
    install -o "${PDD_AGENT_UID}" -g "${PDD_AGENT_GID}" -m 0600 \
      "${repo_root}/deploy/pdd-agent/agent.env.example" \
      "${config_dir}/.env.local"
  fi
  if [[ ! -e "${config_dir}/pdd-accounts.json" ]]; then
    install -o "${PDD_AGENT_UID}" -g "${PDD_AGENT_GID}" -m 0600 \
      "${repo_root}/deploy/pdd-agent/pdd-accounts.json.example" \
      "${config_dir}/pdd-accounts.json"
  fi
  if [[ ! -e "${config_dir}/vnc-password" ]]; then
    umask 077
    # VNC authentication consumes exactly eight characters.  Six random bytes
    # encode to eight Base64 characters without padding.
    openssl rand -base64 6 > "${config_dir}/vnc-password"
    chown "${PDD_AGENT_UID}":"${PDD_AGENT_GID}" "${config_dir}/vnc-password"
    chmod 0600 "${config_dir}/vnc-password"
  fi

  echo "Initialized ${PDD_AGENT_DATA_ROOT}."
  echo "Next: edit ${config_dir}/.env.local and ${config_dir}/pdd-accounts.json; do not commit them."
}

require_snapshot_file() {
  local account_key="$1"
  local snapshot_file="${2:-}"
  local prefix="snapshot-pdd-${account_key}-"
  if [[ "${snapshot_file}" != "${prefix}"*.json ]]; then
    echo "error: SNAPSHOT_FILE must be the basename emitted by dry-run for ${account_key}" >&2
    exit 2
  fi
  local snapshot_id="${snapshot_file#"${prefix}"}"
  snapshot_id="${snapshot_id%.json}"
  if [[ ! "${snapshot_id}" =~ ^[A-Za-z0-9-]{20,64}$ ]]; then
    echo "error: SNAPSHOT_FILE has an invalid batch id" >&2
    exit 2
  fi

  local state_dir="${PDD_AGENT_DATA_ROOT}/state"
  local host_path="${state_dir}/${snapshot_file}"
  if [[ ! -f "${host_path}" || -L "${host_path}" ]]; then
    echo "error: snapshot is missing, not a regular file, or is a symlink: ${host_path}" >&2
    exit 2
  fi
  local canonical_state canonical_snapshot
  canonical_state="$(realpath -e -- "${state_dir}")"
  canonical_snapshot="$(realpath -e -- "${host_path}")"
  if [[ "${canonical_snapshot}" != "${canonical_state}/${snapshot_file}" ]]; then
    echo "error: snapshot escapes the private state directory" >&2
    exit 2
  fi
  printf '%s' "/data/state/${snapshot_file}"
}

command="${1:-}"
if [[ "${command}" != "help" && "${command}" != "-h" && "${command}" != "--help" && -n "${command}" ]]; then
  validate_runtime_settings
fi
case "${command}" in
  init)
    init_runtime
    ;;
  build)
    compose build pdd-agent
    ;;
  start)
    require_runtime_config
    require_main_network
    compose up --detach --build pdd-agent
    ;;
  stop)
    compose stop pdd-agent
    ;;
  status)
    compose ps pdd-agent
    ;;
  logs)
    compose logs --follow --tail 100 pdd-agent
    ;;
  doctor)
    require_runtime_config
    compose exec pdd-agent node /opt/arrival-ledger/sync-agent/dist/cli.js doctor --platform pdd
    ;;
  accounts)
    require_runtime_config
    compose exec pdd-agent node /opt/arrival-ledger/sync-agent/dist/cli.js accounts --platform pdd
    ;;
  login-check)
    require_runtime_config
    account_key="$(require_account_key "${2:-}")"
    wait_seconds="${3:-}"
    if [[ -n "${wait_seconds}" ]]; then
      if [[ ! "${wait_seconds}" =~ ^[0-9]+$ ]] \
        || (( 10#${wait_seconds} < 1 || 10#${wait_seconds} > 3600 )); then
        echo "error: WAIT_SECONDS must be an integer between 1 and 3600" >&2
        exit 2
      fi
      compose exec --no-TTY pdd-agent node /opt/arrival-ledger/sync-agent/dist/cli.js \
        login-check --platform pdd --account "${account_key}" --wait-seconds "${wait_seconds}"
    else
      compose exec pdd-agent node /opt/arrival-ledger/sync-agent/dist/cli.js \
        login-check --platform pdd --account "${account_key}"
    fi
    ;;
  dry-run)
    require_runtime_config
    account_key="$(require_account_key "${2:-}")"
    compose exec pdd-agent node /opt/arrival-ledger/sync-agent/dist/cli.js \
      sync-once --platform pdd --account "${account_key}" --mode dry-run
    ;;
  commit)
    require_runtime_config
    account_key="$(require_account_key "${2:-}")"
    snapshot_path="$(require_snapshot_file "${account_key}" "${3:-}")"
    compose exec --no-TTY pdd-agent node /opt/arrival-ledger/sync-agent/dist/cli.js \
      sync-once --platform pdd --account "${account_key}" --mode commit \
      --from-report "${snapshot_path}" --yes
    ;;
  help|-h|--help|"")
    usage
    ;;
  *)
    echo "error: unknown command: ${command}" >&2
    usage >&2
    exit 2
    ;;
esac
