#!/usr/bin/env python3
"""Speech Dispatcher output module capturing Orca presentation requests."""

from __future__ import annotations

import fcntl
import html
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import TextIO
import xml.etree.ElementTree as ET


_WHITESPACE = re.compile(r"\s+")
_XML_DECLARATION = re.compile(r"^\s*<\?xml[^>]*\?>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]*>")
MAX_EVENT_BYTES = 1024 * 1024
MAX_LOG_BYTES = 16 * 1024 * 1024


def normalize_ssml_text(value: str) -> str:
    raw = _XML_DECLARATION.sub("", value.strip())
    if not raw:
        return ""
    try:
        wrapper = ET.fromstring(f"<hoosaidthat-root>{raw}</hoosaidthat-root>")
        text = "".join(wrapper.itertext())
    except ET.ParseError:
        text = html.unescape(_TAG.sub(" ", raw))
    return _WHITESPACE.sub(" ", text).strip()


class CaptureModule:
    def __init__(self, event_log: Path) -> None:
        self.event_log = event_log
        self.sequence = self.last_sequence()
        self.clock_origin_ns = time.monotonic_ns()
        self.initialized = False
        self.stopped = False
        self.settings: dict[str, str] = {}

    def last_sequence(self) -> int:
        if not self.event_log.exists():
            return 0
        last = 0
        with self.event_log.open(encoding="utf-8") as handle:
            fcntl.flock(handle, fcntl.LOCK_SH)
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                value = json.loads(line)
                sequence = value.get("sequence") if isinstance(value, dict) else None
                if type(sequence) is not int or sequence <= last:
                    raise RuntimeError("invalid existing speech event sequence")
                last = sequence
            fcntl.flock(handle, fcntl.LOCK_UN)
        return last

    def emit(self, kind: str, *, text: str = "", command: str = "") -> None:
        self.sequence += 1
        event = {
            "sequence": self.sequence,
            "monotonicNs": time.monotonic_ns() - self.clock_origin_ns,
            "kind": kind,
            "text": text,
            "command": command,
        }
        encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        if len(encoded.encode("utf-8")) > MAX_EVENT_BYTES:
            event["text"] = text[: MAX_EVENT_BYTES // 4]
            event["truncated"] = True
            encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        if len(encoded.encode("utf-8")) > MAX_EVENT_BYTES:
            raise RuntimeError("speech event exceeded safety bound")
        self.event_log.parent.mkdir(parents=True, exist_ok=True)
        with self.event_log.open("a", encoding="utf-8") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            next_size = os.fstat(handle.fileno()).st_size + len(encoded.encode("utf-8"))
            if next_size > MAX_LOG_BYTES:
                raise RuntimeError("speech event log exceeded safety bound")
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
            fcntl.flock(handle, fcntl.LOCK_UN)

    @staticmethod
    def respond(output: TextIO, *lines: str) -> None:
        for line in lines:
            output.write(f"{line}\n")
        output.flush()

    @staticmethod
    def read_multiline(input_stream: TextIO) -> list[str]:
        lines: list[str] = []
        while True:
            line = input_stream.readline()
            if line == "":
                raise RuntimeError("unexpected EOF in multiline Speech Dispatcher request")
            stripped = line.rstrip("\r\n")
            if stripped == ".":
                return lines
            if stripped.startswith(".."):
                stripped = stripped[1:]
            lines.append(stripped)

    def require_initialized(self, output: TextIO) -> bool:
        if self.initialized:
            return True
        self.respond(output, "400 ERROR NOT INITIALIZED")
        return False

    def speak(self, command: str, input_stream: TextIO, output: TextIO) -> None:
        if not self.require_initialized(output):
            return
        self.respond(output, "202 OK SEND DATA")
        raw = "\n".join(self.read_multiline(input_stream))
        text = normalize_ssml_text(raw)
        if not text:
            self.respond(output, "301 ERROR EMPTY MESSAGE")
            return
        self.emit("speech", text=text, command=command)
        self.respond(output, "200 OK SPEAKING", "701 BEGIN", "702 END")

    def read_settings(self, input_stream: TextIO) -> dict[str, str]:
        settings: dict[str, str] = {}
        for line in self.read_multiline(input_stream):
            if "=" not in line:
                raise RuntimeError(f"expected name=value setting, got {line!r}")
            name, value = line.split("=", 1)
            key = name.strip()
            if not key:
                raise RuntimeError("setting name must be non-empty")
            settings[key] = value
        return settings

    def receive_settings(
        self,
        input_stream: TextIO,
        output: TextIO,
        prelude: str,
        final: str,
        prefix: str = "",
    ) -> None:
        if not self.require_initialized(output):
            return
        self.respond(output, prelude)
        for name, value in self.read_settings(input_stream).items():
            self.settings[f"{prefix}{name}"] = value
        self.respond(output, final)

    def handle(self, line: str, input_stream: TextIO, output: TextIO) -> None:
        command = line.strip().upper()
        if not command:
            return
        if command == "INIT":
            if self.initialized:
                self.respond(output, "401 ERROR ALREADY INITIALIZED")
                return
            self.initialized = True
            self.respond(
                output,
                "299-Hoo Said That capture module initialized",
                "299 OK LOADED SUCCESSFULLY",
            )
        elif command in {"SPEAK", "CHAR", "KEY", "SOUND_ICON"}:
            self.speak(command, input_stream, output)
        elif command == "SET":
            self.receive_settings(
                input_stream,
                output,
                "203 OK RECEIVING SETTINGS",
                "203 OK SETTINGS RECEIVED",
            )
        elif command == "AUDIO":
            self.receive_settings(
                input_stream,
                output,
                "207 OK RECEIVING AUDIO SETTINGS",
                "203 OK AUDIO INITIALIZED",
                "audio:",
            )
        elif command == "LOGLEVEL":
            self.receive_settings(
                input_stream,
                output,
                "207 OK RECEIVING LOGLEVEL SETTINGS",
                "203 OK LOG LEVEL SET",
                "loglevel:",
            )
        elif command == "STOP":
            # STOP is asynchronous and has no command reply. This capture
            # module completes every utterance synchronously with 702 END, so
            # there is no in-flight BEGIN to terminate with 703 STOP here.
            # Emitting an unmatched STOP event wedges Speech Dispatcher's
            # output-module state before the next SPEAK request.
            return
        elif command == "PAUSE":
            # Same protocol rule as STOP: no reply and no unmatched event when
            # the module is already idle.
            return
        elif command == "LIST VOICES":
            self.respond(output, "200-hoosaidthat\ten\tnone", "200 OK VOICE LIST SENT")
        elif command.startswith("DEBUG ON") or command == "DEBUG OFF":
            self.respond(output, "200 OK DEBUG")
        elif command == "QUIT":
            self.stopped = True
            self.respond(output, "210 OK QUIT")
        else:
            self.respond(output, "300 ERROR UNKNOWN COMMAND")

    def run(self, input_stream: TextIO, output: TextIO) -> int:
        while not self.stopped:
            line = input_stream.readline()
            if line == "":
                self.stopped = True
                break
            self.handle(line, input_stream, output)
        return 0


def main() -> int:
    raw_path = os.environ.get("HST_EVENTS_FILE")
    if not raw_path:
        raise RuntimeError("HST_EVENTS_FILE is required")
    return CaptureModule(Path(raw_path)).run(sys.stdin, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
