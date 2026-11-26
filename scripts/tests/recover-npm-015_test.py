import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'recover-npm-015.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.head = 'a' * 40
        src, tree = 'b' * 40, 'c' * 40
        repo = {'id': r.REPO_ID, 'full_name': r.REPO}
        invocation = {'id': 123, 'run_attempt': 1, 'workflow_id': r.WORKFLOW, 'event': 'workflow_dispatch',
                      'path': '.github/workflows/release.yml', 'head_branch': 'main', 'head_sha': self.head,
                      'html_url': 'https://github.com/openhoo/hoosaidthat/actions/runs/123', 'status': 'in_progress',
                      'repository': repo, 'head_repository': repo}
        def commit(sha, parents):
            return {'sha': sha, 'parents': [{'sha': x} for x in parents], 'tree': {'sha': tree},
                    'verification': {'verified': True, 'reason': 'valid'}}
        ci = {**invocation, 'id': 42, 'event': 'push', 'path': '.github/workflows/ci.yml',
              'workflow_id': r.CI_WORKFLOW, 'status': 'completed', 'conclusion': 'success'}
        self.ci_path = f'actions/workflows/ci.yml/runs?event=push&branch=main&head_sha={self.head}&per_page=100'
        self.jobs_path = 'actions/runs/42/attempts/1/jobs?per_page=100'
        self.api = {'actions/runs/123': invocation, 'git/ref/heads/main': {'object': {'sha': self.head, 'type': 'commit'}},
                    'git/commits/' + self.head: commit(self.head, [r.BASE, src]), 'git/commits/' + src: commit(src, [r.BASE]),
                    self.ci_path: {'total_count': 1, 'workflow_runs': [ci]},
                    self.jobs_path: {'total_count': 7, 'jobs': [{'name': name, 'run_attempt': 1, 'run_id': 42,
                        'head_sha': self.head, 'status': 'completed', 'conclusion': 'success'} for name in r.CI_JOBS]}}
        self.env = {'GITHUB_ACTIONS': 'true', 'GITHUB_SERVER_URL': 'https://github.com',
                    'GITHUB_REPOSITORY': r.REPO, 'GITHUB_REPOSITORY_ID': str(r.REPO_ID),
                    'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                    'GITHUB_WORKFLOW_REF': f'{r.REPO}/.github/workflows/release.yml@refs/heads/main',
                    'GITHUB_WORKFLOW_SHA': self.head, 'GITHUB_SHA': self.head, 'GITHUB_RUN_ID': '123',
                    'GITHUB_RUN_ATTEMPT': '1', 'CONFIRM_RELEASE': 'true', 'REHEARSAL_CANDIDATE': '',
                    'RELEASE_VERSION': r.VERSION, 'HOOVDA_REF': r.ENGINE, 'EXPECTED_PACKAGE_SHA256': r.PACKAGE_SHA,
                    'NPM_PUBLISH_MODE': 'recover-npm-0.1.5', 'EXPECTED_RECOVERY_COMMIT': self.head}

    def test_dispatch_proves_reviewed_merge_and_full_ci(self):
        with patch.object(r, 'api', side_effect=self.api.__getitem__):
            result = r.dispatch(self.env, self.head)
            self.assertEqual(result['reviewedParent'], 'b' * 40)
            self.assertEqual(result['ciRunId'], 42)
            self.assertEqual(len(result['ciJobs']), 7)
            with self.assertRaisesRegex(ValueError, 'different recovery commit'):
                r.dispatch(self.env, 'd' * 40)
            for key, val in [('GITHUB_REF', 'refs/tags/v0.1.5'), ('CONFIRM_RELEASE', 'false'),
                             ('GITHUB_WORKFLOW_SHA', r.HEAD), ('GITHUB_RUN_ATTEMPT', '2'),
                             ('EXPECTED_RECOVERY_COMMIT', r.BASE), ('EXPECTED_PACKAGE_SHA256', 'd' * 64),
                             ('REHEARSAL_CANDIDATE', 'test'), ('HOOVDA_REF', 'f' * 40),
                             ('RELEASE_VERSION', '0.1.6'), ('GITHUB_REPOSITORY', 'other/hoosaidthat')]:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    r.dispatch({**self.env, key: val}, self.head)

    def test_dispatch_rejects_base_signature_tree_main_or_ci_drift(self):
        merge = self.api['git/commits/' + self.head]
        source = self.api['git/commits/' + 'b' * 40]
        ci = self.api[self.ci_path]['workflow_runs'][0]
        jobs = self.api[self.jobs_path]['jobs']
        for desc, obj, key, val in [
                ('main advanced', self.api['git/ref/heads/main']['object'], 'sha', 'd' * 40),
                ('wrong base', merge['parents'][0], 'sha', r.HEAD),
                ('unsigned merge', merge, 'verification', {'verified': False}),
                ('unsigned source', source, 'verification', {'verified': False}),
                ('merge drift', merge['tree'], 'sha', 'd' * 40),
                ('CI for old head', ci, 'head_sha', r.BASE), ('unfinished CI', ci, 'status', 'in_progress'),
                ('incomplete jobs', self.api[self.jobs_path], 'jobs', jobs[:-1]),
                ('skipped job', jobs[0], 'conclusion', 'skipped')]:
            with self.subTest(desc=desc), patch.dict(obj, {key: val}), patch.object(r, 'api', side_effect=self.api.__getitem__):
                with self.assertRaises(ValueError):
                    r.dispatch(self.env, self.head)

    def test_destinations_fail_closed(self):
        media = 'application/vnd.oci.image.index.v1+json'
        body = json.dumps({'mediaType': media}).encode()
        index = 'sha256:' + hashlib.sha256(body).hexdigest()
        images = {name: (slug, index) for name, (slug, _) in r.IMAGES.items()}
        meta = {'name': r.PACKAGE, 'versions': {'0.1.2': {}}, 'dist-tags': {'latest': '0.1.2'}}
        def check(package=meta, missing=404, missing_body=b'"version not found: 0.1.5"',
                  payload=body, header=index):
            def get(url, headers=None):
                if url == r.NPM:
                    return 200, {}, json.dumps(package).encode()
                if url == r.NPM + '/0.1.5':
                    return missing, {}, missing_body
                if url.startswith('https://ghcr.io/token?'):
                    self.assertIn('%3Apull', url)
                    self.assertNotIn('push', url)
                    return 200, {}, b'{"token":"anonymous-pull-only"}'
                self.assertIn(url, [f'https://ghcr.io/v2/openhoo/{slug}/manifests/0.1.5' for slug, _ in images.values()])
                self.assertEqual(headers, {'Authorization': 'Bearer anonymous-pull-only', 'Accept': media})
                return 200, {'Docker-Content-Digest': header}, payload
            with patch.object(r, 'read', side_effect=get), patch.object(r, 'IMAGES', images):
                return r.destinations()
        self.assertEqual(len(check()['publicImageIndexes']), 3)
        for changes in [{'package': {**meta, 'versions': {'0.1.5': {}}}},
                        {'package': {**meta, 'dist-tags': {'latest': '0.2.0'}}},
                        {'missing': 503}, {'missing_body': b'{"error":"Not found"}'},
                        {'payload': b'{}'}, {'header': 'sha256:' + '0' * 64}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                check(**changes)

    def test_replaced_artifact_or_incomplete_original_matrix_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'Original artifact bytes differ'):
            r.bundle(b'injected package')
        with self.assertRaisesRegex(ValueError, 'Original job inventory'):
            r.verify_jobs({'jobs': [], 'total_count': 0})


if __name__ == '__main__':
    unittest.main()
