#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invocationRoot = process.cwd();
const require = createRequire(import.meta.url);
const playwrightCLI = require.resolve('@playwright/test/cli');

const locale = process.argv[2] ?? 'en-US';
const keyboardLayout = process.argv[3] ?? 'desktop';
const selectedShard = process.argv[4] ?? 'all';
if (locale !== 'en-US' && locale !== 'de-DE') {
  throw new Error('locale must be en-US or de-DE');
}
if (keyboardLayout !== 'desktop' && keyboardLayout !== 'laptop') {
  throw new Error('keyboard layout must be desktop or laptop');
}

const coverage = JSON.parse(
  readFileSync(join(projectRoot, 'oracle', 'parity', 'coverage.json'), 'utf8'),
);
const actions = Object.values(coverage.scenarios).flat();
if (
  actions.length !== 190 ||
  actions.some((action) => typeof action !== 'string') ||
  new Set(actions).size !== actions.length
) {
  throw new Error('HooVDA parity coverage must contain exactly 190 unique actions');
}

const shards = chunk(actions, 24);
const labels = new Set([
  'all',
  'core',
  'settings',
  ...shards.map((_, index) => `actions-${index + 1}`),
]);
if (!labels.has(selectedShard)) {
  throw new Error(`shard must be one of ${[...labels].join(', ')}`);
}
if (selectedShard === 'all' || selectedShard === 'core') {
  run('core', { HOOSAIDTHAT_NVDA_PARITY_CORE: '1' });
}
for (let index = 0; index < shards.length; index += 1) {
  const label = `actions-${index + 1}`;
  if (selectedShard !== 'all' && selectedShard !== label) continue;
  run(label, {
    HOOSAIDTHAT_NVDA_PARITY_ACTIONS: shards[index].join(','),
  });
}
if (selectedShard === 'all' || selectedShard === 'settings') {
  run('settings', { HOOSAIDTHAT_NVDA_PARITY_SETTINGS: '1' });
}

console.log(
  selectedShard === 'all'
    ? `HooVDA ${locale}/${keyboardLayout} complete 190-action parity cell passed.`
    : `HooVDA ${locale}/${keyboardLayout}/${selectedShard} passed.`,
);

function run(label, specializedEnvironment) {
  const output = join(
    invocationRoot,
    'test-results',
    `hoovda-${locale}-${keyboardLayout}-parity`,
    label,
  );
  console.log(`HooVDA parity ${locale}/${keyboardLayout}/${label}`);
  const result = spawnSync(
    process.execPath,
    [
      playwrightCLI,
      'test',
      '--config',
      join(projectRoot, 'oracle', 'parity', 'playwright.config.ts'),
      '--output',
      output,
    ],
    {
      cwd: invocationRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        HOOSAIDTHAT_PARITY_ADAPTER: 'hoovda',
        SCREEN_READER_IMAGE: process.env.SCREEN_READER_IMAGE ?? 'hoosaidthat-hoovda:dev',
        SCREEN_READER_LOCALE: locale,
        SCREEN_READER_KEYBOARD_LAYOUT: keyboardLayout,
        HOOSAIDTHAT_NVDA_PARITY_ACTIONS: '',
        HOOSAIDTHAT_NVDA_PARITY_CORE: '',
        HOOSAIDTHAT_NVDA_PARITY_SETTINGS: '',
        HOOSAIDTHAT_NVDA_PARITY_ARTIFACTS: '',
        ...specializedEnvironment,
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`HooVDA parity failed for ${locale}/${keyboardLayout}/${label}`);
  }
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
