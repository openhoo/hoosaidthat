#!/usr/bin/env python3
"""Authenticated local control plane for Linux screen-reader containers."""

from __future__ import annotations

import fcntl
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.request
from urllib.parse import parse_qs, urlsplit


PROTOCOL_VERSION = 1
MAX_SAFE_INTEGER = 2**53 - 1
MAX_BODY_BYTES = 8 * 1024
MAX_EVENT_LOG_BYTES = 16 * 1024 * 1024
MAX_ACTION_LOG_BYTES = 16 * 1024 * 1024
EVENTS_FILE = Path(os.environ.get("HST_EVENTS_FILE", "/tmp/hoosaidthat/events.jsonl"))
ACTIONS_FILE = Path(os.environ.get("HST_ACTIONS_FILE", "/tmp/hoosaidthat/actions.jsonl"))
TOKEN = os.environ.get("HST_CONTROL_TOKEN", "")
CDP_PORT = int(os.environ.get("HST_CDP_PORT", "9222"))
ACTION_LOCK = threading.Lock()
AT_SPI_LOCK = threading.Lock()
SCREEN_READER_NAME = os.environ.get("HST_SCREEN_READER_NAME", "orca")
SCREEN_READER_CAPTURE = os.environ.get(
    "HST_SCREEN_READER_CAPTURE", "speech-dispatcher-output-module"
)
SCREEN_READER_VERSION = os.environ.get("HST_SCREEN_READER_VERSION", "unknown")[:200]
SCREEN_READER_PID_ENV = os.environ.get("HST_SCREEN_READER_PID_ENV", "HST_ORCA_PID")


ACTIONS: dict[str, tuple[str, str]] = {
    "nextFocusable": ("Next focusable element", "Tab"),
    "previousFocusable": ("Previous focusable element", "shift+Tab"),
    "activate": ("Activate current element", "Return"),
    "activateWithSpace": ("Activate current element with Space", "space"),
    "escape": ("Escape current context", "Escape"),
    "returnToPage": ("Return focus to web page", "F6"),
    "nextHeading": ("Next heading", "h"),
    "previousHeading": ("Previous heading", "shift+h"),
    "nextLandmark": ("Next landmark", "m"),
    "previousLandmark": ("Previous landmark", "shift+m"),
    "nextButton": ("Next button", "b"),
    "previousButton": ("Previous button", "shift+b"),
    "nextFormField": ("Next form field", "f"),
    "previousFormField": ("Previous form field", "shift+f"),
    "nextLink": ("Next link", "k"),
    "previousLink": ("Previous link", "shift+k"),
    "nextList": ("Next list", "l"),
    "previousList": ("Previous list", "shift+l"),
    "nextListItem": ("Next list item", "i"),
    "previousListItem": ("Previous list item", "shift+i"),
    "nextTable": ("Next table", "t"),
    "previousTable": ("Previous table", "shift+t"),
    "nextImage": ("Next image", "g"),
    "previousImage": ("Previous image", "shift+g"),
    "nextCheckbox": ("Next checkbox", "x"),
    "previousCheckbox": ("Previous checkbox", "shift+x"),
    "nextRadioButton": ("Next radio button", "r"),
    "previousRadioButton": ("Previous radio button", "shift+r"),
    "nextCombobox": ("Next combo box", "c"),
    "previousCombobox": ("Previous combo box", "shift+c"),
    "nextEntry": ("Next entry", "e"),
    "previousEntry": ("Previous entry", "shift+e"),
    "nextParagraph": ("Next paragraph", "p"),
    "previousParagraph": ("Previous paragraph", "shift+p"),
    "nextCharacter": ("Next character", "Right"),
    "previousCharacter": ("Previous character", "Left"),
    "nextLine": ("Next line", "Down"),
    "previousLine": ("Previous line", "Up"),
    "documentStart": ("Start of document", "ctrl+Home"),
    "documentEnd": ("End of document", "ctrl+End"),
    "readCurrent": ("Read current location", "KP_Enter"),
    "sayAll": ("Read from current location", "KP_Add"),
    "toggleFocusMode": ("Toggle browse or focus mode", "Insert+a"),
}

