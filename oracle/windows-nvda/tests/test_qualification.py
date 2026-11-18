import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).resolve().parents[1] / 'qualification.py')
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


class Qualification(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for sub in ['state', 'shared', 'qualification']:
            (self.root / sub).mkdir()
        (self.root / 'state/data.img').write_bytes(b'retained fixture')
        self.c = dict(runtime=str(self.root), source=str(self.root), candidate='a' * 40,
                      node='/usr/bin/node', container='b' * 64)

    def inspect(self, mount=None, state='exited', code=0):
        return '\n'.join([self.c['container'], '/' + q.NAME, state, str(code), json.dumps([
            {'Destination': '/storage', 'Type': 'bind', 'Source': str(mount or self.root/'state')},
            {'Destination': '/shared', 'Type': 'bind', 'Source': str(self.root/'shared')}])])

    def test_replacement_disk_and_foreign_mount_are_rejected(self):
        with patch.object(q, 'checked', return_value=self.inspect()):
            owner, _, _ = q.identity(self.c)
            (self.root/'state/data.img').rename(self.root/'state/original.img')
            (self.root/'state/data.img').write_bytes(b'replacement')
            with self.assertRaisesRegex(RuntimeError, 'disk identity'):
                q.identity(self.c, owner)
        with patch.object(q, 'checked', return_value=self.inspect(self.root/'shared')):
            with self.assertRaisesRegex(RuntimeError, 'mount differs'):
                q.identity(self.c)

    def test_competing_attempt_is_retained_without_touching_the_owner(self):
        root = self.root / 'qualification'
        q.write_json(root/'current.json', {'attempt': 'owner'})
        with q.lease(root/'oracle.lock'), patch.object(q, 'checked', side_effect=AssertionError), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(q.run(self.c, 'loser', None), 1)
        self.assertEqual(json.loads((root/'current.json').read_text())['attempt'], 'owner')
        self.assertIn('another qualification', q.status(self.c, 'loser')['failure'])
        with self.assertRaises(FileExistsError):
            q.run(self.c, 'loser', None)

    def test_wrong_order_does_not_count_and_replay_never_completes_matrix(self):
        r = self.root/'blocks.jsonl'
        events = [dict(locale='de-DE', layout='laptop', block='actions-08', state=s) for s in ['running','passed']]
        r.write_text(''.join(json.dumps(e)+'\n' for e in events) + '{"unfinished"')
        replay = q.progress(self.root, ['de-DE','laptop','actions-08'])
        self.assertEqual((replay['passedBlocks'], replay['totalBlocks']), (1,1))
        with self.assertRaisesRegex(ValueError, 'sequence'):
            q.progress(self.root, None)

    def test_locked_guest_records_sign_in_and_shuts_down_without_a_test(self):
        owner = {'container': self.c['container']}
        calls = []
        def cli(args, **kwargs):
            calls.append(args[2:])
            return q.subprocess.CompletedProcess(args, 78 if args[2:] == ['wait'] else 0)
        with (patch.object(q, 'source', return_value={'hoovda': 'c' * 40}),
              patch.object(q.subprocess, 'check_output', return_value=json.dumps(
                  {'pinned': 'c' * 40, 'upstream': 'd' * 40, 'tree': 'e' * 40})),
              patch.object(q, 'identity', return_value=(owner, 'exited', 0)),
              patch.object(q, 'checked') as engine, patch.object(q.subprocess, 'run', cli),
              patch.object(q, 'poweroff', return_value='guest SSH') as shutdown,
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(q.run(self.c, 'locked', None), 1)
        self.assertEqual(calls, [['doctor'], ['wait']])
        engine.assert_called_once_with(['podman', 'start', owner['container']])
        shutdown.assert_called_once()
        r = q.status(self.c, 'locked')
        self.assertEqual((r['failureCode'], r['failurePhase'], r['testResult'], r['passedBlocks'], r['shutdown']),
                         ('guest-sign-in-required', 'readiness', 'not run', 0, 'confirmed'))

    def test_recovery_does_not_interrupt_a_live_or_newer_owner(self):
        root = self.root/'qualification'
        q.write_json(root/'current.json', {'attempt': 'newer'})
        with self.assertRaisesRegex(RuntimeError, 'different attempt'):
            q.recover(self.c, 'old')
        with q.lease(root/'oracle.lock'), self.assertRaisesRegex(RuntimeError, 'another qualification'):
            q.recover(self.c, 'newer')

    def test_acpi_requires_transport_failure_and_observed_clean_exit(self):
        owner = {'container': self.c['container']}
        def disconnected(args, file):
            self.assertEqual(args, ['control','shutdown'])
            print('Connection reset by peer', file=file)
            return 1
        with patch.object(q, 'identity', side_effect=[(owner,'running',0),(owner,'running',0),(owner,'exited',0)]), patch.object(q,'checked') as command:
            self.assertEqual(q.poweroff(self.c, owner, disconnected, self.root/'run.log'), 'ACPI power button')
            self.assertEqual(command.call_args.args[0][:3], ['podman','exec',self.c['container']])
            self.assertIn('system_powerdown', command.call_args.args[0][-1])
        with patch.object(q, 'identity', side_effect=[(owner,'running',0),(owner,'running',0),(owner,'exited',143)]), patch.object(q,'checked'), self.assertRaisesRegex(RuntimeError,'unconfirmed'):
            q.poweroff(self.c, owner, disconnected, self.root/'run.log')
        def untrusted(_, file):
            print('Host key verification failed', file=file)
            return 1
        with patch.object(q, 'identity', return_value=(owner,'running',0)), patch.object(q,'checked', side_effect=AssertionError), self.assertRaisesRegex(RuntimeError, 'guest shutdown failed'):
            q.poweroff(self.c, owner, untrusted, self.root/'run.log')
