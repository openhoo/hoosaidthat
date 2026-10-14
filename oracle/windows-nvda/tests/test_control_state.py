"""Execute shipped NVDA state/action functions through a real thread queue.

These regressions cover disconnected native objects and lifecycle ordering.
The imports and server initialization are omitted; the tested definitions are
compiled directly from the production plugin. Physical NVDA parity remains a
separate gate.
"""

import ast
import base64
import hashlib
from pathlib import Path
import queue
from types import SimpleNamespace
import threading
import time
import unittest


PLUGIN_PATH = (
    Path(__file__).parents[1]
    / "oem/hoosaidthat/nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py"
)


class COMError(Exception):
    """Public sentinel for a native getter failure; contains no real state."""


class GetterProbe:
    def __init__(self):
        self.main_ident = None
        self.failures = set()
        self.reads = []
        self.wrong_thread = []

    def read(self, getter, value):
        self.reads.append(getter)
        if threading.get_ident() != self.main_ident:
            self.wrong_thread.append(getter)
            raise AssertionError("native getter read outside NVDA's queued main thread")
        if getter in self.failures:
            raise COMError(getter)
        return value


class NativeObject:
    def __init__(self, probe, label, **values):
        self._probe = probe
        self._label = label
        self._values = values

    def __getattr__(self, name):
        if name not in self._values:
            raise AttributeError(name)
        return self._probe.read(self._label + "." + name, self._values[name])


class MainQueue:
    def __init__(self, probe):
        self.eventQueue = queue.Queue()
        self.probe = probe
        self.started = threading.Event()
        self.thread = threading.Thread(target=self.run, name="FakeNVDAMain")
        self.thread.start()
        if not self.started.wait(2):
            raise AssertionError("main queue did not start")

    def run(self):
        self.probe.main_ident = threading.get_ident()
        self.started.set()
        while True:
            callback = self.eventQueue.get()
            if callback is None:
                return
            callback()

    def queueFunction(self, event_queue, function):
        if event_queue is not self.eventQueue:
            raise AssertionError("unexpected main queue")
        event_queue.put(function)

    def close(self):
        self.eventQueue.put(None)
        self.thread.join(2)
        if self.thread.is_alive():
            raise AssertionError("main queue did not stop")


def invoke_from_http(function):
    result = {}

    def invoke():
        try:
            result["value"] = function()
        except BaseException as error:
            result["error"] = error

    worker = threading.Thread(target=invoke, name="FakeHTTPWorker")
    worker.start()
    worker.join(4)
    if worker.is_alive():
        raise AssertionError("HTTP worker did not return")
    if "error" in result:
        raise result["error"]
    return result.get("value")


def load_runtime():
    tree = ast.parse(PLUGIN_PATH.read_text(encoding="utf-8"))
    required = {
        "OracleState", "call_on_main", "current_state", "object_is_protected", "execute_action",
    }
    selected = [
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in required
    ]
    if {node.name for node in selected} != required:
        raise AssertionError("production definitions are missing")
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    namespace = {
        "base64": base64,
        "hashlib": hashlib,
        "threading": threading,
        "time": time,
        "MAX_EVENTS": 1000,
        "PROVENANCE_BY_KIND": {},
        "COMMAND_BY_ID": {"testMove": ("testMove", "test move", "downArrow", "downArrow")},
        "DIRECT_COMMAND_BY_ID": {},
        "DIRECT_GLOBAL_COMMAND_BY_ID": {},
        "DIRECT_BRAILLE_COMMAND_BY_ID": {},
        "DIRECT_SPEECH_COMMAND_BY_ID": {},
    }
    exec(compile(module, str(PLUGIN_PATH), "exec"), namespace)
    return namespace


class FastClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def monotonic_ns(self):
        return int(self.now * 1_000_000_000)

    def sleep(self, duration):
        self.now += duration


