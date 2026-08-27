from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "sd_capture.py"
SPEC = importlib.util.spec_from_file_location("hoosaidthat_sd_capture", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NormalizeSpeechTests(unittest.TestCase):
    def test_normalizes_well_formed_ssml(self) -> None:
        value = '<speak>Hello <emphasis>screen reader</emphasis>.</speak>'
        self.assertEqual(MODULE.normalize_ssml_text(value), "Hello screen reader.")

    def test_normalizes_malformed_markup(self) -> None:
        self.assertEqual(MODULE.normalize_ssml_text("<speak>A&nbsp; B"), "A B")

    def test_event_sequence_is_monotonic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            capture = MODULE.CaptureModule(path)
            capture.emit("speech", text="Ready", command="SPEAK")
            capture.emit("speech", text="Heading", command="SPEAK")
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertIn('"sequence":1', lines[0])
            self.assertIn('"sequence":2', lines[1])
            self.assertLess(
                json.loads(lines[0])["monotonicNs"],
                2**53,
            )

    def test_sequence_continues_after_module_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            first = MODULE.CaptureModule(path)
            first.emit("speech", text="Ready", command="SPEAK")
            second = MODULE.CaptureModule(path)
            second.emit("speech", text="Heading", command="SPEAK")
            self.assertIn('"sequence":2', path.read_text(encoding="utf-8").splitlines()[1])

    def test_event_log_fails_closed_at_size_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = MODULE.CaptureModule(Path(directory) / "events.jsonl")
            with mock.patch.object(MODULE, "MAX_LOG_BYTES", 1):
                with self.assertRaisesRegex(RuntimeError, "log exceeded safety bound"):
                    capture.emit("speech", text="Ready", command="SPEAK")

    def test_uses_exact_settings_audio_and_loglevel_replies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = MODULE.CaptureModule(Path(directory) / "events.jsonl")
            output = io.StringIO()
            capture.handle("INIT", io.StringIO(), output)
            capture.handle("SET", io.StringIO("rate=50\n.\n"), output)
            capture.handle("AUDIO", io.StringIO("device=none\n.\n"), output)
            capture.handle("LOGLEVEL", io.StringIO("level=3\n.\n"), output)
            transcript = output.getvalue()
            self.assertIn("203 OK SETTINGS RECEIVED\n", transcript)
            self.assertIn("203 OK AUDIO INITIALIZED\n", transcript)
            self.assertIn("203 OK LOG LEVEL SET\n", transcript)
            self.assertEqual(capture.settings["audio:device"], "none")

    def test_rejects_malformed_setting(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = MODULE.CaptureModule(Path(directory) / "events.jsonl")
            output = io.StringIO()
            capture.handle("INIT", io.StringIO(), output)
            with self.assertRaisesRegex(RuntimeError, "name=value"):
                capture.handle("SET", io.StringIO("invalid\n.\n"), output)


if __name__ == "__main__":
    unittest.main()
