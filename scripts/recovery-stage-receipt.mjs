import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNpmReceipt } from './release-receipt.mjs';

const [response, bundle, output] = process.argv.slice(2);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const source = read(join(bundle, 'release-candidates.json'));
const archive = readFileSync(join(bundle, 'package.tgz'));
const env = process.env;
if (env.GITHUB_REPOSITORY !== 'openhoo/hoosaidthat' || env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) || !/^\d+$/.test(env.GITHUB_RUN_ID) ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT) ||
    env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/.github/workflows/recover-voiceover-012.yml@${env.GITHUB_REF}` ||
    source.sourceRef !== 'refs/tags/v0.1.2' || source.sourceCommit !== 'ae089e7fe0e42f924fb03e8137453d925e850ed6' ||
    source.run.id !== '45571274296' || source.run.attempt !== '1') throw Error('Unexpected release identity');
const receipt = createNpmReceipt(read(response), {
  name: '@openhoo/hoosaidthat', version: '0.1.2', mode: 'bootstrap-stage', tag: 'latest',
  repository: source.repository, sourceRef: source.sourceRef, sourceCommit: source.sourceCommit,
  companionCommit: source.companionCommit, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
});
if (receipt.package.integrity !== 'sha512-' + createHash('sha512').update(archive).digest('base64') ||
    receipt.package.shasum !== createHash('sha1').update(archive).digest('hex') ||
    receipt.package.size !== archive.length) throw Error('npm staging response disagrees with the original archive');
receipt.buildRun = {id: source.run.id, attempt: source.run.attempt};
receipt.originalArtifact = {id: 15002926098, digest: 'sha256:76de96ac76fa667d57da3963fe36a0da8dd6e4b4ed253e133b61c9ee34067e81'};
receipt.publishingWorkflow = {path: '.github/workflows/recover-voiceover-012.yml', ref: env.GITHUB_REF, commit: env.GITHUB_SHA};
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
