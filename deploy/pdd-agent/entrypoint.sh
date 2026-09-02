#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly display_number="${DISPLAY:-:99}"
readonly screen_size="${PDD_DISPLAY_SIZE:-1280x900}"
readonly vnc_secret_file="${PDD_VNC_PASSWORD_FILE:-/data/config/vnc-password}"
readonly runtime_dir="/run/pdd-agent"
readonly home_dir="/tmp/pdd-home"

if [[ ! "${screen_size}" =~ ^[0-9]{3,5}x[0-9]{3,5}$ ]]; then
  echo "fatal: PDD_DISPLAY_SIZE must look like 1280x900" >&2
  exit 1
fi

if [[ ! -r "${vnc_secret_file}" ]]; then
  echo "fatal: VNC password file is missing or unreadable: ${vnc_secret_file}" >&2
  exit 1
fi

IFS= read -r vnc_password < "${vnc_secret_file}" || true
if [[ ${#vnc_password} -lt 8 ]] || [[ "${vnc_password}" == *CHANGE_ME* ]]; then
  echo "fatal: replace the placeholder VNC password with a private value of at least 8 characters" >&2
  exit 1
fi

mkdir -p "${runtime_dir}" "${home_dir}" "${home_dir}/.cache" /tmp/pdd-runtime
chmod 0700 "${runtime_dir}" "${home_dir}" /tmp/pdd-runtime
export DISPLAY="${display_number}"
export HOME="${home_dir}"
export XDG_RUNTIME_DIR=/tmp/pdd-runtime

# Classic VNC authentication uses only the first eight characters.  Feed them
# through the prompt so the secret never appears in a transient process argv.
vnc_password="${vnc_password:0:8}"
printf '%s\n%s\ny\n' "${vnc_password}" "${vnc_password}" \
  | x11vnc -storepasswd "${runtime_dir}/vnc.pass" >/dev/null 2>&1
unset vnc_password

children=()

cleanup() {
  trap - EXIT INT TERM
  if (( ${#children[@]} > 0 )); then
    kill "${children[@]}" 2>/dev/null || true
    wait "${children[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

Xvfb "${DISPLAY}" -screen 0 "${screen_size}x24" -nolisten tcp -ac &
children+=("$!")

for _ in {1..50}; do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
  echo "fatal: Xvfb did not become ready" >&2
  exit 1
fi

openbox-session >/tmp/openbox.log 2>&1 &
children+=("$!")

# x11vnc is reachable only by websockify inside this container. Compose then
# publishes noVNC on the host loopback address, so an SSH tunnel is required.
x11vnc \
  -display "${DISPLAY}" \
  -rfbport 5900 \
  -rfbauth "${runtime_dir}/vnc.pass" \
  -localhost \
  -forever \
  -shared \
  -noxdamage \
  -repeat \
  -quiet &
children+=("$!")

websockify \
  --web=/usr/share/novnc/ \
  --heartbeat=30 \
  0.0.0.0:6080 \
  127.0.0.1:5900 &
children+=("$!")

echo "PDD remote desktop is ready on container port 6080 (SSH tunnel required)."

set +e
wait -n "${children[@]}"
status=$?
set -e
echo "fatal: a PDD desktop process exited (status ${status}); stopping the container" >&2
exit "${status}"
