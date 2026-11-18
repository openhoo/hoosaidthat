import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkCompanion } from '../check-hoovda-source.mjs';

test('the published pin accepts an identical merge tree and stops on new engine code', () => {
  const root = mkdtempSync(join(tmpdir(), 'hoovda-pin-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('commit', '--allow-empty', '-m', 'pin');
    const pin = { repository: 'openhoo/hoovda', commit: git('rev-parse', 'HEAD') };
    git('commit', '--allow-empty', '-m', 'integration with identical bytes');
    const result = checkCompanion(pin, root);
    assert.notEqual(result.upstream, pin.commit);
    assert.equal(result.tree, git('rev-parse', 'HEAD^{tree}'));
    writeFileSync(join(root, 'engine'), 'updated');
    git('add', 'engine');
    git('commit', '-m', 'new engine behavior');
    assert.throws(() => checkCompanion(pin, root), /different source tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
