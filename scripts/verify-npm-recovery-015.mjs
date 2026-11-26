// Public npm verification for the original 0.1.5 bytes published by the recovery workflow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const NAME = '@openhoo/hoosaidthat', VERSION = '0.1.5', REPO = 'openhoo/hoosaidthat';
const WEB = 'https://github.com/' + REPO, WORKFLOW = '.github/workflows/release.yml', REF = 'refs/heads/main';
const ORIGINAL = 'b3b177122fef654f2a823a1c5251befd869204c0', RUN = '45816609095';
const PACKAGE_SHA = 'b249b33dfb7d46fb6d625d6697e35e8fe32f0da77dbcb84fe36c7af36d2a0c74';
const MANIFEST_SHA = '30232f9155ad071453191ce2674f5a82c0309142625068df664e5ae1ffa4f3d4';
const REG = 'https://registry.npmjs.org', ENCODED = '@openhoo%2fhoosaidthat';
export const urls = {
  meta: REG + '/' + ENCODED + '/' + VERSION,
  tags: REG + '/-/package/' + ENCODED + '/dist-tags',
  tgz: REG + '/' + NAME + '/-/hoosaidthat-' + VERSION + '.tgz',
  att: REG + '/-/npm/v1/attestations/' + ENCODED + '@' + VERSION,
};
const SLSA = 'https://slsa.dev/provenance/v1', INTOTO = 'application/vnd.in-toto+json';
const hash = (bytes, algorithm = 'sha256', format = 'hex') => createHash(algorithm).update(bytes).digest(format);
const json = bytes => JSON.parse(bytes.toString('utf8'));
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const require = createRequire(import.meta.url);

export function recoveryIdentity(env) {
  check(env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_REPOSITORY === REPO &&
    env.GITHUB_REPOSITORY_ID === '1348829510' && env.GITHUB_REF === REF &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_WORKFLOW_REF === REPO + '/' + WORKFLOW + '@' + REF,
  'Expected a main-branch dispatch of the recovery release workflow');
  check(/^[1-9]\d{0,18}$/.test(env.GITHUB_RUN_ID ?? '') && env.GITHUB_RUN_ID !== RUN &&
    env.GITHUB_RUN_ATTEMPT === '1' && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') &&
    env.GITHUB_SHA !== ORIGINAL && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA &&
    env.EXPECTED_RECOVERY_COMMIT === env.GITHUB_SHA,
  'Invalid recovery run, attempt, or commit');
  return { workflow: WEB + '/' + WORKFLOW + '@' + REF, commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    invocation: WEB + '/actions/runs/' + env.GITHUB_RUN_ID + '/attempts/' + env.GITHUB_RUN_ATTEMPT };
}

async function originalInputs(dir) {
  const [bytes, manifest, qualification] = await Promise.all(['package.tgz','release-candidates.json','qualification.json'].map(f => readFile(join(dir, f))));
  const q = json(qualification), m = json(manifest);
  check(bytes.length === 326975 && hash(bytes) === PACKAGE_SHA && hash(manifest) === MANIFEST_SHA &&
    q.candidateManifestSha256 === MANIFEST_SHA && m.sourceCommit === ORIGINAL && m.run.id === RUN && m.run.attempt === '1' &&
    q.sourceCommit === ORIGINAL && q.repository === REPO && q.sourceRef === 'refs/tags/v0.1.5' &&
    q.workflow === WORKFLOW && q.runId === Number(RUN) && q.runAttempt === 1 && q.inputArtifactId === 15117230053 &&
    q.package.name === NAME && q.package.version === VERSION && q.package.size === bytes.length &&
    q.package.sha256 === PACKAGE_SHA && q.package.integrity === 'sha512-' + hash(bytes, 'sha512', 'base64'),
  'Original build manifest, package or qualification differs');
  return bytes;
}

