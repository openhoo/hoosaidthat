import assert from 'node:assert/strict';
import test from 'node:test';
import { createNpmReceipt, verifyNpmPublication } from '../release-receipt.mjs';

const identity = {
  name: '@openhoo/hoosaidthat', version: '0.1.0', mode: 'trusted', tag: 'latest',
  repository: 'openhoo/hoosaidthat', sourceRef: 'refs/tags/v0.1.0',
  sourceCommit: 'a'.repeat(40), companionCommit: 'b'.repeat(40), runId: '123', runAttempt: '1',
};
const item = {
  id: `${identity.name}@${identity.version}`, name: identity.name, version: identity.version,
  shasum: 'c'.repeat(40), integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  size: 100, unpackedSize: 200, entryCount: 3,
};
const raw = overrides => ({ [identity.name]: { ...item, ...overrides } });
const registry = overrides => ({
  name: item.name, version: item.version,
  dist: {
    shasum: item.shasum, integrity: item.integrity,
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@openhoo%2fhoosaidthat@0.1.0',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
    },
    ...overrides,
  },
});

test('direct publication sanitizes npm output and verifies public integrity and provenance', () => {
  const receipt = createNpmReceipt(raw({ token: 'must-not-escape', files: ['private'] }), identity);
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.registryVerified, undefined);
  assert.equal(JSON.stringify(receipt).includes('must-not-escape'), false);
  assert.equal('files' in receipt.package, false);
  const verified = verifyNpmPublication(receipt, registry());
  assert.equal(verified.registryVerified, true);
  assert.equal(verified.provenanceUrl, registry().dist.attestations.url);
});

test('bootstrap receipt preserves the validated stage id and remains explicitly unpublished', () => {
  const stageId = '11111111-2222-3333-4444-555555555555';
  const receipt = createNpmReceipt(raw({ stageId }), { ...identity, mode: 'bootstrap-stage' });
  assert.equal(receipt.status, 'staged');
  assert.equal(receipt.package.stageId, stageId);
  assert.throws(() => verifyNpmPublication(receipt, registry()), /does not match/);
  assert.throws(() => createNpmReceipt(raw(), { ...identity, mode: 'bootstrap-stage' }), /publishing mode/);
  assert.throws(() => createNpmReceipt(raw({ stageId: 'invalid' }), { ...identity, mode: 'bootstrap-stage' }), /publishing mode/);
  assert.throws(() => createNpmReceipt(raw({ stageId }), identity), /publishing mode/);
});

test('publication refuses wrong package, version, checksums, counts, tag, and mode', () => {
  for (const change of [
    { name: 'other' }, { version: '0.2.0' }, { id: 'other@0.1.0' },
    { shasum: 'invalid' }, { integrity: 'sha1-abc' }, { entryCount: -1 }, { size: 1.2 },
  ]) assert.throws(() => createNpmReceipt(raw(change), identity));
  assert.throws(() => createNpmReceipt(raw(), { ...identity, mode: 'unknown' }), /publishing mode/);
  assert.throws(() => createNpmReceipt(raw(), { ...identity, tag: 'next' }), /dist-tag/);
  const prerelease = { ...identity, version: '0.1.0-rc.1', tag: 'next' };
  assert.equal(createNpmReceipt(raw({ version: prerelease.version, id: `${item.name}@${prerelease.version}` }), prerelease).package.tag, 'next');
});

test('registry verification fails closed on absent or different integrity and provenance', () => {
  const receipt = createNpmReceipt(raw(), identity);
  for (const metadata of [
    null, {}, { ...registry(), name: 'other' }, { ...registry(), version: '0.2.0' },
    registry({ shasum: 'd'.repeat(40) }), registry({ integrity: 'sha512-other' }),
    registry({ attestations: undefined }),
    registry({ attestations: { ...registry().dist.attestations, url: 'https://other.example/provenance' } }),
    registry({ attestations: { ...registry().dist.attestations, provenance: { predicateType: 'other' } } }),
  ]) assert.throws(() => verifyNpmPublication(receipt, metadata), /does not match/);
});
