#!/usr/bin/env bash
set -euo pipefail

if [[ "${HST_INSIDE_DBUS:-0}" != "1" ]]; then
  exec dbus-run-session -- env HST_INSIDE_DBUS=1 "$0" "$@"
fi

: "${HST_CONTROL_TOKEN:?HST_CONTROL_TOKEN is required}"
: "${HST_CONTROL_PORT:=3000}"
: "${HST_CDP_PORT:=9222}"
: "${HST_DISPLAY_NUMBER:=99}"
: "${HST_VIEWPORT_WIDTH:=1280}"
: "${HST_VIEWPORT_HEIGHT:=720}"
: "${HST_START_URL:=file:///opt/hoosaidthat/bootstrap.html}"

require_integer_between() {
  local name=$1
  local value=$2
  local minimum=$3
  local maximum=$4
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < minimum || value > maximum )); then
    echo "$name must be an integer between $minimum and $maximum" >&2
    exit 64
  fi
}

require_integer_between HST_CONTROL_PORT "$HST_CONTROL_PORT" 1 65535
require_integer_between HST_CDP_PORT "$HST_CDP_PORT" 1 65535
require_integer_between HST_DISPLAY_NUMBER "$HST_DISPLAY_NUMBER" 1 65535
require_integer_between HST_VIEWPORT_WIDTH "$HST_VIEWPORT_WIDTH" 320 8192
require_integer_between HST_VIEWPORT_HEIGHT "$HST_VIEWPORT_HEIGHT" 240 8192

runtime_root=/tmp/hoosaidthat-runtime
export XDG_CONFIG_HOME="$runtime_root/config"
export XDG_CACHE_HOME="$runtime_root/cache"
export XDG_DATA_HOME="$runtime_root/data"
export XDG_RUNTIME_DIR="$runtime_root/run"
export DISPLAY=":$HST_DISPLAY_NUMBER"
export NO_AT_BRIDGE=0
export GTK_A11Y=1
export MOZ_ENABLE_WAYLAND=0
export HST_EVENTS_FILE="$runtime_root/events.jsonl"
export HST_ACTIONS_FILE="$runtime_root/actions.jsonl"
export HST_SCREEN_READER_NAME=orca
export HST_SCREEN_READER_CAPTURE=speech-dispatcher-output-module
export HST_SCREEN_READER_PID_ENV=HST_ORCA_PID
export HST_OPTIONAL_SPEECH_PID_ENV=HST_SPEECHD_PID
export HST_CAPTURE_PROCESS_FRAGMENT=/opt/hoosaidthat/sd_capture.py

install -d -m 0700 \
  "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \
  "$XDG_RUNTIME_DIR" "$runtime_root/logs" "$runtime_root/browser-profile" \
  "$runtime_root/speechd" "$runtime_root/speechd-modules"
: > "$HST_EVENTS_FILE"
: > "$HST_ACTIONS_FILE"
: > "$runtime_root/speechd/module.conf"

cat > "$runtime_root/speechd/speechd.conf" <<EOF
LogLevel 3
LogDir "$runtime_root/logs"
CommunicationMethod "unix_socket"
SocketPath "$runtime_root/speechd.sock"
AddModule "hoosaidthat" "/opt/hoosaidthat/sd_capture.py" "$runtime_root/speechd/module.conf" "$runtime_root/logs/capture-module.log"
DefaultModule hoosaidthat
DefaultLanguage "en"
DisableAutoSpawn
EOF

