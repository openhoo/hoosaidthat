"""Exercise NVDA's native live-region callback across the deferred event queue.

The callback fixture preserves the pinned NVDAHelper call boundary: it queues
speech.speakText and braille.handler.message directly from its own module. No
object liveRegionChange event or text/recency matching connects these channels.
The actual Windows profile remains the integration qualification for this seam.
"""

from types import ModuleType, SimpleNamespace
import ast
import json
import re
import unittest
from unittest import mock

from test_control_privacy import CELLS, PLUGIN_PATH, SENTINEL, load_capture


class NativeLiveRegionQueueTests(unittest.TestCase):
    def setUp(self):
        self.namespace, self.hooks = load_capture()
        self.state = self.namespace["STATE"]
        self.pending = []
        self.forwarded = []

        def queue_function(queue, function, *args, _immediate=False, **kwargs):
            self.forwarded.append((queue, function, args, _immediate, kwargs))
            self.pending.append((function, args, kwargs))
            return "queue-result"

        self.original_queue_function = queue_function
        self.queue_handler = SimpleNamespace(eventQueue=object(), queueFunction=queue_function)
        self.namespace["queueHandler"] = self.queue_handler

        def speak_text(text, priority=None):
            self.hooks.on_speech(speechSequence=[text], priority=priority)
            return "speech-result"

        class BrailleHandler:
            _cells = CELLS
            _cursorPos = 1
            mainBuffer = object()
            messageBuffer = object()
            buffer = mainBuffer
            text = ""

            def message(handler, text):
                before_message = getattr(self.hooks, "on_braille_message", None)
                if before_message is not None:
                    before_message()
                handler.buffer = handler.messageBuffer
                handler.text = text
                self.hooks.on_braille(cells=CELLS, rawText=text)

            def refresh(handler):
                self.hooks.on_braille(cells=CELLS, rawText=handler.text)

        self.speech = SimpleNamespace(speakText=speak_text)
        self.braille = SimpleNamespace(handler=BrailleHandler())
        self.namespace.update(speech=self.speech, braille=self.braille)
        self.helper = ModuleType("NVDAHelper")
        self.helper.__dict__.update(
            queueHandler=self.queue_handler,
            speech=self.speech,
            braille=self.braille,
            SimpleNamespace=SimpleNamespace,
        )
        exec(
            "def nvdaControllerInternal_reportLiveRegion(text, politeness):\n"
            "    politenessValue = SimpleNamespace(value=politeness)\n"
            "    queueHandler.queueFunction(queueHandler.eventQueue, speech.speakText, text,\n"
            "        priority='NEXT' if politeness == 'assertive' else 'NORMAL')\n"
            "    queueHandler.queueFunction(queueHandler.eventQueue, braille.handler.message, text)\n"
            "    return 0\n",
            self.helper.__dict__,
        )
        self.namespace["NVDAHelper"] = self.helper
        # The baseline has no native hook; retaining its actual queue behavior
        # demonstrates the missing semantic event before the implementation.
        install = getattr(self.hooks, "install_native_live_region_capture", None)
        if install is not None:
            install()

    def drain(self):
        while self.pending:
            function, args, kwargs = self.pending.pop(0)
            function(*args, **kwargs)

    def focus(self, protected):
        self.namespace["api"].getFocusObject = lambda: SimpleNamespace(isProtected=protected)

    def report(self, text="Native update", priority="polite"):
        return self.helper.nvdaControllerInternal_reportLiveRegion(text, priority)

    def test_native_callback_emits_semantics_only_at_deferred_speech_boundary(self):
        for priority in ("polite", "assertive"):
            with self.subTest(priority=priority):
                self.state.events.clear()
                self.state.command = "activate"
                self.assertEqual(self.report(priority=priority), 0)
                self.assertEqual(self.state.events, [])
                self.state.command = "event"
                self.drain()
                self.assertEqual([event["kind"] for event in self.state.events],
                                 ["speech", "liveRegion", "braille"])
                self.assertTrue(all(event["text"] == "Native update" for event in self.state.events))
                self.assertTrue(all(event["causalCommand"] == "activate" for event in self.state.events))
                self.assertEqual(self.state.events[1]["priority"], priority)
                self.assertIsNone(self.state.live_region_context)
                self.assertEqual(self.forwarded[-2][4]["priority"],
                                 "NEXT" if priority == "assertive" else "NORMAL")

    def test_separate_native_reports_keep_their_own_priority_and_command(self):
        self.state.command = "activate"
        self.report("First update", "assertive")
        self.state.command = "activateWithSpace"
        self.report("Second update", "polite")
        self.state.command = "event"
        self.drain()
        live = [event for event in self.state.events if event["kind"] == "liveRegion"]
        self.assertEqual([(event["text"], event["priority"], event["causalCommand"]) for event in live],
                         [("First update", "assertive", "activate"),
                          ("Second update", "polite", "activateWithSpace")])

    def test_protection_at_native_queue_is_preserved_after_focus_changes(self):
        self.focus(True)
        self.report(SENTINEL)
        self.focus(False)
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events],
                         ["speech", "liveRegion", "braille"])
        for event in self.state.events:
            self.assertEqual(event["text"], "[redacted]")
            self.assertIs(event.get("redacted"), True)
        self.assertEqual(self.state.events[-1]["brailleCells"], "")

    def test_protection_at_execution_still_suppresses_native_channels(self):
        self.focus(False)
        self.report(SENTINEL)
        self.focus(True)
        self.drain()
        self.assertEqual(len(self.state.events), 3)
        self.assertTrue(all(event["text"] == "[redacted]" for event in self.state.events))

    def test_protected_retained_braille_message_stays_scrubbed_after_focus_changes(self):
        self.focus(True)
        self.report(SENTINEL)
        self.drain()
        self.focus(False)
        self.braille.handler.refresh()
        self.assertNotIn(SENTINEL, json.dumps(self.state.events))
        braille = [event for event in self.state.events if event["kind"] == "braille"]
        self.assertTrue(all(event["text"] == "[redacted]" and event["brailleCells"] == ""
                            for event in braille))

    def test_new_public_message_and_restored_main_buffer_do_not_inherit_redaction(self):
        self.focus(True)
        self.report(SENTINEL)
        self.drain()
        self.focus(False)
        self.braille.handler.buffer = self.braille.handler.mainBuffer
        self.braille.handler.text = "Restored main buffer"
        self.braille.handler.refresh()
        self.assertEqual(self.state.events[-1]["text"], "Restored main buffer")
        self.assertNotIn("redacted", self.state.events[-1])
        self.braille.handler.message("New public message")
        self.assertEqual(self.state.events[-1]["text"], "New public message")
        self.assertNotIn("redacted", self.state.events[-1])

    def test_source_protected_braille_message_retains_scrubbing_with_public_focus(self):
        self.hooks.capture_live_region(
            SimpleNamespace(isProtected=True),
            lambda: self.braille.handler.message(SENTINEL),
            "assertive",
        )
        self.braille.handler.refresh()
        self.assertNotIn(SENTINEL, json.dumps(self.state.events))

    def test_existing_source_protection_context_survives_deferred_native_queue(self):
        self.state.live_region_context = {"protected": True, "priority": "assertive", "emitted": False}
        self.report(SENTINEL)
        self.state.live_region_context = None
        self.drain()
        self.assertEqual(len(self.state.events), 3)
        self.assertTrue(all(event["text"] == "[redacted]" for event in self.state.events))

    def test_ordinary_speech_queue_preserves_function_arguments_and_result(self):
        result = self.queue_handler.queueFunction(
            self.queue_handler.eventQueue, self.speech.speakText, "Ordinary speech",
            priority="NOW", _immediate=True,
        )
        self.assertEqual(result, "queue-result")
        queued = self.forwarded[-1]
        self.assertIs(queued[1], self.speech.speakText)
        self.assertEqual(queued[2:], (("Ordinary speech",), True, {"priority": "NOW"}))
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events], ["speech"])

    def test_matching_callback_name_in_another_module_does_not_capture(self):
        foreign = dict(self.helper.__dict__)
        exec(
            "def nvdaControllerInternal_reportLiveRegion(text, politeness):\n"
            "    politenessValue = SimpleNamespace(value=politeness)\n"
            "    queueHandler.queueFunction(queueHandler.eventQueue, speech.speakText, text)\n",
            foreign,
        )
        foreign["nvdaControllerInternal_reportLiveRegion"]("Unrelated output", "polite")
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events], ["speech"])

    def test_other_native_helper_function_does_not_capture(self):
        exec(
            "def unrelated_native_report(text):\n"
            "    politenessValue = SimpleNamespace(value='polite')\n"
            "    queueHandler.queueFunction(queueHandler.eventQueue, speech.speakText, text)\n",
            self.helper.__dict__,
        )
        self.helper.unrelated_native_report("Unrelated output")
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events], ["speech"])

    def test_native_report_cannot_tag_other_queue_or_presentation_functions(self):
        self.helper.__dict__.update(otherQueue=object(), otherSpeech=self.speech.speakText)
        exec(
            "def nvdaControllerInternal_reportLiveRegion(text, politeness):\n"
            "    politenessValue = SimpleNamespace(value=politeness)\n"
            "    queueHandler.queueFunction(otherQueue, speech.speakText, text)\n"
            "    queueHandler.queueFunction(queueHandler.eventQueue, lambda value: otherSpeech(value), text)\n",
            self.helper.__dict__,
        )
        self.report("Unrelated output")
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events], ["speech", "speech"])

    def test_unknown_protection_at_queue_remains_scrubbed_at_public_execution(self):
        self.namespace["api"].getFocusObject = lambda: None
        self.report(SENTINEL)
        self.focus(False)
        self.drain()
        self.assertNotIn(SENTINEL, json.dumps(self.state.events))
        self.assertEqual(len(self.state.events), 3)

    def test_unrecognized_native_politeness_preserves_original_presentation(self):
        self.report(priority="off")
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events], ["speech", "braille"])

    def test_native_presentation_restores_context_when_target_raises(self):
        previous = {"protected": True, "priority": "polite", "emitted": False}
        self.state.live_region_context = previous
        context = {"protected": False, "priority": "assertive", "emitted": False,
                   "causalCommand": "activate"}

        def fail():
            raise RuntimeError("presentation failed")

        with self.assertRaisesRegex(RuntimeError, "presentation failed"):
            self.hooks.present_native_live_region(fail, context)
        self.assertIs(self.state.live_region_context, previous)

    def test_native_presentation_keeps_the_original_target_return_value(self):
        context = {"protected": False, "priority": "polite", "emitted": False,
                   "causalCommand": "activate"}
        result = self.hooks.present_native_live_region(
            self.speech.speakText, context, "Native update", priority="NORMAL",
        )
        self.assertEqual(result, "speech-result")
        self.assertIsNone(self.state.live_region_context)

    def test_removal_preserves_a_later_queue_hook_and_disables_queued_capture(self):
        self.report()
        installed = self.queue_handler.queueFunction

        def later_hook(*args, **kwargs):
            return installed(*args, **kwargs)

        self.queue_handler.queueFunction = later_hook
        self.hooks.remove_native_live_region_capture()
        self.assertIs(self.queue_handler.queueFunction, later_hook)
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events], ["speech", "braille"])
        self.queue_handler.queueFunction(self.queue_handler.eventQueue, self.speech.speakText, "Still usable")
        self.drain()
        self.assertEqual(self.state.events[-1]["text"], "Still usable")

    def test_removal_keeps_frozen_protection_for_pending_native_presentation(self):
        self.focus(True)
        self.report(SENTINEL)
        self.focus(False)
        self.hooks.remove_native_live_region_capture()
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events], ["speech", "braille"])
        self.assertNotIn(SENTINEL, json.dumps(self.state.events))
        self.braille.handler.refresh()
        self.assertNotIn(SENTINEL, json.dumps(self.state.events))

    def test_registration_is_idempotent_and_removal_restores_original(self):
        installed = self.queue_handler.queueFunction
        self.hooks.install_native_live_region_capture()
        self.assertIs(self.queue_handler.queueFunction, installed)
        self.hooks.remove_native_live_region_capture()
        self.assertIs(self.queue_handler.queueFunction, self.original_queue_function)

    def load_registered_plugin(self, fail_proxy=False):
        """Run the shipped constructor and teardown with inert I/O surfaces."""
        class Extension:
            def __init__(extension):
                extension.handlers = []

            def register(extension, handler):
                extension.handlers.append(handler)

            def unregister(extension, handler):
                extension.handlers.remove(handler)

        extensions = [Extension() for _ in range(5)]
        self.speech.extensions = SimpleNamespace(pre_speechQueued=extensions[0])
        self.braille.pre_writeCells = extensions[1]
        self.braille._pre_showBrailleMessage = extensions[2]
        self.braille.filter_displayDimensions = extensions[3]
        self.hooks.remove_native_live_region_capture()
        server = mock.Mock()
        proxy = mock.Mock()
        self.namespace.update(
            re=re,
            globalPluginHandler=SimpleNamespace(GlobalPlugin=object),
            core=SimpleNamespace(postNvdaStartup=extensions[4]),
            TOKEN_PATH="inert-test-token",
            PORT=3000,
            ThreadingHTTPServer=mock.Mock(return_value=server),
            ThreadingTCPServer=mock.Mock(
                side_effect=RuntimeError("proxy setup failed") if fail_proxy else None,
                return_value=proxy,
            ),
            Handler=object,
            CdpProxyHandler=object,
            threading=SimpleNamespace(Thread=mock.Mock()),
        )
        tree = ast.parse(PLUGIN_PATH.read_text(encoding="utf-8"))
        node = next(item for item in tree.body
                    if isinstance(item, ast.ClassDef) and item.name == "GlobalPlugin")
        module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
        exec(compile(module, str(PLUGIN_PATH), "exec"), self.namespace)
        with mock.patch("builtins.open", mock.mock_open(read_data="test-control-token-" + "x" * 32)):
            self.hooks = self.namespace["GlobalPlugin"]()
        return extensions, server, proxy

    def test_shipped_constructor_registers_capture_and_termination_restores_shared_hooks(self):
        extensions, server, proxy = self.load_registered_plugin()
        self.assertTrue(self.hooks._native_live_capture_enabled)
        self.assertTrue(all(len(extension.handlers) == 1 for extension in extensions))
        self.assertIn(self.hooks.on_braille_message, self.braille._pre_showBrailleMessage.handlers)
        self.report()
        self.drain()
        self.assertEqual([event["kind"] for event in self.state.events],
                         ["speech", "liveRegion", "braille"])
        self.hooks.terminate()
        self.assertIs(self.queue_handler.queueFunction, self.original_queue_function)
        self.assertTrue(all(not extension.handlers for extension in extensions))
        server.shutdown.assert_called_once_with()
        proxy.shutdown.assert_called_once_with()

    def test_failed_shipped_registration_rolls_back_queue_and_capture_extensions(self):
        extensions, server, _ = self.load_registered_plugin(fail_proxy=True)
        self.assertFalse(self.hooks._native_live_capture_enabled)
        self.assertIs(self.queue_handler.queueFunction, self.original_queue_function)
        self.assertTrue(all(not extension.handlers for extension in extensions))
        server.shutdown.assert_called_once_with()

    def test_shipped_termination_keeps_retained_protection_during_server_shutdown(self):
        _, server, _ = self.load_registered_plugin()
        self.focus(True)
        self.report(SENTINEL)
        self.drain()
        self.focus(False)
        server.shutdown.side_effect = self.braille.handler.refresh
        self.hooks.terminate()
        self.assertNotIn(SENTINEL, json.dumps(self.state.events))


if __name__ == "__main__":
    unittest.main()
