#!/usr/bin/env node
// Merge commits may differ while containing the exact pinned engine source.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkCompanion(pin, remote) {
  if (pin.repository !== 'openhoo/hoovda' || !/^[0-9a-f]{40}$/.test(pin.commit)) throw Error('Invalid HooVDA source pin');
  const repo = mkdtempSync(join(tmpdir(), 'hoosaidthat-companion-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '--bare', '--quiet');
    git('fetch', '--quiet', '--no-tags', '--depth=1', '--filter=blob:none', remote,
      'refs/heads/main:refs/heads/upstream', pin.commit + ':refs/heads/pinned');
    const pinnedTree = git('rev-parse', 'pinned^{tree}');
    const upstream = git('rev-parse', 'upstream');
    const upstreamTree = git('rev-parse', 'upstream^{tree}');
    if (upstreamTree !== pinnedTree)
      throw Error(`HooVDA main ${upstream} has a different source tree from pin ${pin.commit}. Review the changes, update images/hoovda/source.json and qualify that pair before publication.`);
    return { repository: pin.repository, pinned: pin.commit, upstream, tree: pinnedTree };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pin = JSON.parse(readFileSync(new URL('../images/hoovda/source.json', import.meta.url), 'utf8'));
    console.log(JSON.stringify(checkCompanion(pin, 'https://github.com/openhoo/hoovda.git')));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