def read_events() -> list[dict[str, object]]:
    if not EVENTS_FILE.exists():
        return []
    events: list[dict[str, object]] = []
    with EVENTS_FILE.open(encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_SH)
        if os.fstat(handle.fileno()).st_size > MAX_EVENT_LOG_BYTES:
            raise RuntimeError("speech event log exceeded safety bound")
        previous_sequence = 0
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("invalid speech event JSON") from error
            if not isinstance(value, dict):
                raise RuntimeError("invalid speech event record")
            sequence = value.get("sequence")
            monotonic_ns = value.get("monotonicNs")
            if (
                type(sequence) is not int
                or sequence <= previous_sequence
                or sequence > MAX_SAFE_INTEGER
            ):
                raise RuntimeError("speech event sequence is not strictly increasing")
            if (
                type(monotonic_ns) is not int
                or monotonic_ns < 0
                or monotonic_ns > MAX_SAFE_INTEGER
            ):
                raise RuntimeError("invalid speech event monotonic clock")
            if (
                value.get("kind") != "speech"
                or not isinstance(value.get("text"), str)
                or not isinstance(value.get("command"), str)
            ):
                raise RuntimeError("invalid speech event payload")
            previous_sequence = sequence
            events.append(value)
        fcntl.flock(handle, fcntl.LOCK_UN)
    return events


def last_sequence() -> int:
    events = read_events()
    if not events:
        return 0
    value = events[-1].get("sequence", 0)
    return value if isinstance(value, int) else 0


def process_alive(environment_name: str) -> bool:
    raw = os.environ.get(environment_name, "")
    if not raw.isdigit():
        return False
    try:
        os.kill(int(raw), 0)
    except OSError:
        return False
    return True


def process_command_alive(fragment: str) -> bool:
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(
                "utf-8", errors="replace"
            )
        except (OSError, PermissionError):
            continue
        if fragment in command:
            return True
    return False


def browser_endpoint_ready() -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=0.5
        ) as response:
            value = json.load(response)
        return (
            response.status == HTTPStatus.OK
            and isinstance(value, dict)
            and isinstance(value.get("webSocketDebuggerUrl"), str)
        )
    except (OSError, ValueError):
        return False


def browser_window_active() -> bool:
    try:
        active = subprocess.run(
            ["xdotool", "getactivewindow"],
            check=True,
            capture_output=True,
            text=True,
            timeout=1,
        ).stdout.strip()
        if not active.isdigit():
            return False
        window_pid = subprocess.run(
            ["xdotool", "getwindowpid", active],
            check=True,
            capture_output=True,
            text=True,
            timeout=1,
        ).stdout.strip()
        if not window_pid.isdigit():
            return False
        command = (
            Path(f"/proc/{window_pid}/cmdline")
            .read_bytes()
            .replace(b"\0", b" ")
            .decode("utf-8", errors="replace")
            .lower()
        )
        return "chrom" in command
    except (OSError, subprocess.SubprocessError):
        return False


def accessibility_focus() -> dict[str, object]:
    result: dict[str, object] = {
        "browserWindowActive": browser_window_active(),
        "browserRegistered": False,
        "webContentFocused": False,
        "role": None,
        "name": None,
    }
    try:
        with AT_SPI_LOCK:
            return _accessibility_focus(result)
    except Exception:
        return result


def _accessibility_focus(result: dict[str, object]) -> dict[str, object]:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    desktop = Atspi.get_desktop(0)
    stack: list[tuple[object, bool, bool, bool]] = [
        (desktop, False, False, False)
    ]
    focused_web: list[tuple[str, str]] = []
    focused_chrome: list[tuple[str, str]] = []
    visited = 0
    while stack:
        node, inside_browser, inside_active_frame, inside_web_document = stack.pop()
        visited += 1
        if visited > 50_000:
            raise RuntimeError("AT-SPI tree exceeded safety bound")
        try:
            role = node.get_role_name()
            name = node.get_name()
            normalized_role = role.lower()
            next_inside_browser = inside_browser or (
                normalized_role == "application" and "chrom" in name.lower()
            )
            states = node.get_state_set()
            next_inside_active_frame = inside_active_frame or (
                next_inside_browser
                and normalized_role == "frame"
                and states.contains(Atspi.StateType.ACTIVE)
            )
            next_inside_web_document = (
                next_inside_active_frame
                and (inside_web_document or normalized_role == "document web")
            )
            if next_inside_browser and normalized_role == "application":
                result["browserRegistered"] = True
            if next_inside_active_frame and states.contains(Atspi.StateType.FOCUSED):
                focused = (role[:200], name[:200])
                if next_inside_web_document:
                    focused_web.append(focused)
                elif normalized_role not in {
                    "application",
                    "frame",
                    "panel",
                    "section",
                    "tool bar",
                }:
                    focused_chrome.append(focused)
            for index in range(node.get_child_count() - 1, -1, -1):
                child = node.get_child_at_index(index)
                if child is not None:
                    stack.append(
                        (
                            child,
                            next_inside_browser,
                            next_inside_active_frame,
                            next_inside_web_document,
                        )
                    )
        except Exception:
            continue
    # Chromium can leave a stale FOCUSED state on its document while real
    # keyboard focus is in the address bar. Any focused chrome node therefore
    # takes precedence over document descendants.
    apply_focused_nodes(result, focused_web, focused_chrome)
    return result


