#!/usr/bin/env bash
set -euo pipefail

image=${1:-hoosaidthat-hoovda:dev}
engine=${CONTAINER_ENGINE:-podman}
container_name="hoosaidthat-hoovda-smoke-$$"
token="smoke-$(date +%s)-$$"

cleanup() {
  "$engine" rm --force "$container_name" >/dev/null 2>&1 || true
  if [[ -n "${site_pid:-}" ]]; then kill "$site_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

ports=$(node -e '
const net = require("node:net");
Promise.all([0, 0, 0].map(() => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
}))).then((values) => console.log(values.join(" ")));
')
read -r site_port control_port cdp_port <<<"$ports"

SITE_PORT="$site_port" node -e '
const http = require("node:http");
const html = `<!doctype html><html lang="en"><head><title>HooVDA smoke</title></head><body><main><h1>HooVDA harness smoke test</h1><button>Continue</button></main></body></html>`;
http.createServer((_request, response) => {
  response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
  response.end(html);
}).listen(Number(process.env.SITE_PORT), "127.0.0.1");
' &
site_pid=$!

"$engine" run --detach \
  --name "$container_name" \
  --platform linux/amd64 \
  --network host \
  --shm-size 1g \
  --env "HST_CONTROL_PORT=$control_port" \
  --env "HST_CDP_PORT=$cdp_port" \
  --env "HST_CONTROL_TOKEN=$token" \
  --env "HST_DISPLAY_NUMBER=$control_port" \
  --env "HST_START_URL=http://127.0.0.1:$site_port" \
  "$image" >/dev/null

CONTROL_PORT="$control_port" CDP_PORT="$cdp_port" TOKEN="$token" node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';

const control = `http://127.0.0.1:${process.env.CONTROL_PORT}`;
const headers = { authorization: `Bearer ${process.env.TOKEN}` };
const request = async (path, body) => {
  const response = await fetch(control + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json();
};

const deadline = Date.now() + 60_000;
let health;
while (Date.now() < deadline) {
  try {
    const [candidate, cdp] = await Promise.all([
      request('/v2/health'),
      fetch(`http://127.0.0.1:${process.env.CDP_PORT}/json/version`).then((response) => response.json()),
    ]);
    if (candidate.status === 'ok' && candidate.ready && cdp.webSocketDebuggerUrl) {
      health = candidate;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!health) throw new Error('runtime did not become ready');
if (health.profile !== 'nvda-web-2026.1.1') throw new Error(`wrong profile: ${JSON.stringify(health)}`);

const session = await request('/v2/sessions', { testId: 'container-smoke', recording: true });
let state = await request(`/v2/sessions/${session.id}/state`);
for (let attempt = 0; attempt < 6 && !state.webContentFocused; attempt += 1) {
  await request(`/v2/sessions/${session.id}/actions`, { command: 'returnToPage' });
  state = await request(`/v2/sessions/${session.id}/state`);
}
if (!state.webContentFocused || !state.browserWindowActive) {
  throw new Error(`AT-SPI did not verify web focus: ${JSON.stringify(state)}`);
}
const action = await request(`/v2/sessions/${session.id}/actions`, { command: 'nextHeading' });
const speech = action.events.filter((event) => event.kind === 'speech').map((event) => event.text).join(' ');
if (!speech.includes('HooVDA harness smoke test') || !speech.toLowerCase().includes('heading')) {
  throw new Error(`HooVDA did not announce fixture heading: ${JSON.stringify(action)}`);
}
if (!action.events.some((event) => event.kind === 'audio' && event.audioDurationNs > 0)) {
  throw new Error(`HooVDA did not synthesize heading audio: ${JSON.stringify(action)}`);
}
const finished = await request(`/v2/sessions/${session.id}/finish`, {});
for (const artifact of finished.artifacts) {
  const response = await fetch(`${control}/v2/sessions/${session.id}/artifacts/${artifact.name}`, { headers });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok || body.length !== artifact.bytes || createHash('sha256').update(body).digest('hex') !== artifact.sha256) {
    throw new Error(`artifact verification failed: ${artifact.name}`);
  }
}
if (!finished.artifacts.some((item) => item.name === 'screenreader-video')) {
  throw new Error(`screenreader video missing: ${JSON.stringify(finished)}`);
}
const audioArtifact = finished.artifacts.find((item) => item.name === 'screenreader-audio');
if (!audioArtifact || audioArtifact.bytes <= 10_000) {
  throw new Error(`screenreader audio contains no synthesized PCM: ${JSON.stringify(finished)}`);
}
console.log(JSON.stringify({ health, speech, artifacts: finished.artifacts }, null, 2));
NODE

"$engine" exec "$container_name" bash -ceu '
registry_pid=$(pgrep -x at-spi2-registr)
test "$(readlink "/proc/$registry_pid/exe")" = "/opt/hoovda-runtime/libexec/at-spi2-registryd"
test "$(awk '\''$1 == "Version:" { print $2 }'\'' /opt/hoovda-runtime/lib/x86_64-linux-gnu/pkgconfig/atspi-2.pc)" = "2.60.1"
test "$(espeak-ng --version 2>&1 | awk '\''NR == 1 { print $4 }'\'')" = "1.52.0"
test "$(lou_translate --version 2>&1 | awk '\''NR == 1 { print $3 }'\'')" = "3.38.0"
'

"$engine" exec "$container_name" pkill -KILL -x hoovda
for _attempt in $(seq 1 100); do
  running=$("$engine" inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  if [[ "$running" != "true" ]]; then
    echo "Runtime supervisor stopped container after HooVDA exited"
    exit 0
  fi
  sleep 0.05
done

"$engine" logs --tail 100 "$container_name" >&2 || true
echo "Runtime container stayed alive after HooVDA exited" >&2
exit 1
