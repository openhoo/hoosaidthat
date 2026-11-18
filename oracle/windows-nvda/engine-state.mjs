// A daemon error is never proof that a container or guest has stopped.
import { spawnSync } from 'node:child_process';

const name = 'hoosaidthat-nvda-oracle';
const states = new Set([
  'created',
  'configured',
  'initialized',
  'running',
  'restarting',
  'stopping',
  'paused',
  'exited',
  'stopped',
  'removing',
  'dead',
  'unknown',
]);

function unknown(engine, detail) {
  return Object.assign(new Error(`NVDA container state unknown (${engine}): ${detail}`), {
    code: 'HST_NVDA_ENGINE_UNKNOWN',
  });
}

function probe(engine, args, deadline) {
  const timeout = Math.min(5_000, deadline - Date.now());
  if (timeout <= 0) throw unknown(engine, 'probe deadline expired');
  const r = spawnSync(engine, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 });
  if (r.error || r.status !== 0) {
    const detail = (r.error?.message || r.stderr?.trim() || `exit ${r.status}`).slice(0, 500);
    throw unknown(engine, detail);
  }
  return r.stdout.trim();
}

// A successful list distinguishes an absent container from an unreachable engine in one call.
// The name filter can return substring matches; actions are bound to the exact name and full ID.
export function readOracleContainer(engine, deadline = Infinity) {
  const text = probe(
    engine,
    ['ps', '--all', '--no-trunc', '--filter', `name=${name}`, '--format', '{{.ID}}\t{{.Names}}\t{{.State}}'],
    deadline,
  );
  let exact;
  for (const line of text ? text.split(/\r?\n/) : []) {
    const [id, containerName, state, extra] = line.split('\t');
    if (!/^[a-f0-9]{64}$/.test(id) || !containerName || !states.has(state) || extra !== undefined) {
      throw unknown(engine, 'invalid container list response');
    }
    if (containerName !== name) continue;
    if (exact) throw unknown(engine, 'duplicate oracle in container list');
    exact = { id, state };
  }
  return exact ?? { id: null, state: 'absent' };
}

export function requireRunningOracle(engine, deadline = Infinity, expectedId) {
  const current = readOracleContainer(engine, deadline);
  if (expectedId && current.id !== expectedId) {
    throw unknown(engine, 'owned container identity changed; verify the retained runtime');
  }
  if (current.state !== 'running')
    throw new Error(`NVDA container is ${current.state}; readiness requires a running oracle`);
  return current;
}

// Normal guest states all exit zero, leaving CLI errors (including exit 1) unambiguous.
export function readQemuState(engine, id, deadline = Infinity) {
  const shell =
    'if test -s /run/shm/qemu.pid && kill -0 "$(cat /run/shm/qemu.pid)" 2>/dev/null; then echo running; ' +
    'elif test -f /run/shm/qemu.end; then echo ended; else echo starting; fi';
  const state = probe(engine, ['exec', id, 'sh', '-c', shell], deadline);
  if (!['running', 'ended', 'starting'].includes(state)) throw unknown(engine, 'invalid QEMU state');
  return state;
}
