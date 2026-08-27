from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "control_server.py"
SPEC = importlib.util.spec_from_file_location("hoosaidthat_control_server", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ControlProtocolTests(unittest.TestCase):
    def test_action_catalog_contains_physical_orca_navigation(self) -> None:
        self.assertEqual(MODULE.ACTIONS["nextHeading"][1], "h")
        self.assertEqual(MODULE.ACTIONS["previousHeading"][1], "shift+h")
        self.assertEqual(MODULE.ACTIONS["toggleFocusMode"][1], "Insert+a")
        self.assertEqual(MODULE.ACTIONS["returnToPage"][1], "F6")

    def test_bounded_integer_rejects_missing_and_out_of_range_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing quietMs"):
            MODULE.bounded_integer({}, "quietMs", 1, 5000)
        with self.assertRaisesRegex(ValueError, "outside allowed range"):
            MODULE.bounded_integer({"quietMs": ["0"]}, "quietMs", 1, 5000)
        self.assertEqual(
            MODULE.bounded_integer({"quietMs": ["300"]}, "quietMs", 1, 5000),
            300,
        )

    def test_event_reader_rejects_duplicate_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events_file = Path(directory) / "events.jsonl"
            events_file.write_text(
                '{"sequence":1,"monotonicNs":1,"kind":"speech",'
                '"text":"first","command":"SPEAK"}\n'
                '{"sequence":1,"monotonicNs":2,"kind":"speech",'
                '"text":"duplicate","command":"SPEAK"}\n',
                encoding="utf-8",
            )
            with mock.patch.object(MODULE, "EVENTS_FILE", events_file):
                with self.assertRaisesRegex(RuntimeError, "strictly increasing"):
                    MODULE.read_events()

    def test_event_reader_rejects_non_speech_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events_file = Path(directory) / "events.jsonl"
            events_file.write_text(
                '{"sequence":1,"monotonicNs":1,"kind":"internal",'
                '"text":"bad","command":"bad"}\n',
                encoding="utf-8",
            )
            with mock.patch.object(MODULE, "EVENTS_FILE", events_file):
                with self.assertRaisesRegex(RuntimeError, "invalid speech event payload"):
                    MODULE.read_events()

    def test_action_log_fails_closed_at_size_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            actions_file = Path(directory) / "actions.jsonl"
            with (
                mock.patch.object(MODULE, "ACTIONS_FILE", actions_file),
                mock.patch.object(MODULE, "MAX_ACTION_LOG_BYTES", 1),
            ):
                with self.assertRaisesRegex(RuntimeError, "action log exceeded safety bound"):
                    MODULE.append_action("nextHeading", "h", 0)

    def test_runtime_readiness_requires_every_component(self) -> None:
        ready = {
            "xvfb": True,
            "windowManager": True,
            "screenReader": True,
            "chromium": True,
            "cdp": True,
            "browserAccessibility": True,
            "browserWindowActive": True,
        }
        with mock.patch.object(MODULE, "runtime_components", return_value=ready):
            self.assertEqual(MODULE.runtime_ready(), (True, ready))
        degraded = {**ready, "screenReader": False}
        with mock.patch.object(MODULE, "runtime_components", return_value=degraded):
            self.assertEqual(MODULE.runtime_ready(), (False, degraded))

    def test_browser_chrome_focus_overrides_stale_document_focus(self) -> None:
        result = {"webContentFocused": False, "role": None, "name": None}
        MODULE.apply_focused_nodes(
            result,
            [("document web", "Checkout")],
            [("entry", "Address and search bar")],
        )
        self.assertFalse(result["webContentFocused"])
        self.assertEqual(result["role"], "entry")

        MODULE.apply_focused_nodes(result, [("document web", "Checkout")], [])
        self.assertTrue(result["webContentFocused"])
        self.assertEqual(result["role"], "document web")


if __name__ == "__main__":
    unittest.main()
