import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceCommit = 'a'.repeat(40);
const companionCommit = 'b'.repeat(40);

function identityScript() {
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const start = workflow.indexOf('      - name: Validate immutable release identity\n');
  assert.ok(start >= 0, 'release identity step exists');
  const end = workflow.indexOf('\n      - name:', start + 1);
  assert.ok(end > start, 'release identity step has a boundary');
  const step = workflow.slice(start, end);
  const run = step.indexOf('        run: |\n');
  assert.ok(run >= 0, 'release identity step contains a Bash script');
  return step.slice(run + '        run: |\n'.length).split('\n').map(line => {
    assert.ok(!line || line.startsWith('          '), 'Bash block retains YAML indentation');
    return line.slice(10);
  }).join('\n');
}

function validateIdentity(ref) {
  const temporary = mkdtempSync(join(tmpdir(), 'hoosaidthat-release-identity-'));
  try {
    const bin = join(temporary, 'bin');
    mkdirSync(bin);
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    // Every case has the same exact tag commit and companion commit. Only the
    // workflow dispatch ref changes; no repository or registry is contacted.
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in
  'rev-parse refs/tags/v0.1.0^{commit}') printf '%s\\n' "$TEST_RELEASE_TAG_COMMIT" ;;
  '-C hoovda rev-parse HEAD') printf '%s\\n' "$TEST_COMPANION_COMMIT" ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
    return spawnSync('bash', ['-c', identityScript()], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        RELEASE_VERSION: '0.1.0',
        GITHUB_SHA: sourceCommit,
        GITHUB_REF: ref,
        HOOVDA_REF: companionCommit,
        TEST_RELEASE_TAG_COMMIT: sourceCommit,
        TEST_COMPANION_COMMIT: companionCommit,
      },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('release identity rejects main dispatch even when the release tag matches the commit', () => {
  const result = validateIdentity('refs/heads/main');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `main must fail before publication: ${result.stderr}`);
});

test('release identity accepts dispatch from the exact release tag', () => {
  const result = validateIdentity('refs/tags/v0.1.0');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
