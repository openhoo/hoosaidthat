"""Exercise F6 ownership checks with an Explorer window and a Chrome window."""

import ast
import ctypes
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from test_control_privacy import PLUGIN_PATH


class BrowserForegroundTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(PLUGIN_PATH.read_text(encoding="utf-8"))
        defs = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                and n.name in ("ensure_browser_foreground", "emulate")]
        self.gestures = []
        self.namespace = dict(os=os, json=json, call_on_main=lambda fn: fn(),
                              KeyboardInputGesture=Mock(fromName=lambda name: name),
                              inputCore=Mock(manager=Mock(emulateGesture=self.gestures.append)))
        exec(compile(ast.Module(body=defs, type_ignores=[]), str(PLUGIN_PATH), "exec"), self.namespace)
        tmp = self.enterContext(TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {"ProgramData": tmp}))
        owner = Path(tmp, "HooSaidThat", "browser-owner.json")
        owner.parent.mkdir()
        owner.write_text('{"pid": 82, "createdFileTime": 43}')
        self.foreground = 101
        self.visible = [101, 102]
        self.kernel, self.user = Mock(), Mock()
        self.enterContext(patch.object(ctypes, "WinDLL", create=True,
                                      side_effect=lambda name: self.user if name == "user32" else self.kernel))
        self.enterContext(patch.object(ctypes, "WINFUNCTYPE", create=True,
                                      side_effect=lambda *types: lambda func: func))
        self.kernel.OpenProcess.return_value = 33
        self.created = 43

        def get_times(handle, created, *_):
            created._obj.dwLowDateTime = self.created
            return True

        self.kernel.GetProcessTimes.side_effect = get_times
        self.user.GetForegroundWindow.side_effect = lambda: self.foreground
        self.user.GetWindowThreadProcessId.side_effect = lambda hwnd, pid: setattr(
            pid._obj, "value", 8 if hwnd == 101 else 82)
        self.user.IsWindowVisible.return_value = True
        self.user.IsIconic.return_value = False
        self.user.GetClassNameW.side_effect = lambda hwnd, buf, size: (
            setattr(buf, "value", "Chrome_WidgetWin_1") or len(buf.value))
        self.user.EnumWindows.side_effect = lambda callback, arg: all(
            callback(hwnd, arg) for hwnd in self.visible)
        self.user.SetForegroundWindow.side_effect = lambda hwnd: setattr(self, "foreground", hwnd)

    def test_f6_reaches_the_owned_browser_after_explorer_took_focus(self):
        self.namespace["emulate"]("f6")
        self.assertEqual(self.foreground, 102)
        self.assertEqual(self.gestures, ["f6"])
        self.kernel.CloseHandle.assert_called_once_with(33)

    def test_f6_does_not_activate_an_ambiguous_or_reused_browser(self):
        self.visible.append(103)
        with self.assertRaisesRegex(RuntimeError, "one visible"):
            self.namespace["emulate"]("f6")
        self.created += 1
        with self.assertRaisesRegex(RuntimeError, "reused"):
            self.namespace["emulate"]("f6")
        self.user.SetForegroundWindow.assert_not_called()
        self.assertFalse(self.gestures)

    def test_f6_is_not_sent_if_windows_refuses_activation(self):
        self.user.SetForegroundWindow.side_effect = lambda hwnd: None
        with self.assertRaisesRegex(RuntimeError, "foreground focus"):
            self.namespace["emulate"]("f6")
        self.assertFalse(self.gestures)


if __name__ == "__main__":
    unittest.main()
