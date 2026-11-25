import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('../release-index-digest.sh', import.meta.url));
const ref = 'ghcr.io/openhoo/hoosaidthat-orca:0.1.2';
const index = JSON.stringify({ schemaVersion: 2, annotations: { description: 'x'.repeat(131072) } }) + '\n';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function verify(bytes, expected, code = 0) {
  const temp = mkdtempSync(join(tmpdir(), 'release-index-'));
  try {
    writeFileSync(join(temp, 'index'), bytes);
    writeFileSync(join(temp, 'docker'), `#!/bin/sh
[ "$#" = 5 ] && [ "$1 $2 $3 $4" = 'buildx imagetools inspect --raw' ] && [ "$5" = "$REF" ] || exit 64
cat "$INDEX" || exit 1
exit "$STATUS"
`, { mode: 0o755 });
    // The verifier must catch registry failures even if its caller disables pipefail.
    const result = spawnSync('bash', ['-c', 'set +o pipefail; source "$1"; verify_index_digest "$2" "$3"', '_', helper, ref, expected], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: temp + delimiter + process.env.PATH, INDEX: join(temp, 'index'), STATUS: String(code), REF: ref },
    });
    assert.ifError(result.error);
    return result;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test('hashes every raw byte of a large image index, including its final newline', () => {
  assert.equal(verify(index, digest(index)).status, 0);
  const changed = verify(index.trimEnd(), digest(index));
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Wrong image index digest/);
});

test('refuses failed registry reads even if their emitted bytes match the expected digest', () => {
  for (const bytes of ['', index.slice(0, 256), index]) {
    const result = verify(bytes, digest(bytes), 255);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not read and hash/);
  }
});

test('refuses malformed or non-SHA-256 expected digests', () => {
  for (const expected of ['', digest(index).slice(0, -1), 'sha512:' + '0'.repeat(64)]) {
    const result = verify(index, expected);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid expected image index digest/);
  }
});
