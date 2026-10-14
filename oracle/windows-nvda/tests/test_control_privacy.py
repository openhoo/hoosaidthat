"""Execute the native capture methods without a Windows/NVDA process.

Only the NVDA imports and plugin registration are omitted. The event buffer,
protection checks, and capture hooks below are compiled from the shipped plugin.
"""

import ast
import base64
import json
from pathlib import Path
from types import SimpleNamespace
import threading
import time
import unittest
from unittest import mock


PLUGIN_PATH = (
    Path(__file__).parents[1]
    / "oem/hoosaidthat/nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py"
)
SENTINEL = "private-regression-sentinel"
CELLS = list(SENTINEL.encode("ascii"))


class COMError(Exception):
    pass


class UnavailableProtection:
    @property
    def isProtected(self):
        raise COMError("native protection observation unavailable")


def load_capture():
    tree = ast.parse(PLUGIN_PATH.read_text(encoding="utf-8"))
    selected = []
    hooks = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "OracleState":
            selected.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in {
            "object_is_protected",
            "current_focus_is_protected",
        }:
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "PROVENANCE_BY_KIND"
            for target in node.targets
        ):
            selected.append(node)
        elif isinstance(node, ast.ClassDef) and node.name == "GlobalPlugin":
            hooks = [
                item
                for item in node.body
                if isinstance(item, ast.FunctionDef)
                and item.name in {
                    "on_speech",
                    "on_braille",
                    "event_gainFocus",
                    "capture_live_region",
                }
            ]
    selected.append(ast.ClassDef(
        name="CaptureHooks", bases=[], keywords=[], body=hooks, decorator_list=[],
    ))
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    namespace = {
        "base64": base64,
        "threading": threading,
        "time": time,
        "MAX_EVENTS": 1000,
        "api": SimpleNamespace(getFocusObject=lambda: SimpleNamespace(isProtected=False)),
        "braille": SimpleNamespace(handler=SimpleNamespace(_cells=CELLS, _cursorPos=1)),
        "log": mock.Mock(),
    }
    exec(compile(module, str(PLUGIN_PATH), "exec"), namespace)
    namespace["STATE"] = namespace["OracleState"]()
    return namespace, namespace["CaptureHooks"]()


class CapturePrivacyTests(unittest.TestCase):
    def setUp(self):
        self.namespace, self.hooks = load_capture()
        self.state = self.namespace["STATE"]

    def focus(self, value):
        self.namespace["api"].getFocusObject = lambda: value

    def capture_speech_and_braille(self):
        self.hooks.on_speech(speechSequence=[SENTINEL])
        self.hooks.on_braille(cells=CELLS, rawText=SENTINEL)

    def assert_suppressed(self, events):
        self.assertTrue(events)
        self.assertNotIn(SENTINEL, json.dumps(events))
        for event in events:
            self.assertIs(event.get("redacted"), True)
            self.assertEqual(event["text"], "[redacted]")
            if event["kind"] == "braille":
                self.assertEqual(base64.b64decode(event["brailleCells"]), b"")
                self.assertEqual(event["brailleCursor"], 0)

    def test_protected_speech_and_braille_are_scrubbed_before_retention(self):
        self.focus(SimpleNamespace(isProtected=True))
        self.capture_speech_and_braille()
        self.assert_suppressed(self.state.events)
        self.assert_suppressed(self.state.since(0))

    def test_unprotected_speech_and_braille_remain_exact(self):
        self.capture_speech_and_braille()
        speech, braille = self.state.events
        self.assertEqual(speech["text"], SENTINEL)
        self.assertEqual(braille["text"], SENTINEL)
        self.assertEqual(base64.b64decode(braille["brailleCells"]), bytes(CELLS))
        self.assertEqual(braille["brailleCursor"], 1)
        self.assertNotIn("redacted", speech)
        self.assertNotIn("redacted", braille)

    def test_protection_getter_failure_suppresses_both_capture_channels(self):
        self.focus(UnavailableProtection())
        self.capture_speech_and_braille()
        self.assert_suppressed(self.state.events)

    def test_unknown_or_missing_focus_suppresses_both_capture_channels(self):
        for focus in (None, SimpleNamespace(), SimpleNamespace(isProtected=None)):
            with self.subTest(focus=focus):
                self.state.events.clear()
                self.focus(focus)
                self.capture_speech_and_braille()
                self.assert_suppressed(self.state.events)

    def test_focus_acquisition_failure_suppresses_both_capture_channels(self):
        self.namespace["api"].getFocusObject = mock.Mock(side_effect=COMError("no focus"))
        self.capture_speech_and_braille()
        self.assert_suppressed(self.state.events)

    def test_event_buffer_scrubs_redacted_content_from_every_text_hook(self):
        for kind in ("speech", "focus", "liveRegion", "braille"):
            with self.subTest(kind=kind):
                event = self.state.append(
                    kind, SENTINEL, redacted=True,
                    **({"brailleCells": base64.b64encode(bytes(CELLS)).decode("ascii"),
                        "brailleCursor": 1} if kind == "braille" else {}),
                )
                self.assert_suppressed([event])

    def test_protected_braille_refresh_is_deduplicated_after_scrubbing(self):
        self.focus(SimpleNamespace(isProtected=True))
        self.hooks.on_braille(cells=CELLS, rawText=SENTINEL)
        self.hooks.on_braille(cells=CELLS, rawText=SENTINEL)
        self.assertEqual(len(self.state.events), 1)
        self.assert_suppressed(self.state.events)

    def test_protected_focus_event_does_not_read_the_object_name(self):
        class ProtectedFocus:
            isProtected = True
            role = SimpleNamespace(displayString="password")

            @property
            def name(self):
                raise AssertionError("protected name must remain unread")

        next_handler = mock.Mock()
        self.hooks.event_gainFocus(ProtectedFocus(), next_handler)
        next_handler.assert_called_once_with()
        self.assert_suppressed(self.state.events)

    def test_unknown_focus_event_protection_suppresses_the_object_name(self):
        self.hooks.event_gainFocus(
            SimpleNamespace(role=SimpleNamespace(displayString="password"), name=SENTINEL),
            lambda: None,
        )
        self.assert_suppressed(self.state.events)

    def test_protected_live_region_speech_and_braille_are_scrubbed_with_unprotected_focus(self):
        self.hooks.capture_live_region(
            SimpleNamespace(isProtected=True), self.capture_speech_and_braille, "assertive",
        )
        self.assertEqual([event["kind"] for event in self.state.events],
                         ["speech", "liveRegion", "braille"])
        self.assert_suppressed(self.state.events)
        self.assertIsNone(self.state.live_region_context)

    def test_live_region_with_unavailable_protection_is_retained_only_as_redacted(self):
        self.hooks.capture_live_region(UnavailableProtection(), lambda: None, "polite")
        self.assertEqual(len(self.state.events), 1)
        self.assert_suppressed(self.state.events)

    def test_live_region_fallback_preserves_recent_speech_redaction(self):
        self.state.append("speech", SENTINEL, redacted=True)
        self.hooks.capture_live_region(
            SimpleNamespace(isProtected=False, name="", value=""), lambda: None, "polite",
        )
        self.assert_suppressed(self.state.events)


if __name__ == "__main__":
    unittest.main()
