import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { checkReport, lanes, reportViewerPaths, runLane, validateInputs } from '../qualify-runtime.mjs';

const env = {RUNTIME_SOURCE: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '87', GITHUB_RUN_ATTEMPT: '2',
  HOOVDA_CANDIDATE: 'ghcr.io/openhoo/hoosaidthat-hoovda@sha256:' + '1'.repeat(64),
  ORCA_CANDIDATE: 'ghcr.io/openhoo/hoosaidthat-orca@sha256:' + '2'.repeat(64)};

test('old serial release qualification is covered once in independent lanes', () => {
  const expected = [];
  for (const locale of ['en-US','de-DE']) for (const layout of ['desktop','laptop']) {
    for (const block of ['core', ...Array.from({length:8}, (_,i) => 'actions-' + (i+1)), 'settings'])
      expected.push(['hoovda','parity',locale,layout,block].join('/'));
    expected.push(['hoovda',locale === 'en-US' && layout === 'desktop' ? 'examples' : 'details',locale,layout].join('/'));
  }
  expected.push('hoovda/doctor','hoovda/smoke','orca/smoke','orca/examples/en-US/desktop',
                'hoovda/report','hoovda/viewer','none/session','none/edges');
  assert.deepEqual(lanes.flatMap(l => l.checks.map(c => [l.reader,c.type,c.locale,c.layout,c.block].filter(Boolean).join('/'))).sort(),
                   expected.sort());
  const result = spawnSync(process.execPath, [new URL('../qualify-runtime.mjs', import.meta.url).pathname, 'plan'],
    {encoding:'utf8', env:{...process.env, ...env}});
  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(result.stdout);
  assert.equal(matrix.include.length, 14);
  assert.equal(new Set(matrix.include.map(l => l.id)).size, 14);
});

test('requires both immutable and correctly named GHCR inputs before scheduling sharded work', () => {
  validateInputs(env);
  for (const delta of [{HOOVDA_CANDIDATE:'ghcr.io/openhoo/hoosaidthat-hoovda:v0.1.1'},
                       {ORCA_CANDIDATE: env.HOOVDA_CANDIDATE}, {RUNTIME_SOURCE:'abc'}]) {
    assert.throws(() => validateInputs({...env,...delta}));
  }
});

test('evidence retains the first failed block and cannot claim success after a partial run', () => {
  const tmp = mkdtempSync(join(tmpdir(),'qualify-hst-'));
  const before = process.cwd();
  try {
    process.chdir(tmp);
    const seen = [];
    assert.throws(() => runLane('parity-de-DE-desktop-b', env, (_lane, task) => {
      seen.push(task.block);
      if (seen.length === 2) throw Error('native test failed');
      return {passed:2};
    }), /native test failed/);
    const receipt = JSON.parse(readFileSync('test-results/qualification.json','utf8'));
    assert.deepEqual([receipt.state, receipt.completed.length, seen.length], ['failed',1,2]);
    assert.equal(receipt.expected[receipt.completed.length].block, seen[1]);
    assert.equal(receipt.source, env.RUNTIME_SOURCE);
    assert.equal(receipt.workflowCommit, env.GITHUB_SHA);
    const viewerRoot = resolve('viewer');
    mkdirSync(viewerRoot);
    assert.throws(() => reportViewerPaths(viewerRoot), /No actual/);
    mkdirSync(join(viewerRoot,'case','screenreader'), {recursive:true});
    writeFileSync(join(viewerRoot,'case','screenreader','screen-reader-report.html'), 'html');
    assert.equal(reportViewerPaths(viewerRoot).length, 1);
  } finally { process.chdir(before); rmSync(tmp, {recursive:true, force:true}); }
});

test('require actual passing tests, zero retries and matching per-test and aggregate results', () => {
  const fixture = {config:{workers:1,projects:[{retries:0}]},errors:[],
    suites:[{suites:[{specs:[{tests:[{expectedStatus:'passed',results:[{status:'passed',retry:0,errors:[]}]}]}]}]}],
    stats:{expected:1,skipped:0,flaky:0,unexpected:0}};
  assert.deepEqual(checkReport(fixture,1), {passed:1,skipped:0});
  assert.throws(() => checkReport(fixture,2), /without retries/);
  for (const modify of [r => r.config.workers++, r => r.config.projects[0].retries++,
    r => r.stats.expected++, r => r.suites[0].suites[0].specs[0].tests[0].results[0].retry++]) {
    const report = structuredClone(fixture); modify(report);
    assert.throws(() => checkReport(report,1));
  }
});
