import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recoveryIdentity, urls, verifyPublic } from '../verify-npm-recovery-015.mjs';

const repo = 'openhoo/hoosaidthat', web = 'https://github.com/' + repo;
const env = {GITHUB_SERVER_URL:'https://github.com', GITHUB_REPOSITORY:repo, GITHUB_REPOSITORY_ID:'1348829510',
  GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_WORKFLOW_REF:repo + '/.github/workflows/release.yml@refs/heads/main',
  GITHUB_REF:'refs/heads/main', GITHUB_SHA:'a'.repeat(40), GITHUB_WORKFLOW_SHA:'a'.repeat(40),
  EXPECTED_RECOVERY_COMMIT:'a'.repeat(40), GITHUB_RUN_ID:'45820000000', GITHUB_RUN_ATTEMPT:'1'};
const identity = recoveryIdentity(env), bytes = Buffer.from('fixture original package');
const hash = (alg, format='hex') => createHash(alg).update(bytes).digest(format);
const slsa = 'https://slsa.dev/provenance/v1';
const pkg = '@openhoo/hoosaidthat', ver = '0.1.5';

function fixture() {
  const meta = {name:pkg,version:ver,dist:{tarball:urls.tgz,integrity:'sha512-' + hash('sha512','base64'),
    shasum:hash('sha1'), attestations:{url:urls.att,provenance:{predicateType:slsa}}}};
  const statement = {_type:'https://in-toto.io/Statement/v1', subject:[{name:'pkg:npm/%40openhoo/hoosaidthat@0.1.5',digest:{sha512:hash('sha512')}}], predicateType:slsa,
    predicate:{buildDefinition:{buildType:'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      internalParameters:{github:{event_name:'workflow_dispatch',repository_id:'1348829510'}},
      externalParameters:{workflow:{ref:'refs/heads/main',repository:web,path:'.github/workflows/release.yml'}},
      resolvedDependencies:[{uri:'git+' + web + '@refs/heads/main',digest:{gitCommit:env.GITHUB_SHA}}]},
    runDetails:{builder:{id:'https://github.com/actions/runner/github-hosted'},metadata:{invocationId:identity.invocation}}}};
  const f = {meta,statement,tgz:bytes,tags:{latest:'0.1.5'},gets:[],validations:0,waits:0};
  f.run = (opts = {}) => verifyPublic({bytes,identity,wait:async () => {f.waits++;},attempts:3,
    verifyBundle:async (_b,id) => {assert.equal(id,identity);f.validations++;},
    get:async url => {
      f.gets.push(url);
      if (url === urls.tgz) return f.tgz;
      if (url === urls.meta) return Buffer.from(JSON.stringify(f.meta));
      if (url === urls.tags) return Buffer.from(JSON.stringify(f.tags));
      assert.equal(url,urls.att);
      const bundle = {dsseEnvelope:{payloadType:'application/vnd.in-toto+json',payload:Buffer.from(JSON.stringify(f.statement)).toString('base64')}};
      return Buffer.from(JSON.stringify({attestations:[{predicateType:slsa,bundle}]}));
    },...opts});
  return f;
}

test('readback distinguishes the original tested build from this publishing workflow', async () => {
  const f = fixture(); const {receipt} = await f.run();
  assert.equal(receipt.byteForByte,true);
  assert.equal(receipt.original.runId,'45816609095');
  assert.deepEqual(receipt.recovery,identity);
  assert.equal(f.validations,1);assert.equal(f.waits,0);
  assert.deepEqual(f.gets,[urls.meta,urls.tags,urls.tgz,urls.att]);
});

test('read-only registry propagation retries are bounded', async () => {
  const f=fixture(); f.tags.latest='0.1.2';
  await assert.rejects(f.run(),/not advanced/);
  assert.equal(f.waits,2);assert.equal(f.validations,0);assert.equal(f.gets.length,6);
  const done=await f.run({wait:async () => { f.tags.latest=ver; }});
  assert.equal(done.receipt.verified,true);
});

for (const [name,alter,reason] of [
  ['wrong latest',f=>{f.tags.latest='0.2.0';},/latest tag/],
  ['foreign tarball',f=>{f.meta.dist.tarball='https://example.invalid/fake.tgz';},/tarball URL/],
  ['changed public bytes',f=>{f.tgz=Buffer.from('different');},/original qualified bytes/],
  ['tampered SRI',f=>{f.meta.dist.integrity='sha512-wrong';},/checksums/],
  ['foreign attestation',f=>{f.meta.dist.attestations.url='https://example.invalid/provenance';},/provenance link/],
  ['wrong package in signed statement',f=>{f.statement.subject[0].name='pkg:npm/sibling@0.1.5';},/Signed subject/],
  ['wrong signed run attempt',f=>{f.statement.predicate.runDetails.metadata.invocationId=identity.invocation.replace('/attempts/1','/attempts/2');},/recovery invocation/],
  ['claims original build commit instead of publisher commit',f=>{f.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit='b3b177122fef654f2a823a1c5251befd869204c0';},/source commit/],
  ['wrong signed repository',f=>{f.statement.predicate.buildDefinition.externalParameters.workflow.repository=web+'-fork';},/Signed workflow/],
]) {
  test('rejects '+name+' without retry',async()=>{
    const f=fixture();alter(f);await assert.rejects(f.run(),reason);assert.equal(f.waits,0);
  });
}

test('forged and unverifiable envelopes fail, even when signed claims look right',async()=>{
  const f=fixture();
  await assert.rejects(f.run({verifyBundle:async()=>{throw new Error('untrusted signer');}}),/untrusted signer/);
  assert.equal(f.waits,0);
});

test('does not accept original tag, original run, or unrelated workflow context',()=>{
  for (const changes of [{GITHUB_REF:'refs/tags/v0.1.5'},{GITHUB_RUN_ID:'45816609095'},
    {GITHUB_WORKFLOW_REF:repo + '/.github/workflows/fake.yml@refs/heads/main'},
    {GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REPOSITORY_ID:'1'},{GITHUB_RUN_ATTEMPT:'2'},
    {GITHUB_WORKFLOW_SHA:'b'.repeat(40)},{EXPECTED_RECOVERY_COMMIT:'b'.repeat(40)},
    {GITHUB_WORKFLOW_SHA:undefined},{EXPECTED_RECOVERY_COMMIT:undefined}])
    assert.throws(()=>recoveryIdentity({...env,...changes}));
});

test('CLI rejects missing original inputs without creating a passing evidence file',async()=>{
  const d=await mkdtemp(join(tmpdir(),'npm-recovery-verification-test-'));
  try {
    const out=spawnSync(process.execPath,[fileURLToPath(new URL('../verify-npm-recovery-015.mjs',import.meta.url)),join(d,'missing'),join(d,'report')],{env:{...process.env,...env},encoding:'utf8'});
    assert.equal(out.status,1);assert.match(out.stderr,/ENOENT/);
  } finally {await rm(d,{recursive:true,force:true});}
});
