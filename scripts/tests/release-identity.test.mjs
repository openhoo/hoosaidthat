import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceCommit = 'a'.repeat(40);
const companionCommit = 'b'.repeat(40);

const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const hashScript = 'scripts/release-package-sha256.sh';

function workflowScript(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `release step exists: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + 1);
  assert.ok(end > start, `release step has a boundary: ${name}`);
  const step = workflow.slice(start, end);
  const run = step.indexOf('        run: |\n');
  assert.ok(run >= 0, `release step contains a Bash script: ${name}`);
  return step.slice(run + '        run: |\n'.length).split('\n').map(line => {
    assert.ok(!line || line.startsWith('          '), 'Bash block retains YAML indentation');
    return line.slice(10);
  }).join('\n');
}

function validateIdentity(ref, pinnedCompanionCommit = companionCommit, options = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'hoosaidthat-release-identity-'));
  try {
    mkdirSync(join(temporary, 'scripts'));
    copyFileSync(join(root, hashScript), join(temporary, hashScript));
    const bin = join(temporary, 'bin');
    mkdirSync(bin);
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    mkdirSync(join(temporary, 'images/hoovda'), { recursive: true });
    writeFileSync(join(temporary, 'images/hoovda/source.json'), JSON.stringify({ commit: pinnedCompanionCommit }));
    // Every case has the same exact tag commit and companion commit. Only the
    // workflow dispatch ref changes; no repository or registry is contacted.
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in
  'rev-parse refs/tags/v0.1.0^{commit}') printf '%s\\n' "$TEST_RELEASE_TAG_COMMIT" ;;
  '-C hoovda rev-parse HEAD') printf '%s\\n' "$TEST_COMPANION_COMMIT" ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
    return spawnSync('bash', ['-c', workflowScript('Validate immutable release identity')], {
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
        NPM_PUBLISH_MODE: 'trusted',
        EXPECTED_PACKAGE_SHA256: 'a'.repeat(64),
        ...options,
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

test('release identity rejects an engine commit different from the consumer source pin', () => {
  const result = validateIdentity('refs/tags/v0.1.0', 'c'.repeat(40));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
});

test('both publication modes require a bounded lowercase SHA-256 digest', () => {
  for (const mode of ['trusted', 'bootstrap-stage']) {
    for (const [value, accepted] of [
      ['', false], ['a'.repeat(63), false], ['a'.repeat(65), false], ['A'.repeat(64), false],
      ['a'.repeat(64) + '\n' + 'b'.repeat(64), false], ['0123456789abcdef'.repeat(4), true],
    ]) {
      const result = validateIdentity('refs/tags/v0.1.0', companionCommit, {
        NPM_PUBLISH_MODE: mode, EXPECTED_PACKAGE_SHA256: value,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, accepted ? 0 : 1, result.stderr);
      if (!accepted) assert.match(result.stderr, /expected_package_sha256/);
    }
  }
});

test('the release checks the built and downloaded archive against the qualified bytes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'hoosaidthat-release-bytes-'));
  try {
    const source = join(temporary, 'source');
    const temp = join(temporary, 'runner');
    const reference = join(temporary, 'qualified');
    for (const dir of [source, temp, reference, join(source, 'scripts')]) mkdirSync(dir);
    copyFileSync(join(root, hashScript), join(source, hashScript));
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: 'qualified-archive-fixture', version: '1.0.0', files: ['payload.txt'],
    }));
    writeFileSync(join(source, 'payload.txt'), 'guest-tested contents\n');
    // Pack independently before the hosted build. This fixture has no dependencies or scripts.
    const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', reference], {
      cwd: source, encoding: 'utf8',
    });
    assert.equal(packed.status, 0, packed.stderr);
    const qualified = readFileSync(join(reference, JSON.parse(packed.stdout)[0].filename));
    const expected = createHash('sha256').update(qualified).digest('hex');
    const env = {
      ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'outputs'),
      GITHUB_RUN_ATTEMPT: '1', BUILD_ATTEMPT: '1', GITHUB_RUN_ID: '1234', GITHUB_SHA: sourceCommit,
      ENGINE_CANDIDATE: 'engine', HOOVDA_CANDIDATE: 'hoovda', ORCA_CANDIDATE: 'orca',
      EXPECTED_PACKAGE_SHA256: expected,
    };
    const run = (step, overrides = {}) => spawnSync('bash', ['-ec', workflowScript(step)], {
      cwd: source, env: { ...env, ...overrides }, encoding: 'utf8',
    });
    const build = 'Pack tested npm files';
    const publish = 'Verify publication inputs';
    const imagePush = workflow.indexOf('docker buildx build --platform linux/amd64 --push');
    const promotion = workflow.indexOf('docker buildx imagetools create --tag');
    assert.ok(imagePush > workflow.indexOf(`- name: ${build}`));
    assert.ok(promotion > workflow.indexOf(`- name: ${publish}`));
    assert.ok(workflow.indexOf('publish_command=(npm publish)') > promotion);

    let result = run(build);
    assert.equal(result.status, 0, result.stderr);
    const bundle = join(temp, 'bundle');
    const tarball = join(bundle, 'package.tgz');
    assert.deepEqual(readFileSync(tarball), qualified);
    writeFileSync(join(bundle, 'release-candidates.json'), JSON.stringify({
      run: {id: env.GITHUB_RUN_ID, attempt: env.BUILD_ATTEMPT}, sourceCommit,
      images: ['engine', 'hoovda', 'orca'].map(reference => ({reference})),
    }));
    result = run(publish, { TARBALL_SHA512: createHash('sha512').update(qualified).digest('hex') });
    assert.equal(result.status, 0, result.stderr);

    // Even if the per-build SHA-512 matches, a different tarball must never reach promotion.
    const replaced = Buffer.from('different archive');
    writeFileSync(tarball, replaced);
    result = run(publish, { TARBALL_SHA512: createHash('sha512').update(replaced).digest('hex') });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Publication refused/);

    writeFileSync(join(source, 'payload.txt'), 'unqualified contents\n');
    result = run(build);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Publication refused/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
