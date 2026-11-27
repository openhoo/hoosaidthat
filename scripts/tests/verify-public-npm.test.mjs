import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readPublishedPackage } from '../verify-public-npm.mjs';

const pkg = { name: '@openhoo/hoosaidthat', version: '0.1.6-rc.1', shasum: '1'.repeat(40),
  integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64') };
const receipt = { status: 'published', package: pkg };
const attestation = { url: 'https://registry.npmjs.org/-/npm/v1/attestations/@openhoo%2fhoosaidthat@' + pkg.version,
  provenance: { predicateType: 'https://slsa.dev/provenance/v1' } };
const meta = { name: pkg.name, version: pkg.version, dist: { shasum: pkg.shasum, integrity: pkg.integrity, attestations: attestation } };
function simulate(reply) {
  const state = { at: 0, attempts: [], waits: [], log: [] };
  const run = () => readPublishedPackage(receipt, {
    now: () => state.at, wait: async ms => { state.waits.push(ms); state.at += ms; },
    log: value => state.log.push(value), request: async (url, init) => {
      assert.equal(url, 'https://registry.npmjs.org/@openhoo%2fhoosaidthat/0.1.6-rc.1');
      assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
      assert.deepEqual(init.headers, { Accept: 'application/json' });
      state.attempts.push(state.at);
      return reply(state);
    },
  });
  return { state, run };
}
test('an accepted publish can stay absent longer than a minute, then verify without publishing again', async () => {
  const { state, run } = simulate(({ at, attempts }) => {
    if (attempts.length === 1) throw Object.assign(new TypeError('PRIVATE'), { cause: { code: 'ECONNRESET' } });
    if (at < 100_000) return new Response('PRIVATE', { status: attempts.length === 2 ? 503 : 404 });
    if (at < 200_000) return Response.json({ ...meta, dist: { ...meta.dist, attestations: undefined } });
    return Response.json(meta);
  });
  assert.equal((await run()).registryVerified, true);
  assert.deepEqual(state.waits, [5000,10000,20000,40000,60000,60000,60000]);
  assert.ok(state.log.every(line => !line.includes('PRIVATE')));
});
test('a 404 never issues a read after the 18 minute deadline, and leaves the accepted receipt intact', async () => {
  const { state, run } = simulate(() => new Response(null, { status: 404 }));
  await assert.rejects(run(), /18 minutes/);
  assert.equal(state.at, 18 * 60_000);
  assert.ok(state.attempts.at(-1) < state.at);
  assert.equal(receipt.registryVerified, undefined);
});
test('integrity conflicts, bad provenance, denied reads, redirects, malformed output and TLS errors stop immediately', async () => {
  for (const response of [
    () => Response.json({ ...meta, name: 'other' }),
    () => Response.json({ ...meta, dist: { ...meta.dist, integrity: 'wrong', attestations: undefined } }),
    () => Response.json({ ...meta, dist: { ...meta.dist, attestations: { url: 'https://private.example' } } }),
    () => Response.json({ ...meta, dist: { ...meta.dist, attestations: { ...attestation, provenance: {predicateType: 'wrong'} } } }),
    () => new Response('PRIVATE', { status: 401 }), () => new Response('PRIVATE', { status: 403 }),
    () => new Response('PRIVATE', { status: 302 }), () => new Response('PRIVATE', { status: 200 }),
    () => { throw Object.assign(new TypeError('PRIVATE'), { cause: { code: 'CERT_HAS_EXPIRED' } }); },
  ]) {
    const { state, run } = simulate(response);
    await assert.rejects(run(), error => !error.message.includes('PRIVATE'));
    assert.deepEqual(state.attempts, [0]); assert.deepEqual(state.waits, []);
  }
});