class Propagating extends Error {}
async function anonymousGet(url) {
  // Every request has a fixed public registry URL; never follow a metadata-controlled redirect.
  check(Object.values(urls).includes(url), 'Unexpected npm registry URL');
  const limit = url === urls.tgz ? 326975 : 2 * 1024 * 1024;
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(15000), headers: { Accept: url === urls.tgz ? 'application/octet-stream' : 'application/json' } });
  } catch { throw new Propagating('Anonymous registry request did not finish'); }
  if (!res.ok) {
    await res.body?.cancel();
    if ([404, 408, 425, 429, 500, 502, 503, 504].includes(res.status)) throw new Propagating('Registry returned ' + res.status);
    throw new Error('Unexpected registry status: ' + res.status);
  }
  let count = 0;
  const parts = [];
  for await (const part of res.body) {
    count += part.byteLength;
    check(count <= limit, 'Public registry response exceeds size limit');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export function verifyStatement(bundle, identity, bytes) {
  const env = bundle.dsseEnvelope;
  check(env?.payloadType === INTOTO && typeof env.payload === 'string', 'Missing signed in-toto envelope');
  const raw = Buffer.from(env.payload, 'base64');
  check(raw.toString('base64') === env.payload, 'Invalid signed in-toto payload encoding');
  const stmt = json(raw), b = stmt.predicate?.buildDefinition, run = stmt.predicate?.runDetails;
  check(stmt._type === 'https://in-toto.io/Statement/v1' && stmt.predicateType === SLSA &&
    b?.buildType === 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1' &&
    b.internalParameters?.github?.event_name === 'workflow_dispatch' &&
    b.internalParameters.github.repository_id === '1348829510' &&
    run?.builder?.id === 'https://github.com/actions/runner/github-hosted' &&
    run.metadata?.invocationId === identity.invocation,
  'Signed statement does not identify this GitHub-hosted recovery invocation');
  assert.deepEqual(stmt.subject, [{ name: 'pkg:npm/%40openhoo/hoosaidthat@0.1.5', digest: { sha512: hash(bytes, 'sha512') } }], 'Signed subject differs from the public package bytes');
  assert.deepEqual(b.externalParameters.workflow, { ref: REF, repository: WEB, path: WORKFLOW }, 'Signed workflow differs');
  assert.deepEqual(b.resolvedDependencies, [{ uri: 'git+' + WEB + '@' + REF, digest: { gitCommit: identity.commit } }], 'Signed workflow source commit differs');
}

// Fulcio v2 OID values contain a DER UTF8String. These two GitHub values are short ASCII strings.
function derUTF8(value) {
  const data = Buffer.from(value, 'utf8');
  check(data.length < 128, 'Unexpected certificate policy length');
  return Buffer.concat([Buffer.from([0x0c, data.length]), data]);
}

export async function verifySigstore(bundle, identity, cache) {
  const npmDir = join(execFileSync('npm', ['root','-g'], {encoding:'utf8', timeout:15000}).trim(), 'npm');
  check(require(join(npmDir, 'package.json')).version === '11.20.0', 'npm 11.20.0 is required for Sigstore verification');
  const sigstore = require(join(npmDir, 'node_modules', 'sigstore'));
  // The bundled verifier treats its SAN policy as a regex. Anchor and escape the entire identity.
  const literal = identity.workflow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const verifier = await sigstore.createVerifier({certificateIdentityURI:'^' + literal + '$',
    certificateIssuer:'https://token.actions.githubusercontent.com', ctLogThreshold:1, tlogThreshold:1,
    certificateOIDs:{'1.3.6.1.4.1.57264.1.13':derUTF8(identity.commit), '1.3.6.1.4.1.57264.1.21':derUTF8(identity.invocation)},
    tufCachePath:cache, timeout:15000, retry:1});
  await verifier.verify(bundle);
}

export async function verifyPublic({bytes, identity, get = anonymousGet, verifyBundle, wait = sleep, attempts = 12}) {
  const integrity = 'sha512-' + hash(bytes, 'sha512', 'base64');
  for (let n = 1; n <= attempts; n++) {
    try {
      const meta = json(await get(urls.meta)), tags = json(await get(urls.tags));
      check(meta.name === NAME && meta.version === VERSION && meta.dist?.tarball === urls.tgz, 'Public version or tarball URL differs');
      if (tags.latest === '0.1.2') throw new Propagating('npm latest has not advanced');
      check(tags.latest === VERSION, 'Unexpected npm latest tag');
      check(meta.dist.integrity === integrity && meta.dist.shasum === hash(bytes, 'sha1'), 'Public npm checksums differ');
      check(bytes.equals(await get(urls.tgz)), 'Public npm tarball differs from the original qualified bytes');
      if (!meta.dist.attestations) throw new Propagating('Public attestation metadata is not available yet');
      check(meta.dist.attestations.url === urls.att && meta.dist.attestations.provenance?.predicateType === SLSA,
        'Public npm provenance link or predicate differs');
      const data = json(await get(urls.att));
      check(Array.isArray(data.attestations), 'Invalid npm attestations response');
      const matches = data.attestations.filter(x => x.predicateType === SLSA);
      if (!matches.length) throw new Propagating('Public provenance bundle is not available yet');
      check(matches.length === 1 && matches[0].bundle, 'Expected exactly one npm provenance bundle');
      const bundle = matches[0].bundle;
      await verifyBundle(bundle, identity);
      verifyStatement(bundle, identity, bytes);
      return {bundle, receipt:{verified:true, package:NAME, version:VERSION, latest:tags.latest,
        tarball:urls.tgz, byteForByte:true, sha256:hash(bytes), integrity, size:bytes.length, anonymous:true,
        original:{commit:ORIGINAL, runId:RUN, runAttempt:'1', manifestSha256:MANIFEST_SHA},
        recovery:identity, certificateIssuer:'https://token.actions.githubusercontent.com', observedAt:new Date().toISOString()}};
    } catch (err) {
      if (!(err instanceof Propagating) || n === attempts) throw err;
      await wait(5000);
    }
  }
}

async function main([dir, evidence]) {
  check(process.argv.length === 4, 'Usage: node scripts/verify-npm-recovery-015.mjs ORIGINAL_BUNDLE_DIR RECOVERY_EVIDENCE_DIR');
  const identity = recoveryIdentity(process.env), bytes = await originalInputs(dir);
  const cache = await mkdtemp(join(tmpdir(), 'hst-recovery-tuf-'));
  try {
    const {bundle, receipt} = await verifyPublic({bytes, identity, verifyBundle:(b,i) => verifySigstore(b,i,cache)});
    await mkdir(evidence, {recursive:true, mode:0o700});
    const save = (file, data) => writeFile(join(evidence,file), JSON.stringify(data,null,2) + '\n', {flag:'wx',mode:0o600});
    await save('npm-sigstore-bundle.json',bundle);
    await save('public-readback.json',receipt);
    console.log('Verified the public npm 0.1.5 tarball and recovery workflow provenance.');
  } finally { await rm(cache, {recursive:true, force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(err => {console.error(err.message.split('\n')[0]); process.exitCode = 1;});
}