class StateExecutionTests(unittest.TestCase):
    def setUp(self):
        self.namespace = load_runtime()
        self.probe = GetterProbe()
        self.main_queue = MainQueue(self.probe)
        self.addCleanup(self.main_queue.close)
        self.objects = {
            channel: self.native_object(channel) for channel in ("focus", "navigator", "review", "mouse")
        }
        self.api = SimpleNamespace(
            getFocusObject=lambda: self.probe.read("api.getFocusObject", self.objects["focus"]),
            getNavigatorObject=lambda: self.probe.read("api.getNavigatorObject", self.objects["navigator"]),
            getReviewPosition=lambda: self.probe.read(
                "api.getReviewPosition",
                NativeObject(self.probe, "reviewPosition", obj=self.objects["review"]),
            ),
            getMouseObject=lambda: self.probe.read("api.getMouseObject", self.objects["mouse"]),
        )
        self.namespace.update(
            STATE=self.namespace["OracleState"](),
            queueHandler=self.main_queue,
            api=self.api,
            winUser=SimpleNamespace(
                getCursorPos=lambda: self.probe.read("winUser.getCursorPos", (120, 220)),
            ),
            speech=SimpleNamespace(
                getState=lambda: self.probe.read(
                    "speech.getState",
                    NativeObject(
                        self.probe, "speechState",
                        speechMode=NativeObject(self.probe, "speechMode", name="talk"),
                    ),
                ),
            ),
        )
        self.namespace["emulate"] = lambda gesture: self.namespace["call_on_main"](
            lambda: self.probe.read("emulate." + gesture, None)
        )

    def tearDown(self):
        self.assertEqual(self.probe.wrong_thread, [])

    def native_object(self, label):
        return NativeObject(
            self.probe, label,
            isProtected=False,
            role=NativeObject(self.probe, label + ".role", name="BUTTON", displayString="button"),
            location=(100, 200, 40, 20),
            name="public " + label,
            appModule=NativeObject(self.probe, label + ".appModule", appName="chrome"),
            windowHandle=101,
            IAccessibleChildID=0,
            treeInterceptor=NativeObject(self.probe, label + ".treeInterceptor", passThrough=False),
        )

    def snapshot(self):
        return invoke_from_http(self.namespace["current_state"])

    def assert_required_focus(self, state):
        self.assertIs(state["browserWindowActive"], True)
        self.assertIs(state["webContentFocused"], True)
        self.assertIs(state["cursorInDocument"], True)
        self.assertEqual(state["cursor"], {"mode": "browse"})
        self.assertEqual(state["focus"], {"role": "button", "name": "public focus"})

    def diagnostic(self, state, channel):
        return state["mouse"]["object"] if channel == "mouse" else state[channel]

    def test_healthy_snapshot_keeps_native_focus_and_all_diagnostics(self):
        state = self.snapshot()
        self.assert_required_focus(state)
        for channel in ("navigator", "review", "mouse"):
            obj = self.diagnostic(state, channel)
            self.assertEqual(obj["name"], "public " + channel)
            self.assertEqual(obj["role"], "button")
            self.assertEqual(len(obj["id"]), 32)
            self.assertEqual(obj["location"], {"left": 100, "top": 200, "width": 40, "height": 20})
        self.assertEqual((state["mouse"]["x"], state["mouse"]["y"]), (120, 220))
        self.assertEqual(state["speechMode"], "talk")
        self.assertIs(state["speechPaused"], False)
        self.assertEqual(state["lastSequence"], 0)
        self.assertNotEqual(self.probe.main_ident, threading.get_ident())
        self.assertIn("focus.name", self.probe.reads)

    def test_main_queue_propagates_callback_failure_to_http_caller(self):
        self.probe.failures = {"callback"}
        with self.assertRaisesRegex(COMError, "callback"):
            invoke_from_http(lambda: self.namespace["call_on_main"](
                lambda: self.probe.read("callback", None),
            ))

    def test_stale_optional_object_getters_only_invalidate_that_object(self):
        for channel in ("navigator", "review", "mouse"):
            for field in (
                "isProtected", "role", "role.name", "name", "appModule",
                "appModule.appName", "windowHandle", "IAccessibleChildID",
            ):
                with self.subTest(channel=channel, field=field):
                    self.probe.failures = {channel + "." + field}
                    self.probe.reads.clear()
                    state = self.snapshot()
                    self.assert_required_focus(state)
                    self.assertIsNone(self.diagnostic(state, channel))
                    for other in {"navigator", "review", "mouse"} - {channel}:
                        self.assertEqual(self.diagnostic(state, other)["name"], "public " + other)
                    if field == "isProtected":
                        self.assertNotIn(channel + ".name", self.probe.reads)

    def test_optional_acquisition_errors_include_lazy_review_position(self):
        for getter, channel in (
            ("api.getNavigatorObject", "navigator"),
            ("api.getReviewPosition", "review"),
            ("reviewPosition.obj", "review"),
            ("api.getMouseObject", "mouse"),
        ):
            with self.subTest(getter=getter):
                self.probe.failures = {getter}
                state = self.snapshot()
                self.assert_required_focus(state)
                self.assertIsNone(self.diagnostic(state, channel))

    def test_cursor_acquisition_error_omits_optional_mouse_without_inventing_coordinates(self):
        self.probe.failures = {"winUser.getCursorPos"}
        state = self.snapshot()
        self.assert_required_focus(state)
        self.assertNotIn("mouse", state)

    def test_unavailable_location_preserves_other_object_metadata(self):
        for channel in ("navigator", "review", "mouse"):
            with self.subTest(channel=channel):
                self.probe.failures = {channel + ".location"}
                state = self.snapshot()
                self.assert_required_focus(state)
                obj = self.diagnostic(state, channel)
                self.assertEqual(obj["name"], "public " + channel)
                self.assertIsNone(obj["location"])

    def test_required_focus_readiness_errors_still_fail(self):
        for getter in (
            "api.getFocusObject", "focus.appModule", "focus.appModule.appName",
            "focus.role", "focus.role.name", "focus.treeInterceptor",
            "focus.treeInterceptor.passThrough", "focus.name",
        ):
            with self.subTest(getter=getter):
                self.probe.failures = {getter}
                with self.assertRaisesRegex(COMError, getter):
                    self.snapshot()

    def test_document_role_is_stable_across_nvda_process_languages(self):
        for translated in ("document", "Dokument"):
            with self.subTest(displayString=translated):
                self.objects["focus"]._values["role"] = NativeObject(
                    self.probe, "focus.role", name="DOCUMENT", displayString=translated,
                )
                state = self.snapshot()
                self.assertEqual(state["focus"]["role"], "document")
        self.assertNotIn("focus.role.displayString", self.probe.reads)

    def test_role_display_fallback_is_available_without_native_enum_name(self):
        self.objects["focus"]._values["role"] = NativeObject(
            self.probe, "focus.role", displayString="legacy role",
        )
        self.assertEqual(self.snapshot()["focus"]["role"], "legacy role")

    def test_protected_and_unknown_focus_names_are_never_read(self):
        for protection in (True, None, "missing", "failure"):
            with self.subTest(protection=protection):
                focus = self.objects["focus"]
                focus._values["isProtected"] = protection
                if protection == "missing":
                    del focus._values["isProtected"]
                self.probe.failures = {"focus.name"}
                if protection == "failure":
                    self.probe.failures.add("focus.isProtected")
                self.probe.reads.clear()
                state = self.snapshot()
                self.assertEqual(state["focus"], {"role": "button", "name": None, "redacted": True})
                self.assertNotIn("focus.name", self.probe.reads)

    def test_protected_and_unknown_optional_names_are_never_read(self):
        for channel in ("navigator", "review", "mouse"):
            for protection in (True, None, "missing"):
                with self.subTest(channel=channel, protection=protection):
                    obj = self.objects[channel]
                    obj._values["isProtected"] = protection
                    if protection == "missing":
                        del obj._values["isProtected"]
                    self.probe.failures = {channel + ".name"}
                    self.probe.reads.clear()
                    value = self.diagnostic(self.snapshot(), channel)
                    self.assertIsNone(value["name"])
                    self.assertIs(value["redacted"], True)
                    self.assertNotIn(channel + ".name", self.probe.reads)

    def action(self, *, busy=False):
        clock = FastClock()
        self.namespace["time"] = clock
        self.namespace["STATE"] = self.namespace["OracleState"]()
        state = self.namespace["STATE"]

        def wait(duration):
            if busy:
                state.last_event_at = clock.now + 1.0
            clock.sleep(duration)

        state.condition.wait = wait
        return invoke_from_http(lambda: self.namespace["execute_action"]("testMove", ""))

    def settlements(self):
        return [
            event for event in self.namespace["STATE"].events if event["kind"] == "commandSettled"
        ]

    def test_action_snapshot_failure_emits_one_failed_settlement(self):
        for busy in (False, True):
            with self.subTest(timeoutBeforeSnapshot=busy):
                self.probe.failures = {"api.getFocusObject"}
                with self.assertRaisesRegex(COMError, "api.getFocusObject"):
                    self.action(busy=busy)
                settled = self.settlements()
                self.assertEqual([event["reason"] for event in settled], ["failed"])
                self.assertEqual([event["causalCommand"] for event in settled], ["testMove"])
                self.assertEqual(settled[0]["error"], "COMError")
                self.assertEqual(self.namespace["STATE"].command, "event")

    def test_action_dispatch_failure_emits_one_failed_settlement(self):
        self.probe.failures = {"emulate.downArrow"}
        with self.assertRaisesRegex(COMError, "emulate.downArrow"):
            self.action()
        self.assertEqual([event["reason"] for event in self.settlements()], ["failed"])
        self.assertEqual(self.namespace["STATE"].command, "event")

    def test_action_completion_and_timeout_keep_response_cursor_consistent(self):
        for busy in (False, True):
            with self.subTest(busy=busy):
                result = self.action(busy=busy)
                self.assertEqual([event["reason"] for event in self.settlements()],
                                 ["timeout" if busy else "completed"])
                self.assertEqual(result["timedOut"], busy)
                self.assertEqual(result["cursor"], result["state"]["lastSequence"])
                self.assertEqual(result["cursor"], result["events"][-1]["sequence"])
                self.assertEqual(result["beforeSequence"], 0)
                self.assertEqual(result["cursor"], 2)
                self.assertEqual(self.namespace["STATE"].command, "event")

    def test_action_includes_events_emitted_while_taking_state_snapshot(self):
        get_focus = self.api.getFocusObject

        def focus_and_event():
            obj = get_focus()
            self.namespace["STATE"].append("focus", "public state-snapshot event")
            return obj

        self.api.getFocusObject = focus_and_event
        result = self.action()
        self.assertEqual([event["kind"] for event in result["events"]],
                         ["commandStarted", "focus", "commandSettled"])
        self.assertEqual(result["cursor"], 3)
        self.assertEqual(result["state"]["lastSequence"], 3)
        self.assertEqual(result["events"][-1]["sequence"], 3)

    def test_event_history_failure_precedes_any_successful_settlement(self):
        original_oracle_state = self.namespace["OracleState"]

        class TruncatedOracleState(original_oracle_state):
            def since(self, sequence):
                raise RuntimeError("screen-reader event history was truncated")

        self.namespace["OracleState"] = TruncatedOracleState
        with self.assertRaisesRegex(RuntimeError, "event history was truncated"):
            self.action()
        self.assertEqual([event["reason"] for event in self.settlements()], ["failed"])
        self.assertEqual(self.namespace["STATE"].command, "event")


if __name__ == "__main__":
    unittest.main()
