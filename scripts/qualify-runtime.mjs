#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const locales = ['en-US', 'de-DE'];
const keyboards = ['desktop', 'laptop'];
const groups = {
  a: ['core', 'actions-2', 'actions-4', 'actions-6', 'actions-8'],
  b: ['actions-1', 'actions-3', 'actions-5', 'actions-7', 'settings'],
};
const cells = locales.flatMap(locale => keyboards.map(layout => ({locale, layout})));

export const lanes = [
  ...cells.flatMap(({locale, layout}) => Object.entries(groups).map(([group, blocks]) => ({
    id: `parity-${locale}-${layout}-${group}`, reader: 'hoovda', browser: 'ffmpeg',
    checks: blocks.map(block => ({type: 'parity', locale, layout, block})),
  }))),
  {id: 'hoovda-probe', reader: 'hoovda', browser: 'none', checks: [{type: 'doctor'}, {type: 'smoke'}]},
  {id: 'hoovda-examples', reader: 'hoovda', browser: 'ffmpeg', checks: [{type: 'examples', ...cells[0]}]},
  {id: 'hoovda-localized', reader: 'hoovda', browser: 'ffmpeg',
    checks: cells.slice(1).map(cell => ({type: 'details', ...cell}))},
  {id: 'orca-examples', reader: 'orca', browser: 'ffmpeg', checks: [{type: 'smoke'}, {type: 'examples', ...cells[0]}]},
  {id: 'web-report', reader: 'hoovda', browser: 'chromium', checks: [{type: 'report'}, {type: 'viewer'}]},
  {id: 'browser-tools', reader: 'none', browser: 'chromium', checks: [{type: 'session'}, {type: 'edges'}]},
];

export function validateInputs(env) {
  for (const reader of ['hoovda', 'orca']) {
    const prefix = `ghcr.io/openhoo/hoosaidthat-${reader}@`;
    const value = env[reader.toUpperCase() + '_CANDIDATE'];
    if (!value?.startsWith(prefix) || !/^sha256:[0-9a-f]{64}$/.test(value.slice(prefix.length)))
      throw Error(`Expected the full ${reader} GHCR manifest digest reference`);
  }
  if (!/^[0-9a-f]{40}$/.test(env.RUNTIME_SOURCE)) throw Error('Expected the full runtime source commit');
}

export function reportViewerPaths(root) {
  const reports = readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name, 'screenreader', 'screen-reader-report.html'))
    .filter(path => existsSync(path));
  if (!reports.length) throw Error('No actual screen-reader HTML reports were generated');
  return reports.sort();
}

export function checkReport(report, minimum) {
  const {stats, config, errors} = report;
  if (errors?.length !== 0 || config?.workers !== 1 || !config.projects?.length ||
      config.projects.some(p => p.retries !== 0) || stats?.flaky !== 0 || stats.unexpected !== 0 ||
      !Number.isInteger(stats.expected) || stats.expected < minimum)
    throw Error('Playwright did not confirm the expected native tests without retries');
  let passed = 0, skipped = 0;
  function suite(s) {
    for (const spec of s.specs ?? []) for (const test of spec.tests) {
      const [result] = test.results;
      if (test.results.length !== 1 || result.retry !== 0 || result.errors.length ||
          result.status !== test.expectedStatus || !['passed','skipped'].includes(result.status))
        throw Error('Playwright reported a missing, failed, retried or unexpected test');
      if (result.status === 'passed') passed++; else skipped++;
    }
    for (const child of s.suites ?? []) suite(child);
  }
  report.suites.forEach(suite);
  if (passed !== stats.expected || skipped !== stats.skipped) throw Error('Individual outcomes disagree with totals');
  return {passed, skipped};
}

function execute(cmd, args, env = {}) {
  const outcome = spawnSync(cmd, args, {stdio: 'inherit', env: {...process.env, ...env}});
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) throw Error(`${cmd} failed (${outcome.signal ?? outcome.status}): ${args.join(' ')}`);
}