pids=()
cleanup() {
  local pid
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "${HST_VIEWPORT_WIDTH}x${HST_VIEWPORT_HEIGHT}x24" -nolisten tcp \
  >"$runtime_root/logs/xvfb.stdout.log" 2>"$runtime_root/logs/xvfb.stderr.log" &
export HST_XVFB_PID=$!
pids+=("$HST_XVFB_PID")

for _attempt in $(seq 1 100); do
  [[ -S "/tmp/.X11-unix/X$HST_DISPLAY_NUMBER" ]] && break
  sleep 0.05
done
[[ -S "/tmp/.X11-unix/X$HST_DISPLAY_NUMBER" ]]

matchbox-window-manager -use_titlebar no \
  >"$runtime_root/logs/window-manager.stdout.log" \
  2>"$runtime_root/logs/window-manager.stderr.log" &
export HST_WINDOW_MANAGER_PID=$!
pids+=("$HST_WINDOW_MANAGER_PID")

speech-dispatcher \
  --run-single \
  --config-dir "$runtime_root/speechd" \
  --module-dir "$runtime_root/speechd-modules" \
  --communication-method unix_socket \
  --socket-path "$runtime_root/speechd.sock" \
  --timeout 0 \
  --log-dir "$runtime_root/logs" \
  >"$runtime_root/logs/speechd.stdout.log" 2>"$runtime_root/logs/speechd.stderr.log" &
export HST_SPEECHD_PID=$!
pids+=("$HST_SPEECHD_PID")
export SPEECHD_ADDRESS="unix_socket:$runtime_root/speechd.sock"

for _attempt in $(seq 1 100); do
  [[ -S "$runtime_root/speechd.sock" ]] && break
  sleep 0.05
done
[[ -S "$runtime_root/speechd.sock" ]]

# Resolve immutable process metadata before starting Orca. Health polling must
# stay side-effect free; spawning `orca --version` per request can contend with
# the running Orca process and starve the threaded control server.
export HST_SCREEN_READER_VERSION
HST_SCREEN_READER_VERSION=$(orca --version 2>&1 | sed -n '1p')
if [[ -z "$HST_SCREEN_READER_VERSION" ]]; then
  echo "Orca version could not be determined" >&2
  exit 70
fi

orca_args=(--replace --debug-file "$runtime_root/logs/orca-debug.log")
if orca --help 2>&1 | grep -q -- '--speech-system'; then
  orca_args+=(--speech-system speechdispatcherfactory)
fi
orca "${orca_args[@]}" >"$runtime_root/logs/orca.stdout.log" 2>"$runtime_root/logs/orca.stderr.log" &
export HST_ORCA_PID=$!
pids+=("$HST_ORCA_PID")

chromium_path=$(find /ms-playwright -type f -path '*/chrome-linux*/chrome' -perm -111 -print -quit)
if [[ -z "$chromium_path" ]]; then
  echo "Playwright Chromium executable not found" >&2
  exit 70
fi
export HST_CHROMIUM_VERSION
HST_CHROMIUM_VERSION=$($chromium_path --product-version)

"$chromium_path" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-component-update \
  --disable-default-apps \
  --disable-features=Translate,OptimizationHints,MediaRouter \
  --disable-sync \
  --force-renderer-accessibility=complete \
  --no-default-browser-check \
  --no-first-run \
  --ozone-platform=x11 \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$HST_CDP_PORT" \
  --user-data-dir="$runtime_root/browser-profile" \
  --window-size="${HST_VIEWPORT_WIDTH},${HST_VIEWPORT_HEIGHT}" \
  --app="$HST_START_URL" \
  >"$runtime_root/logs/chromium.stdout.log" 2>"$runtime_root/logs/chromium.stderr.log" &
export HST_CHROMIUM_PID=$!
pids+=("$HST_CHROMIUM_PID")

python3 - <<'PY'
import os
import time
import urllib.request

url = f"http://127.0.0.1:{os.environ['HST_CDP_PORT']}/json/version"
deadline = time.monotonic() + 20
last_error = None
while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=0.5) as response:
            if response.status == 200:
                break
    except OSError as error:
        last_error = error
    time.sleep(0.1)
else:
    raise RuntimeError(f"Chromium CDP did not become ready: {last_error}")
PY

python3 /opt/hoosaidthat/control_server.py &
control_pid=$!
pids+=("$control_pid")

window_id=
for _attempt in $(seq 1 200); do
  candidate=$(xdotool search --onlyvisible --class chromium 2>/dev/null | tail -n 1 || true)
  if [[ -n "$candidate" ]] && xdotool windowactivate --sync "$candidate" 2>/dev/null; then
    window_id=$candidate
    break
  fi
  sleep 0.1
done
if [[ -z "$window_id" ]]; then
  echo "Chromium window did not become visible and active" >&2
  exit 70
fi
# Chromium registers its Linux accessibility application lazily on the first
# keyboard transfer into web content. Verify registration through the same
# authenticated health contract clients use instead of relying on a fixed
# startup delay.
bootstrap_ready=0
for _focus_attempt in 1 2 3; do
  xdotool windowactivate --sync "$window_id"
  sleep 0.5
  xdotool key --clearmodifiers F6
  if python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request

request = urllib.request.Request(
    f"http://127.0.0.1:{os.environ['HST_CONTROL_PORT']}/v1/health",
    headers={"Authorization": f"Bearer {os.environ['HST_CONTROL_TOKEN']}"},
)
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(request, timeout=1) as response:
            value = json.load(response)
        if response.status == 200 and value.get("status") == "ready":
            raise SystemExit(0)
    except (OSError, ValueError, urllib.error.HTTPError):
        pass
    time.sleep(0.25)
raise SystemExit(1)
PY
  then
    bootstrap_ready=1
    break
  fi
done
if (( bootstrap_ready != 1 )); then
  echo "Chromium accessibility application did not become ready" >&2
  exit 70
fi

for required_pid in "$HST_XVFB_PID" "$HST_WINDOW_MANAGER_PID" "$HST_SPEECHD_PID" "$HST_ORCA_PID" "$HST_CHROMIUM_PID"; do
  if ! kill -0 "$required_pid" 2>/dev/null; then
    echo "Required runtime process $required_pid exited during startup" >&2
    exit 70
  fi
done

set +e
exited_pid=
wait -n -p exited_pid "${pids[@]}"
exit_status=$?
set -e
echo "Runtime process ${exited_pid:-unknown} exited with status $exit_status" >&2
if (( exit_status == 0 )); then
  exit_status=1
fi
exit "$exit_status"
