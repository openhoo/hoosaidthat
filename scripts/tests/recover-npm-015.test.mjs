import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('original input, main dispatch and registry destination gates', () => {
  const file = fileURLToPath(new URL('./recover-npm-015_test.py', import.meta.url));
  const run = spawnSync('python3', [file], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
});

test('npm-only dispatch cannot take the ordinary image publication or rehearsal paths', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(yaml, /  build:\n    if: inputs[.]confirm_release && inputs[.]npm_publish_mode != 'recover-npm-0.1.5'/);
  for (const job of ['missing-rehearsal-candidate', 'rehearsal-inputs']) {
    assert.ok(yaml.includes(`  ${job}:\n    if: "inputs.npm_publish_mode != 'recover-npm-0.1.5' && !inputs.confirm_release`));
  }
  assert.ok(yaml.includes('  qualify:\n    needs: build'));
  assert.ok(yaml.includes('  publish:\n    needs: [build, qualify]'));
  const recovery = yaml.slice(yaml.indexOf('  recover-npm-015:'));
  const gate = recovery.slice(0, recovery.indexOf('    runs-on:'));
  for (const predicate of ["inputs.npm_publish_mode == 'recover-npm-0.1.5'", 'inputs.confirm_release',
    "github.repository == 'openhoo/hoosaidthat'", "github.ref == 'refs/heads/main'",
    'github.sha == inputs.expected_recovery_commit', 'github.run_attempt == 1']) assert.ok(gate.includes(predicate), predicate);
  assert.ok(yaml.includes("needs.recover-npm-015.result == 'skipped'"));

  assert.match(recovery, /contents: read\n      actions: read\n      id-token: write/);
  assert.doesNotMatch(recovery, /packages: write|NPM_TOKEN|NODE_AUTH_TOKEN|npm stage|npm pack\b|docker |npm ci/);
  assert.equal(recovery.match(/\bnpm publish /g)?.length, 1);
  const order = ['recover-npm-015.py dispatch', 'recover-npm-015.py prepare', 'recover-npm-015.py destinations',
    'verify_package_sha256 ', 'npm publish "$RUNNER_TEMP/original/package.tgz" --fetch-retries=0',
    'node scripts/verify-npm-recovery-015.mjs', 'actions/upload-artifact@'];
  let prior = -1;
  for (const step of order) {
    const at = recovery.indexOf(step);
    assert.ok(at > prior, step);
    prior = at;
  }
});
