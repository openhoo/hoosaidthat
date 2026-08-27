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
: "${HOOVDA_PROFILE:=nvda-web-2026.1.1}"
: "${HOOVDA_LOCALE:=en-US}"
: "${HOOVDA_KEYBOARD_LAYOUT:=desktop}"

require_integer_between() {
  local name=$1 value=$2 minimum=$3 maximum=$4
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

atspi_version=$(awk '$1 == "Version:" { print $2 }' /opt/hoovda-runtime/lib/x86_64-linux-gnu/pkgconfig/atspi-2.pc)
espeak_version=$(espeak-ng --version 2>&1 | awk 'NR == 1 { print $4 }')
liblouis_version=$(lou_translate --version 2>&1 | awk 'NR == 1 { print $3 }')
if [[ "$atspi_version" != "2.60.1" || "$espeak_version" != "1.52.0" || "$liblouis_version" != "3.38.0" ]]; then
  echo "Pinned runtime dependency verification failed: AT-SPI=$atspi_version eSpeak=$espeak_version Liblouis=$liblouis_version" >&2
  exit 78
fi

runtime_root=/tmp/hoosaidthat-runtime
export XDG_CONFIG_HOME="$runtime_root/config"
export XDG_CACHE_HOME="$runtime_root/cache"
export XDG_DATA_HOME="$runtime_root/data"
export XDG_RUNTIME_DIR="$runtime_root/run"
export DISPLAY=":$HST_DISPLAY_NUMBER"
export NO_AT_BRIDGE=0
export GTK_A11Y=1
export ACCESSIBILITY_ENABLED=1
export MOZ_ENABLE_WAYLAND=0
export HOOVDA_CONTROL_ADDRESS="127.0.0.1:$HST_CONTROL_PORT"
export HOOVDA_CONTROL_TOKEN="$HST_CONTROL_TOKEN"
export HOOVDA_VIEWPORT_WIDTH="$HST_VIEWPORT_WIDTH"
export HOOVDA_VIEWPORT_HEIGHT="$HST_VIEWPORT_HEIGHT"
export HOOVDA_ARTIFACTS_ROOT="$runtime_root/artifacts"

install -d -m 0700 \
  "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" \
  "$runtime_root/logs" "$runtime_root/browser-profile" "$HOOVDA_ARTIFACTS_ROOT"

# org.a11y.Bus and at-spi2-registryd are D-Bus activated after Chromium starts.
# Activation uses the bus daemon's environment, not this shell's current one.
# Without DISPLAY the accessibility graph remains available, but global X11
# screenreader key grabs silently fail.
dbus-update-activation-environment DISPLAY XDG_RUNTIME_DIR XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME

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
pids+=("$!")

for _attempt in $(seq 1 100); do
  [[ -S "/tmp/.X11-unix/X$HST_DISPLAY_NUMBER" ]] && break
  sleep 0.05
done
[[ -S "/tmp/.X11-unix/X$HST_DISPLAY_NUMBER" ]]

matchbox-window-manager -use_titlebar no \
  >"$runtime_root/logs/window-manager.stdout.log" \
  2>"$runtime_root/logs/window-manager.stderr.log" &
pids+=("$!")

chromium_path=$(find /ms-playwright -type f -path '*/chrome-linux*/chrome' -perm -111 -print -quit)
if [[ -z "$chromium_path" ]]; then
  echo "Playwright Chromium executable not found" >&2
  exit 70
fi

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
  --new-window "$HST_START_URL" \
  >"$runtime_root/logs/chromium.stdout.log" 2>"$runtime_root/logs/chromium.stderr.log" &
pids+=("$!")

deadline=$((SECONDS + 20))
until curl --fail --silent --max-time 1 "http://127.0.0.1:$HST_CDP_PORT/json/version" >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "Chromium CDP did not become ready" >&2
    exit 70
  fi
  sleep 0.1
done

window_id=$(xdotool search --onlyvisible --class chromium 2>/dev/null | tail -n 1 || true)
if [[ -n "$window_id" ]]; then
  xdotool windowactivate --sync "$window_id" || true
fi

hoovda serve >"$runtime_root/logs/hoovda.stdout.log" 2>"$runtime_root/logs/hoovda.stderr.log" &
pids+=("$!")

deadline=$((SECONDS + 60))
until curl --fail --silent --max-time 1 \
  --header "Authorization: Bearer $HST_CONTROL_TOKEN" \
  "http://127.0.0.1:$HST_CONTROL_PORT/v2/health" >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "HooVDA control API did not become ready" >&2
    tail -n 100 "$runtime_root/logs/hoovda.stderr.log" >&2 || true
    exit 70
  fi
  sleep 0.1
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
