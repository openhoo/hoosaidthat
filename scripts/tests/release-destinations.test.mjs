import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const block = workflow.match(/<<'GUARDS'\n([\s\S]*?)\n          GUARDS/);
assert.ok(block, 'workflow contains publication destination guards');
const script = block[1].split('\n').map(line => line.slice(10)).join('\n');

function requireUnused({ mode = 'trusted', publicResult = { error: { code: 'E404' } },
  publicStatus = 1, stages = [], stageStatus = 0 } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'hoosaidthat-release-destinations-'));
  try {
    const bin = join(temporary, 'bin');
    mkdirSync(bin);
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: '@openhoo/hoosaidthat' }));
    writeFileSync(join(bin, 'npm'), `#!/bin/sh
case "$1" in
  view) printf '%s\\n' "$PUBLIC_RESULT"; exit "$PUBLIC_STATUS" ;;
  stage) printf 'stage\\n' >> "$STAGE_CALLS"; printf '%s\\n' "$STAGE_RESULT"; exit "$STAGE_STATUS" ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
    const stageCalls = join(temporary, 'stage-calls');
    writeFileSync(stageCalls, '');
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${script}\nrequire_unused_npm_version`], {
      cwd: temporary, encoding: 'utf8', timeout: 5000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        RELEASE_VERSION: '0.1.0', NPM_PUBLISH_MODE: mode,
        PUBLIC_RESULT: JSON.stringify(publicResult), PUBLIC_STATUS: String(publicStatus),
        STAGE_RESULT: JSON.stringify(stages), STAGE_STATUS: String(stageStatus), STAGE_CALLS: stageCalls,
      },
    });
    assert.equal(result.error, undefined);
    return { ...result, stageCalls: readFileSync(stageCalls, 'utf8') };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('OIDC accepts explicit public absence without calling unsupported stage operations', () => {
  const result = requireUnused();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stageCalls, '');
});

test('both modes refuse an existing public npm version', () => {
  for (const mode of ['trusted', 'bootstrap-stage']) {
    const result = requireUnused({ mode, publicStatus: 0, publicResult: '0.1.0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.equal(result.stageCalls, '');
  }
});

test('network, authentication, and malformed public responses never count as absence', () => {
  for (const publicResult of [{ error: { code: 'E401' } }, { error: { code: 'ECONNRESET' } }, [], null]) {
    const result = requireUnused({ publicResult });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot prove/);
  }
});

test('bootstrap additionally checks staged versions and refuses collisions and invalid responses', () => {
  assert.equal(requireUnused({ mode: 'bootstrap-stage' }).status, 0);
  assert.equal(requireUnused({ mode: 'bootstrap-stage', stageStatus: 1, stages: { error: { code: 'E404' } } }).status, 0);
  for (const stages of [
    [{ packageName: '@openhoo/hoosaidthat', version: '0.1.0' }],
    [{ packageName: 'other', version: '0.2.0' }], {}, null,
  ]) {
    const result = requireUnused({ mode: 'bootstrap-stage', stages });
    assert.notEqual(result.status, 0);
    assert.equal(result.stageCalls, 'stage\n');
  }
  const unauthenticated = requireUnused({ mode: 'bootstrap-stage', stageStatus: 1, stages: { error: { code: 'E401' } } });
  assert.notEqual(unauthenticated.status, 0);
  assert.match(unauthenticated.stderr, /Cannot prove/);
});