function check(lane, task, input) {
  const {type, locale, layout, block} = task;
  const image = input[lane.reader.toUpperCase() + '_CANDIDATE'];
  const env = {CONTAINER_ENGINE: 'docker', ...(image && {SCREEN_READER: lane.reader, SCREEN_READER_IMAGE: image})};
  const node = (script, ...args) => execute(process.execPath, [script, ...args], env);
  const reportFile = label => resolve('test-results', 'reports', label + '.json');
  const readReport = (label, min) => checkReport(JSON.parse(readFileSync(reportFile(label), 'utf8')), min);
  if (type === 'parity') {
    execute(process.execPath, ['scripts/hoovda-parity.mjs', locale, layout, block],
      {...env, HST_PARITY_REPORT_DIR: resolve('test-results/reports')});
    return readReport(block, block === 'core' ? 4 : 2);
  }
  if (type === 'doctor') return node('scripts/hoovda-doctor.mjs', '--runtime', 'docker', '--image', image, '--source', input.RUNTIME_SOURCE);
  if (type === 'smoke') return execute('bash', [`images/${lane.reader}/smoke-test.sh`, image,
    ...(lane.reader === 'orca' ? ['orca'] : [])], env);
  if (type === 'session') return execute('npm', ['run', 'test:session-browser'], env);
  if (type === 'edges') return node('scripts/verify-report-edge-cases.mjs', 'test-results/report-edges');
  if (type === 'viewer') {
    const reports = reportViewerPaths('test-results/report-candidate');
    for (const [i, file] of reports.entries()) node('scripts/verify-web-report.mjs', file, `test-results/report-viewer/${i}`);
    return {reports: reports.length};
  }
  if (['examples', 'details', 'report'].includes(type)) {
    const label = type === 'report' ? 'report-candidate' : `${lane.reader}-${locale}-${layout}`;
    const grep = type === 'details' ? 'matches pinned NVDA aria-details' : type === 'report' ? 'annotated website report' : null;
    execute('node_modules/.bin/playwright', ['test', '--config', 'examples/basic/playwright.config.ts', '--output',
      `test-results/${label}`, '--workers=1', '--retries=0', '--reporter=list,json', ...(grep ? ['--grep', grep] : [])],
    {...env, SCREEN_READER_LOCALE: locale ?? 'en-US', SCREEN_READER_KEYBOARD_LAYOUT: layout ?? 'desktop',
      SCREEN_READER_WEB_REPORT: type === 'report' ? 'on' : 'off', PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile(label)});
    return readReport(label, 1);
  }
  throw Error('Unknown runtime check: ' + type);
}

export function runLane(id, env, runner = check) {
  validateInputs(env);
  const lane = lanes.find(l => l.id === id);
  if (!lane) throw Error('Unknown runtime qualification lane');
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA) || !/^\d+$/.test(env.GITHUB_RUN_ID) || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT))
    throw Error('Expected caller commit, workflow run and attempt');
  mkdirSync('test-results/reports', {recursive: true});
  const data = {schemaVersion: 1, state: 'running', lane: id, source: env.RUNTIME_SOURCE, workflowCommit: env.GITHUB_SHA,
    images: {hoovda: env.HOOVDA_CANDIDATE, orca: env.ORCA_CANDIDATE}, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, expected: lane.checks, completed: []};
  const save = () => writeFileSync('test-results/qualification.json', JSON.stringify(data, null, 2) + '\n');
  save();
  try {
    for (const task of lane.checks) {
      console.log('::group::' + [id, task.type, task.locale, task.layout, task.block].filter(Boolean).join('/'));
      let result;
      try { result = runner(lane, task, env); } finally { console.log('::endgroup::'); }
      data.completed.push({...task, ...(result && {result})});
      save();
    }
    data.state = 'passed';
  } catch (error) {
    data.state = 'failed';
    throw error;
  } finally { save(); }
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    validateInputs(process.env);
    if (process.argv[2] === 'plan') console.log(JSON.stringify({include: lanes.map(({id, reader, browser}) => ({id, reader, browser}))}));
    else if (process.argv[2] === 'run') runLane(process.argv[3], process.env);
    else throw Error('Expected plan or run <lane>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
