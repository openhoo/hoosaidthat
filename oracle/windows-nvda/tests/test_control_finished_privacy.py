"""Verify saved and downloaded evidence from the shipped finish handler.

Native capture hooks and HTTP response methods are compiled from production.
Only NVDA imports, plugin registration, and the socket transport are omitted.
"""

import ast
import base64
import hashlib
import io
import json
from types import SimpleNamespace
import unittest
from unittest import mock

from test_control_privacy import CELLS, PLUGIN_PATH, SENTINEL, load_capture


def load_finish_handler(namespace):
    tree = ast.parse(PLUGIN_PATH.read_text(encoding="utf-8"))
    required = {"require_session", "finish_session", "artifact", "json_response"}
    handler = next(
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "Handler"
    )
    methods = [
        node for node in handler.body
        if isinstance(node, ast.FunctionDef) and node.name in required
    ]
    if {node.name for node in methods} != required:
        raise AssertionError("production finish definitions are missing")
    module = ast.fix_missing_locations(ast.Module(
        body=[ast.ClassDef(
            name="FinishHandler", bases=[], keywords=[], body=methods, decorator_list=[],
        )],
        type_ignores=[],
    ))
    namespace.update(
        json=json,
        hashlib=hashlib,
        NVDA_VERSION="public-test-version",
        PROFILE="public-test-profile",
        read_presentation_settings=mock.Mock(return_value={"reportHeadings": True}),
        apply_presentation_settings=mock.Mock(),
    )
    exec(compile(module, str(PLUGIN_PATH), "exec"), namespace)
    handler = namespace["FinishHandler"]()
    handler.read_json = mock.Mock(return_value={})
    handler.send_response = mock.Mock()
    handler.send_header = mock.Mock()
    handler.end_headers = mock.Mock()
    handler.wfile = io.BytesIO()
    return handler


class FinishedArtifactPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.namespace, self.hooks = load_capture()
        self.state = self.namespace["STATE"]
        self.handler = load_finish_handler(self.namespace)
        self.session_id = "a" * 32
        self.baseline = {"reportHeadings": False}
        self.state.active_session = {
            "id": self.session_id,
            "startSequence": 0,
            "locale": "en-US",
            "keyboardLayout": "desktop",
            "baselineSettings": self.baseline,
        }

    def capture_every_text_channel(self, protected):
        obj = SimpleNamespace(
            isProtected=protected,
            name=SENTINEL,
            role=SimpleNamespace(displayString="button"),
        )
        self.namespace["api"].getFocusObject = lambda: obj
        self.hooks.on_speech(speechSequence=[SENTINEL])
        self.hooks.on_braille(cells=CELLS, rawText=SENTINEL)
        self.hooks.event_gainFocus(obj, lambda: None)
        self.hooks.capture_live_region(obj, lambda: None, "polite")

    def finish_and_download(self):
        self.handler.finish_session(self.session_id)
        self.handler.send_response.assert_called_once_with(200)
        result = json.loads(self.handler.wfile.getvalue())
        self.assertIsNone(self.state.active_session)
        self.namespace["apply_presentation_settings"].assert_called_once_with(self.baseline)
        stored = self.state.finished[self.session_id]["content"]
        descriptor = result["artifacts"][0]
        self.assertEqual(result["sessionId"], self.session_id)
        self.assertEqual(result["cursor"], self.state.sequence)
        self.assertEqual(descriptor["name"], "screenreader-events")
        self.assertEqual(descriptor["contentType"], "application/json")
        self.assertEqual(descriptor["bytes"], len(stored))
        self.assertEqual(descriptor["sha256"], hashlib.sha256(stored).hexdigest())

        self.handler.wfile = io.BytesIO()
        self.handler.send_response.reset_mock()
        self.handler.send_header.reset_mock()
        self.handler.artifact(self.session_id, descriptor["name"])
        self.handler.send_response.assert_called_once_with(200)
        downloaded = self.handler.wfile.getvalue()
        self.assertEqual(downloaded, stored)
        headers = dict(call.args for call in self.handler.send_header.call_args_list)
        self.assertEqual(headers["Content-Length"], str(len(downloaded)))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        evidence = json.loads(downloaded)
        self.assertEqual(evidence["presentationSettings"], {"reportHeadings": True})
        self.assertEqual(
            [event["kind"] for event in evidence["events"]],
            ["speech", "braille", "focus", "liveRegion"],
        )
        return downloaded, evidence

    def test_protected_text_and_cells_are_absent_from_saved_and_downloaded_artifact(self):
        self.capture_every_text_channel(protected=True)
        downloaded, evidence = self.finish_and_download()
        self.assertNotIn(SENTINEL.encode("ascii"), downloaded)
        self.assertNotIn(base64.b64encode(bytes(CELLS)), downloaded)
        for event in evidence["events"]:
            self.assertIs(event.get("redacted"), True)
            self.assertEqual(event["text"], "[redacted]")
            if event["kind"] == "braille":
                self.assertEqual(base64.b64decode(event["brailleCells"]), b"")
                self.assertEqual(event["brailleCursor"], 0)

    def test_unprotected_evidence_preserves_text_cells_and_cursor_through_download(self):
        self.capture_every_text_channel(protected=False)
        _, evidence = self.finish_and_download()
        for event in evidence["events"]:
            self.assertIn(SENTINEL, event["text"])
            self.assertNotIn("redacted", event)
            if event["kind"] == "braille":
                self.assertEqual(base64.b64decode(event["brailleCells"]), bytes(CELLS))
                self.assertEqual(event["brailleCursor"], 1)


if __name__ == "__main__":
    unittest.main()
