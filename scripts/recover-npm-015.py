#!/usr/bin/env python3
"""Read-only gates for publishing the original, qualified HooSaidThat 0.1.5 tarball."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

REPO = 'openhoo/hoosaidthat'
REPO_ID = 1348829510
RUN = 45816609095
URL = f'https://github.com/{REPO}/actions/runs/{RUN}'
WORKFLOW = 344133380
VERSION = '0.1.5'
BASE = '96adeb876f5dc94877de2b2f12cc2aaace49c1f3'
CI_WORKFLOW = 344133379
CI_JOBS = {'windows-ssh-configuration', 'talkback-apks', 'orca-image', 'hoovda-image',
           'package (1.62.1)', 'package (1.63.0)', 'package (1.64.1)'}
TAG = 'v0.1.5'
TAG_OBJECT = 'e1d2b2eec5b3841297b18b09b3fdf6615c78a784'
HEAD = 'b3b177122fef654f2a823a1c5251befd869204c0'
TREE = '4e2aa39a38ca3e1fed8c199f3b72616c3c59c31f'
ENGINE = '71cae236a506d598c201f15da4d8e7aa118a8ca1'
ENGINE_TREE = 'eb5bd1487eebe1ead34a041628a11b407a1ad3db'
PACKAGE = '@openhoo/hoosaidthat'
PACKAGE_SIZE = 326975
PACKAGE_SHA = 'b249b33dfb7d46fb6d625d6697e35e8fe32f0da77dbcb84fe36c7af36d2a0c74'
SRI = 'sha512-k49g81xRZs1x2rKKA9IUuuFBi+M/cof7PQSLjie/soh8uRLLYFWWSRoybA77RkcEYLm3Z9LS9PprLSlHgBjIJA=='
ARTIFACT = 15117230053
ZIP_SIZE = 327590
ZIP_SHA = '52dc7f8721dbef86c00518db93b1c6f32e42fe6acdb9e6cc31ff68769e95e9dd'
MANIFEST_SHA = '30232f9155ad071453191ce2674f5a82c0309142625068df664e5ae1ffa4f3d4'
IMAGES = {
    'engine': ('hoosaidthat-hoovda-engine', 'sha256:c96b7c9238ce7b61340c372d193bf17cc60bf8877a97ae4ef4607544d63884a3'),
    'hoovda': ('hoosaidthat-hoovda', 'sha256:c61b3ce2e7fc576db45b500b33984d2dc4a616da0a68f010514245a3076f3d47'),
    'orca': ('hoosaidthat-orca', 'sha256:770fd875aa03fc1f43e2ea021074c5b5ae26f29bf49d069e8355a1475deafaaa'),
}
LANES = {'hoovda-probe', 'hoovda-examples', 'hoovda-localized', 'orca-examples', 'web-report', 'browser-tools'} | {
    f'parity-{locale}-{layout}-{part}' for locale in ('en-US', 'de-DE')
    for layout in ('laptop', 'desktop') for part in ('a', 'b')
}
NPM = 'https://registry.npmjs.org/@openhoo%2fhoosaidthat'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, data):
    with path.open('xb') as out:
        out.write(data)


def gh(path, repository=REPO):
    return subprocess.check_output(['gh', 'api', '--method', 'GET', '--hostname', 'github.com',
                                    f'repos/{repository}/{path}'], timeout=90)


def api(path, repository=REPO):
    return json.loads(gh(path, repository))


def match(actual, **expected):
    for key, value in expected.items():
        require(actual.get(key) == value, f'Unexpected or missing {key}: expected {value}')


def dispatch(env, checked_out):
    """Bind this invocation to the operator-reviewed merge, its signed source and green CI."""
    workflow = '.github/workflows/release.yml'
    ref = 'refs/heads/main'
    head = env.get('EXPECTED_RECOVERY_COMMIT', '')
    require(re.fullmatch('[0-9a-f]{40}', head) and head not in (BASE, HEAD), 'Expected reviewed recovery merge SHA')
    match(env, GITHUB_ACTIONS='true', GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY=REPO,
          GITHUB_REPOSITORY_ID=str(REPO_ID), GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF=ref,
          GITHUB_WORKFLOW_REF=f'{REPO}/{workflow}@{ref}', GITHUB_WORKFLOW_SHA=head, GITHUB_SHA=head,
          GITHUB_RUN_ATTEMPT='1', CONFIRM_RELEASE='true', REHEARSAL_CANDIDATE='',
          RELEASE_VERSION=VERSION, HOOVDA_REF=ENGINE, EXPECTED_PACKAGE_SHA256=PACKAGE_SHA,
          NPM_PUBLISH_MODE='recover-npm-0.1.5')
    require(checked_out == head, 'Checked out a different recovery commit')
    rid = env.get('GITHUB_RUN_ID', '')
    require(re.fullmatch('[1-9][0-9]*', rid) and int(rid) != RUN, 'Expected a new recovery run')
    run = api('actions/runs/' + rid)
    match(run, id=int(rid), run_attempt=1, workflow_id=WORKFLOW, path=workflow, event='workflow_dispatch',
          head_branch='main', head_sha=head, html_url=f'https://github.com/{REPO}/actions/runs/{rid}',
          status='in_progress')
    for key in ('repository', 'head_repository'):
        match(run[key], id=REPO_ID, full_name=REPO)
    match(api('git/ref/heads/main')['object'], type='commit', sha=head)
    merge = api('git/commits/' + head)
    match(merge, sha=head)
    match(merge['verification'], verified=True, reason='valid')
    parents = [p['sha'] for p in merge['parents']]
    require(len(parents) == 2 and parents[0] == BASE, 'Recovery must be a merge onto the original release main')
    source = api('git/commits/' + parents[1])
    match(source, sha=parents[1])
    match(source['verification'], verified=True, reason='valid')
    require([p['sha'] for p in source['parents']] == [BASE] and
            source['tree']['sha'] == merge['tree']['sha'], 'Merge tree or signed recovery parent differs')
    ci = api(f'actions/workflows/ci.yml/runs?event=push&branch=main&head_sha={head}&per_page=100')
    require(ci['total_count'] == len(ci['workflow_runs']) == 1, 'Expected one main push CI run for the reviewed merge')
    ci = ci['workflow_runs'][0]
    match(ci, workflow_id=CI_WORKFLOW, path='.github/workflows/ci.yml', event='push', head_branch='main',
          head_sha=head, status='completed', conclusion='success')
    for key in ('repository', 'head_repository'):
        match(ci[key], id=REPO_ID, full_name=REPO)
    results = api(f"actions/runs/{ci['id']}/attempts/{ci['run_attempt']}/jobs?per_page=100")
    require(results['total_count'] == len(results['jobs']) == len(CI_JOBS) and
            {j['name'] for j in results['jobs']} == CI_JOBS, 'Main CI coverage differs')
    for job in results['jobs']:
        match(job, head_sha=head, run_id=ci['id'], run_attempt=ci['run_attempt'],
              status='completed', conclusion='success')
    return {'workflowRef': env['GITHUB_WORKFLOW_REF'], 'sourceRef': ref, 'recoveryCommit': head,
            'recoveryTree': merge['tree']['sha'], 'reviewedParent': parents[1], 'baseCommit': BASE,
            'runId': int(rid), 'runAttempt': 1, 'runUrl': run['html_url'],
            'ciRunId': ci['id'], 'ciRunAttempt': ci['run_attempt'], 'ciJobs': sorted(CI_JOBS)}


def verify_jobs(response):
    runtime = {'qualify / Runtime / ' + name for name in LANES}
    statuses = {name: 'success' for name in runtime | {'qualify / plan', 'build'}}
    statuses.update({'publish': 'failure', 'rehearse': 'skipped', 'rehearsal-inputs': 'skipped',
                     'missing-rehearsal-candidate': 'skipped'})
    jobs = response['jobs']
    require(len(jobs) == response['total_count'] == len(statuses) and
            {j['name'] for j in jobs} == statuses.keys(), 'Original job inventory differs')
    for j in jobs:
        name = j['name']
        match(j, run_id=RUN, run_attempt=1, head_sha=HEAD, head_branch=TAG,
              status='completed', conclusion=statuses[name], workflow_name='Release')
        steps = {s['name']: s['conclusion'] for s in j['steps']}
        if name in runtime:
            match(steps, **{'Run this lane with one reader at a time': 'success',
                            "Preserve this lane's receipts and raw test evidence": 'success'})
        if name == 'build':
            match(j, id=139897866829)
            match(steps, **{'Pack tested npm files': 'success', 'Build attested release candidates': 'success',
                            'Store immutable publication inputs': 'success'})
        elif name == 'publish':
            match(j, id=139907473922)
            match(steps, **{'Verify publication inputs': 'success', 'Require unused publication destinations': 'success',
                            'Promote qualified image manifests': 'success',
                            'Publish npm package from GitHub Actions with provenance': 'failure',
                            'Verify public npm integrity and provenance': 'skipped'})
            require([s['name'] for s in j['steps'] if s['conclusion'] == 'failure'] ==
                    ['Publish npm package from GitHub Actions with provenance'], 'Unexpected original failure')
    return {j['name']: {'id': j['id'], 'conclusion': j['conclusion']} for j in jobs}


def original():
    run = api(f'actions/runs/{RUN}')
    match(run, id=RUN, run_attempt=1, workflow_id=WORKFLOW, event='workflow_dispatch',
          path='.github/workflows/release.yml', head_branch=TAG, head_sha=HEAD, html_url=URL,
          status='completed', conclusion='failure')
    for key in ('repository', 'head_repository'):
        match(run[key], id=REPO_ID, full_name=REPO)
    match(api('git/ref/tags/' + TAG)['object'], type='tag', sha=TAG_OBJECT)
    tag = api('git/tags/' + TAG_OBJECT)
    match(tag, sha=TAG_OBJECT, tag=TAG)
    match(tag['object'], type='commit', sha=HEAD)
    match(tag['verification'], verified=True, reason='valid')
    commit = api('git/commits/' + HEAD)
    match(commit, sha=HEAD)
    match(commit['verification'], verified=True, reason='valid')
    match(commit['tree'], sha=TREE)
    engine = api('git/commits/' + ENGINE, 'openhoo/hoovda')
    match(engine, sha=ENGINE)
    match(engine['tree'], sha=ENGINE_TREE)
    return verify_jobs(api(f'actions/runs/{RUN}/attempts/1/jobs?per_page=100'))


def bundle(raw):
    require(len(raw) == ZIP_SIZE and sha(raw) == ZIP_SHA, 'Original artifact bytes differ')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        require(sorted(z.namelist()) == ['package.tgz', 'release-candidates.json'], 'Unexpected ZIP members')
        require(all(stat.S_ISREG(i.external_attr >> 16) and 0 < i.file_size <= PACKAGE_SIZE
                    for i in z.infolist()), 'Unsafe ZIP member')
        package, manifest = z.read('package.tgz'), z.read('release-candidates.json')
    require(len(package) == PACKAGE_SIZE and sha(package) == PACKAGE_SHA and
            'sha512-' + base64.b64encode(hashlib.sha512(package).digest()).decode() == SRI, 'Unqualified npm tarball')
    with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as t:
        files = t.getmembers()
        require(len(files) == len({f.name for f in files}) == 169 and all(
            f.isfile() and f.name.startswith('package/') and not {'', '.', '..'}.intersection(f.name.split('/'))
            and f.mode in (0o644, 0o755) for f in files), 'Unexpected npm contents or permissions')
        pkg = json.load(t.extractfile('package/package.json'))
        match(pkg, name=PACKAGE, version=VERSION)
        match(pkg['repository'], type='git', url=f'git+https://github.com/{REPO}.git')
        match(json.load(t.extractfile('package/images/hoovda/source.json')), repository='openhoo/hoovda', commit=ENGINE)
    require(sha(manifest) == MANIFEST_SHA, 'Different original candidate manifest')
    m = json.loads(manifest)
    match(m, schemaVersion=1, repository=REPO, sourceRef='refs/tags/' + TAG, sourceCommit=HEAD,
          companionRepository='openhoo/hoovda', companionCommit=ENGINE, version=VERSION,
          run={'id': str(RUN), 'attempt': '1', 'url': URL})
    expected = []
    for name, (repo, digest) in IMAGES.items():
        image = 'ghcr.io/openhoo/' + repo
        expected.append({'name': name, 'candidateTag': f'{image}:candidate-{HEAD}-{RUN}-1',
                         'reference': f'{image}@{digest}', 'digest': digest, 'versionTag': f'{image}:{VERSION}'})
    require(m['images'] == expected, 'Candidate image identities differ')
    return package, manifest


def prepare(out):
    require(not out.exists(), 'Choose a new recovery directory')
    jobs = original()
    pin = api(f'actions/artifacts/{ARTIFACT}')
    match(pin, id=ARTIFACT, name=f'release-inputs-{RUN}-1', expired=False,
          size_in_bytes=ZIP_SIZE, digest='sha256:' + ZIP_SHA)
    match(pin['workflow_run'], id=RUN, head_sha=HEAD, head_branch=TAG,
          repository_id=REPO_ID, head_repository_id=REPO_ID)
    package, manifest = bundle(gh(f'actions/artifacts/{ARTIFACT}/zip'))
    q = {'repository': REPO, 'sourceRef': 'refs/tags/' + TAG, 'sourceCommit': HEAD, 'sourceTree': TREE,
         'tagObject': TAG_OBJECT, 'companionCommit': ENGINE, 'companionTree': ENGINE_TREE,
         'workflow': '.github/workflows/release.yml', 'workflowId': WORKFLOW, 'runId': RUN,
         'runAttempt': 1, 'runUrl': URL, 'jobs': jobs, 'inputArtifactId': ARTIFACT,
         'inputArtifactSha256': ZIP_SHA, 'candidateManifestSha256': MANIFEST_SHA,
         'package': {'name': PACKAGE, 'version': VERSION, 'sha256': PACKAGE_SHA,
                     'integrity': SRI, 'size': PACKAGE_SIZE}}
    out.mkdir(mode=0o700)
    for name, data in [('package.tgz', package), ('release-candidates.json', manifest),
                       ('qualification.json', (json.dumps(q, indent=2) + '\n').encode())]:
        write(out / name, data)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def read(url, headers=None):
    # Do not forward anonymous OCI bearer tokens across a redirect.
    try:
        response = build_opener(NoRedirect()).open(Request(url, headers=headers or {}), timeout=25)
    except HTTPError as exc:
        response = exc
    with response as r:
        data = r.read(4 * 1024 * 1024 + 1)
        require(len(data) <= 4 * 1024 * 1024, 'Registry response too large')
        return r.status, r.headers, data


def destinations():
    code, _, raw = read(NPM)
    require(code == 200, 'Cannot confirm public package state')
    meta = json.loads(raw)
    match(meta, name=PACKAGE)
    require(isinstance(meta['versions'], dict) and VERSION not in meta['versions'] and
            meta['dist-tags']['latest'] == '0.1.2', 'Package version exists or npm latest changed')
    code, _, raw = read(NPM + '/' + VERSION)
    require(code == 404 and json.loads(raw) == 'version not found: ' + VERSION, 'Missing npm version not confirmed')
    observed = {}
    for name, (short, expected) in IMAGES.items():
        repo = 'openhoo/' + short
        query = urlencode({'service': 'ghcr.io', 'scope': f'repository:{repo}:pull'})
        code, _, raw = read('https://ghcr.io/token?' + query)
        require(code == 200, 'Anonymous GHCR pull authorization failed')
        token = json.loads(raw)['token']
        require(isinstance(token, str) and token, 'Missing anonymous GHCR pull token')
        media = 'application/vnd.oci.image.index.v1+json'
        code, headers, raw = read(f'https://ghcr.io/v2/{repo}/manifests/{VERSION}',
                                  {'Authorization': 'Bearer ' + token, 'Accept': media})
        require(code == 200 and headers.get('Docker-Content-Digest') == 'sha256:' + sha(raw) == expected and
                json.loads(raw)['mediaType'] == media, f'Public {name} version tag differs from the qualified OCI index')
        observed[name] = expected
    return {'missingNpmVersion': VERSION, 'previousLatest': '0.1.2', 'publicImageIndexes': observed}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['dispatch', 'prepare', 'destinations'])
    parser.add_argument('path', type=Path, help='new bundle directory or new JSON receipt')
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.path)
    else:
        data = destinations() if args.action == 'destinations' else dispatch(
            os.environ, subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip())
        write(args.path, (json.dumps(data, indent=2) + '\n').encode())