def apply_focused_nodes(
    result: dict[str, object],
    focused_web: list[tuple[str, str]],
    focused_chrome: list[tuple[str, str]],
) -> None:
    selected = (
        focused_chrome[0]
        if focused_chrome
        else (focused_web[0] if focused_web else None)
    )
    result["webContentFocused"] = bool(focused_web) and not focused_chrome
    if selected is not None:
        result["role"], result["name"] = selected


def runtime_components(*, include_accessibility: bool = True) -> dict[str, bool]:
    components = {
        "xvfb": process_alive("HST_XVFB_PID"),
        "windowManager": process_alive("HST_WINDOW_MANAGER_PID"),
        "screenReader": process_alive(SCREEN_READER_PID_ENV),
        "chromium": process_alive("HST_CHROMIUM_PID"),
        "cdp": browser_endpoint_ready(),
    }
    optional_pid = os.environ.get("HST_OPTIONAL_SPEECH_PID_ENV")
    if optional_pid:
        components["speechDispatcher"] = process_alive(optional_pid)
    capture_process = os.environ.get("HST_CAPTURE_PROCESS_FRAGMENT")
    if capture_process:
        components["captureModule"] = process_command_alive(capture_process)
    if include_accessibility:
        focus = accessibility_focus()
        components["browserAccessibility"] = bool(focus["browserRegistered"])
        components["browserWindowActive"] = bool(focus["browserWindowActive"])
    return components


def runtime_ready(
    *, include_accessibility: bool = True
) -> tuple[bool, dict[str, bool]]:
    components = runtime_components(include_accessibility=include_accessibility)
    return all(components.values()), components


def action_runtime_ready() -> tuple[bool, dict[str, bool]]:
    # Full AT-SPI traversal is appropriate for state/health probes, but can
    # block behind Chromium tree churn during rapid navigation. Actions only
    # need live processes, CDP, and the active Chromium X11 window; Orca itself
    # observes the subsequent physical gesture through AT-SPI.
    components = runtime_components(include_accessibility=False)
    components["browserWindowActive"] = browser_window_active()
    return all(components.values()), components


def append_action(action: str, gesture: str, after_sequence: int) -> None:
    ACTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    value = {
        "monotonicNs": time.monotonic_ns(),
        "action": action,
        "gesture": gesture,
        "afterSequence": after_sequence,
    }
    encoded = json.dumps(value, separators=(",", ":")) + "\n"
    with ACTIONS_FILE.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        next_size = os.fstat(handle.fileno()).st_size + len(encoded.encode())
        if next_size > MAX_ACTION_LOG_BYTES:
            raise RuntimeError("action log exceeded safety bound")
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle, fcntl.LOCK_UN)


