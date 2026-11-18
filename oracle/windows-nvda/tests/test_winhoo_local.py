"""Guard the native guest qualification evidence imported onto the Mac."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
spec = importlib.util.spec_from_file_location('winhoo_local',ROOT/'winhoo-local.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
import winhoo_bundle


class GuestRunnerTests(unittest.TestCase):
    def test_locked_guest_packages_match_development_lock(self):
        lock = json.loads((ROOT.parents[1]/'package-lock.json').read_text())['packages']
        for name, pin in winhoo_bundle.TOOLS['packages'].items():
            self.assertEqual(pin,{k:lock['node_modules/'+name][k] for k in ('version','resolved','integrity')})

    def test_wrong_tool_bytes_are_retained_without_a_download(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(winhoo_bundle.subprocess,'run') as download:
            cache=Path(d); (cache/'node.exe').write_bytes(b'other')
            with self.assertRaisesRegex(ValueError,'digest mismatch'):
                winhoo_bundle.fetch(cache,'node.exe','https://example.invalid/node.exe',hashlib.sha256(b'right').hexdigest())
            self.assertEqual((cache/'node.exe').read_bytes(),b'other')
            download.assert_not_called()

    def test_selected_block_requires_its_report_and_cannot_be_replayed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); (root/'reports').mkdir()
            block={'locale':'en-US','layout':'desktop','block':'core'}
            records=[{**block,'state':'running'},{**block,'state':'passed','selected':4}]
            path=root/'blocks.jsonl'; text=''.join(json.dumps(r)+'\n' for r in records); path.write_text(text)
            report=root/'reports/en-US-desktop-core.json'
            with self.assertRaises(FileNotFoundError): runner.evidence(root,'core')
            stats={'expected':4,'flaky':0,'unexpected':0}
            report.write_text(json.dumps({'stats':stats}))
            self.assertEqual(runner.evidence(root,'core'),1)
            report.write_text(json.dumps({'stats':{**stats,'flaky':1}}))
            with self.assertRaisesRegex(RuntimeError,'disagree'): runner.evidence(root,'core')
            path.write_text(text+text)
            with self.assertRaisesRegex(RuntimeError,'repeated'): runner.evidence(root,'core')
