import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createNpmReceipt(raw, identity) {
  const { name, version, mode, tag } = identity;
  if (!['trusted', 'bootstrap-stage'].includes(mode)) {
    throw new Error('Unknown npm publishing mode');
  }
  if (tag !== (version.includes('-') ? 'next' : 'latest')) {
    throw new Error('npm dist-tag does not match the release version');
  }
  const item = raw?.[name];
  if (!item || item.name !== name || item.version !== version ||
      item.id !== `${name}@${version}` ||
      typeof item.shasum !== 'string' || !/^[0-9a-f]{40}$/.test(item.shasum) ||
      typeof item.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity)) {
    throw new Error('npm publication receipt does not match the release identity');
  }
  const staged = mode === 'bootstrap-stage';
  if (staged ? typeof item.stageId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.stageId)
    : item.stageId !== undefined) {
    throw new Error('npm publication receipt does not match the publishing mode');
  }
  const receipt = {
    schemaVersion: 1,
    status: staged ? 'staged' : 'published',
    repository: identity.repository,
    sourceRef: identity.sourceRef,
    sourceCommit: identity.sourceCommit,
    companionCommit: identity.companionCommit,
    run: { id: identity.runId, attempt: identity.runAttempt },
    provenanceRequested: true,
    package: { id: item.id, name, version, tag, shasum: item.shasum, integrity: item.integrity },
  };
  if (staged) receipt.package.stageId = item.stageId;
  for (const key of ['size', 'unpackedSize', 'entryCount']) {
    if (!Number.isSafeInteger(item[key]) || item[key] < 0) {
      throw new Error(`npm publication receipt has invalid ${key}`);
    }
    receipt.package[key] = item[key];
  }
  return receipt;
}

export function verifyNpmPublication(receipt, metadata) {
  const { package: pkg } = receipt;
  const provenance = metadata?.dist?.attestations;
  const packagePath = encodeURIComponent(pkg.name).replaceAll('%40', '@').replaceAll('%2F', '%2f');
  const expectedUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${packagePath}@${encodeURIComponent(pkg.version)}`;
  if (receipt.status !== 'published' || metadata?.name !== pkg.name ||
      metadata?.version !== pkg.version || metadata?.dist?.shasum !== pkg.shasum ||
      metadata?.dist?.integrity !== pkg.integrity ||
      provenance?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1' ||
      provenance?.url !== expectedUrl) {
    throw new Error('Public npm package integrity/provenance does not match the release receipt');
  }
  return { ...receipt, registryVerified: true, provenanceUrl: expectedUrl };
}

function main() {
  const [command, input, output] = process.argv.slice(2);
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  let receipt;
  let destination;
  if (command === 'create' && input && output) {
    const { name } = read('package.json');
    receipt = createNpmReceipt(read(input), {
      name,
      version: process.env.RELEASE_VERSION,
      mode: process.env.NPM_PUBLISH_MODE,
      tag: process.env.NPM_RELEASE_TAG,
      repository: process.env.GITHUB_REPOSITORY,
      sourceRef: process.env.GITHUB_REF,
      sourceCommit: process.env.GITHUB_SHA,
      companionCommit: process.env.HOOVDA_REF,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    destination = output;
  } else if (command === 'verify' && input && output) {
    receipt = verifyNpmPublication(read(input), read(output));
    destination = input;
  } else {
    throw new Error('Usage: release-receipt.mjs create <npm-json> <receipt> | verify <receipt> <registry-json>');
  }
  writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