class Handler(BaseHTTPRequestHandler):
    server_version = "HooSaidThatControl/1"

    def log_message(self, format_string: str, *args: object) -> None:
        del format_string, args

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/healthz":
            ready, _components = runtime_ready(include_accessibility=False)
            self.send_json(
                HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE,
                {"status": "ok" if ready else "degraded"},
            )
            return
        if not self.authorized():
            return
        try:
            if parsed.path == "/v1/health":
                self.health()
            elif parsed.path == "/v1/state":
                focus = accessibility_focus()
                focus.pop("browserRegistered", None)
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "lastSequence": last_sequence(),
                        "focus": focus,
                    },
                )
            elif parsed.path == "/v1/actions":
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "actions": [
                            {"action": action, "label": label}
                            for action, (label, _gesture) in ACTIONS.items()
                        ],
                    },
                )
            elif parsed.path == "/v1/events":
                self.events(parse_qs(parsed.query))
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not-found"})
        except ValueError as error:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "invalid-request", "detail": str(error)[:500]},
            )
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "runtime-error", "detail": str(error)[:500]},
            )

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if not self.authorized():
            return
        if parsed.path != "/v1/actions":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not-found"})
            return
        if not self.headers.get("content-type", "").lower().startswith(
            "application/json"
        ):
            self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "content-type"})
            return
        try:
            content_length = int(self.headers.get("content-length", "0"))
        except ValueError:
            content_length = -1
        if content_length < 1 or content_length > MAX_BODY_BYTES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid-content-length"})
            return
        try:
            value = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid-json"})
            return
        action = value.get("action") if isinstance(value, dict) else None
        if not isinstance(action, str) or action not in ACTIONS:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "unknown-action"})
            return
        with ACTION_LOCK:
            ready, components = action_runtime_ready()
            if not ready:
                self.send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "runtime-degraded", "components": components},
                )
                return
            _label, gesture = ACTIONS[action]
            try:
                after_sequence = last_sequence()
                subprocess.run(
                    ["xdotool", "key", "--clearmodifiers", gesture],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=3,
                )
                append_action(action, gesture, after_sequence)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                self.send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "input-failed", "detail": str(error)[:500]},
                )
                return
        self.send_json(
            HTTPStatus.OK,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "action": action,
                "afterSequence": after_sequence,
            },
        )

    def authorized(self) -> bool:
        supplied = self.headers.get("authorization", "")
        expected = f"Bearer {TOKEN}"
        if TOKEN and hmac.compare_digest(supplied, expected):
            return True
        self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        return False

    def health(self) -> None:
        ready, components = runtime_ready()
        if not ready:
            self.send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "status": "degraded",
                    "components": components,
                },
            )
            return
        self.send_json(
            HTTPStatus.OK,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "status": "ready",
                "screenReader": {
                    "name": SCREEN_READER_NAME,
                    "version": SCREEN_READER_VERSION,
                    "capture": SCREEN_READER_CAPTURE,
                },
                "browser": {
                    "name": "chromium",
                    "version": os.environ.get("HST_CHROMIUM_VERSION", "unknown"),
                    "cdpPort": CDP_PORT,
                },
                "platform": "linux",
            },
        )

    def events(self, query: dict[str, list[str]]) -> None:
        after = bounded_integer(query, "after", 0, MAX_SAFE_INTEGER)
        timeout_ms = bounded_integer(query, "timeoutMs", 1, 30_000)
        quiet_ms = bounded_integer(query, "quietMs", 1, 5_000)
        initial_events = read_events()
        initial_last_sequence = (
            int(initial_events[-1]["sequence"]) if initial_events else 0
        )
        if after > initial_last_sequence:
            raise ValueError("after exceeds current sequence")
        deadline = time.monotonic() + timeout_ms / 1000
        previous_count = -1
        quiet_since: float | None = None
        selected: list[dict[str, object]] = []
        snapshot_last_sequence = after
        settled = False
        while time.monotonic() < deadline:
            events = read_events()
            snapshot_last_sequence = (
                int(events[-1]["sequence"]) if events else 0
            )
            selected = [event for event in events if int(event["sequence"]) > after]
            if selected:
                if len(selected) != previous_count:
                    previous_count = len(selected)
                    quiet_since = time.monotonic()
                elif quiet_since is not None and (
                    time.monotonic() - quiet_since >= quiet_ms / 1000
                ):
                    settled = True
                    break
            time.sleep(0.025)
        self.send_json(
            HTTPStatus.OK,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "events": selected,
                "lastSequence": snapshot_last_sequence,
                "timedOut": not settled,
            },
        )

    def send_json(self, status: HTTPStatus, value: object) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        try:
            self.send_response(status.value)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Bounded readiness polls may disconnect while a response is sent.
            return


def bounded_integer(
    query: dict[str, list[str]], name: str, minimum: int, maximum: int
) -> int:
    values = query.get(name)
    if not values or len(values) != 1:
        raise ValueError(f"missing {name}")
    value = int(values[0])
    if value < minimum or value > maximum:
        raise ValueError(f"{name} outside allowed range")
    return value


def main() -> int:
    if not TOKEN:
        raise RuntimeError("HST_CONTROL_TOKEN is required")
    port = int(os.environ.get("HST_CONTROL_PORT", "3000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever(poll_interval=0.1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
