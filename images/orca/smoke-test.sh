#!/usr/bin/env bash
set -euo pipefail

image=${1:-hoosaidthat-orca:dev}
expected_reader=${2:-orca}
engine=${CONTAINER_ENGINE:-podman}
if [[ "$expected_reader" != "orca" ]]; then
  echo "Orca smoke test requires expected reader 'orca'" >&2
  exit 2
fi
temporary_root=$(mktemp -d)
container_name="hoosaidthat-${expected_reader}-smoke-$$"
token="smoke-$(date +%s)-$$"

cleanup() {
  "$engine" rm --force "$container_name" >/dev/null 2>&1 || true
  if [[ -n "${site_pid:-}" ]]; then kill "$site_pid" 2>/dev/null || true; fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT INT TERM

read -r site_port control_port cdp_port < <(
  python3 - <<'PY'
import socket
ports = []
for _ in range(3):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    ports.append(sock.getsockname()[1])
    sock.close()
print(*ports)
PY
)

cat > "$temporary_root/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head><title>Hoo Said That smoke</title></head>
  <body>
    <main><h1>Screen reader harness smoke test</h1><button>Continue</button></main>
  </body>
</html>
HTML

python3 -m http.server "$site_port" --bind 127.0.0.1 --directory "$temporary_root" \
  >"$temporary_root/http.log" 2>&1 &
site_pid=$!

"$engine" run --detach \
  --name "$container_name" \
  --network host \
  --shm-size 1g \
  --env "HST_CONTROL_PORT=$control_port" \
  --env "HST_CDP_PORT=$cdp_port" \
  --env "HST_CONTROL_TOKEN=$token" \
  --env "HST_DISPLAY_NUMBER=$control_port" \
  --env "HST_START_URL=http://127.0.0.1:$site_port" \
  "$image" >/dev/null

CONTROL_PORT="$control_port" CDP_PORT="$cdp_port" TOKEN="$token" \
  EXPECTED_READER="$expected_reader" python3 - <<'PY'
import json
import os
import time
import urllib.request

control = f"http://127.0.0.1:{os.environ['CONTROL_PORT']}"
headers = {"Authorization": f"Bearer {os.environ['TOKEN']}"}


def request_json(path, *, body=None, timeout=5):
    request_headers = dict(headers)
    data = None
    if body is not None:
        request_headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request = urllib.request.Request(control + path, headers=request_headers, data=data)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def act(name):
    response = request_json("/v1/actions", body={"action": name})
    return request_json(
        "/v1/events?after="
        + str(response["afterSequence"])
        + "&timeoutMs=10000&quietMs=500",
        timeout=12,
    )


deadline = time.monotonic() + 60
last_error = None
while time.monotonic() < deadline:
    try:
        health = request_json("/v1/health", timeout=1)
        with urllib.request.urlopen(
            f"http://127.0.0.1:{os.environ['CDP_PORT']}/json/version", timeout=1
        ) as response:
            cdp = json.load(response)
        if health["status"] == "ready" and "webSocketDebuggerUrl" in cdp:
            break
    except Exception as error:
        last_error = error
    time.sleep(0.25)
else:
    raise RuntimeError(f"runtime not ready: {last_error}")

state = request_json("/v1/state")
for _attempt in range(6):
    if state["focus"]["webContentFocused"]:
        break
    act("returnToPage")
    state = request_json("/v1/state")
else:
    raise RuntimeError(f"AT-SPI did not verify web-content focus: {state!r}")

if not state["focus"]["browserWindowActive"]:
    raise RuntimeError(f"Chromium window is not active: {state!r}")

if health["screenReader"]["name"] != os.environ["EXPECTED_READER"]:
    raise RuntimeError(f"wrong screen reader: {health!r}")

events = act("nextHeading")
speech = " ".join(event["text"] for event in events["events"])
if "Screen reader harness smoke test" not in speech or "heading" not in speech.lower():
    raise RuntimeError(
        f"{os.environ['EXPECTED_READER']} did not announce fixture heading: {speech!r}"
    )
print(json.dumps({"health": health, "capturedSpeech": speech}, indent=2))
PY

"$engine" exec "$container_name" pkill -KILL -f '^speech-dispatcher '
for _attempt in $(seq 1 100); do
  running=$("$engine" inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  if [[ "$running" != "true" ]]; then
    echo "Runtime supervisor stopped container after screen reader exited"
    exit 0
  fi
  sleep 0.05
done

"$engine" logs --tail 100 "$container_name" >&2 || true
echo "Runtime container stayed alive after screen reader exited" >&2
exit 1
