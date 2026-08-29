"""Authenticated NVDA presentation oracle for HooSaidThat.

Captures NVDA's processed speech queue and braille display writes. Gesture
delivery uses NVDA's own system-test input path. Captured speech proves a
presentation request reached NVDA's synthesizer boundary; it is not acoustic
or user-perception evidence.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import select
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import BaseRequestHandler, TCPServer, ThreadingMixIn
from urllib.parse import parse_qs, urlsplit

import api
import braille
import config
import core
import globalPluginHandler
import globalCommands
import inputCore
import languageHandler
import queueHandler
import speech
import speech.extensions
import versionInfo
import winUser
from keyboardHandler import KeyboardInputGesture
from logHandler import log


PROFILE = "nvda-web-2026.1.1"
NVDA_VERSION = "2026.1.1"
CHROME_VERSION = "151.0.7922.47"
MAX_EVENTS = 100000
TOKEN_PATH = os.environ.get(
    "HST_NVDA_TOKEN_FILE", r"C:\ProgramData\HooSaidThat\control-token"
)
PORT = int(os.environ.get("HST_NVDA_CONTROL_PORT", "3000"))

COMMANDS = (
    ("nextFocusable", "Next focusable element", "tab", "tab"),
    ("previousFocusable", "Previous focusable element", "shift+tab", "shift+tab"),
    ("activate", "Activate current element", "enter", "enter"),
    ("activateWithSpace", "Activate current element with Space", "space", "space"),
    ("escape", "Escape current context", "escape", "escape"),
    ("returnToPage", "Return focus to web page", "f6", "f6"),
    ("nextHeading", "Next heading", "h", "h"),
    ("previousHeading", "Previous heading", "shift+h", "shift+h"),
    ("nextHeading1", "Next heading level 1", "1", "1"),
    ("previousHeading1", "Previous heading level 1", "shift+1", "shift+1"),
    ("nextHeading2", "Next heading level 2", "2", "2"),
    ("previousHeading2", "Previous heading level 2", "shift+2", "shift+2"),
    ("nextHeading3", "Next heading level 3", "3", "3"),
    ("previousHeading3", "Previous heading level 3", "shift+3", "shift+3"),
    ("nextHeading4", "Next heading level 4", "4", "4"),
    ("previousHeading4", "Previous heading level 4", "shift+4", "shift+4"),
    ("nextHeading5", "Next heading level 5", "5", "5"),
    ("previousHeading5", "Previous heading level 5", "shift+5", "shift+5"),
    ("nextHeading6", "Next heading level 6", "6", "6"),
    ("previousHeading6", "Previous heading level 6", "shift+6", "shift+6"),
    ("nextHeading7", "Next heading level 7", "7", "7"),
    ("previousHeading7", "Previous heading level 7", "shift+7", "shift+7"),
    ("nextHeading8", "Next heading level 8", "8", "8"),
    ("previousHeading8", "Previous heading level 8", "shift+8", "shift+8"),
    ("nextHeading9", "Next heading level 9", "9", "9"),
    ("previousHeading9", "Previous heading level 9", "shift+9", "shift+9"),
    ("nextLandmark", "Next landmark", "d", "d"),
    ("previousLandmark", "Previous landmark", "shift+d", "shift+d"),
    ("nextButton", "Next button", "b", "b"),
    ("previousButton", "Previous button", "shift+b", "shift+b"),
    ("nextFormField", "Next form field", "f", "f"),
    ("previousFormField", "Previous form field", "shift+f", "shift+f"),
    ("nextLink", "Next link", "k", "k"),
    ("previousLink", "Previous link", "shift+k", "shift+k"),
    ("nextVisitedLink", "Next visited link", "v", "v"),
    ("previousVisitedLink", "Previous visited link", "shift+v", "shift+v"),
    ("nextUnvisitedLink", "Next unvisited link", "u", "u"),
    ("previousUnvisitedLink", "Previous unvisited link", "shift+u", "shift+u"),
    ("nextList", "Next list", "l", "l"),
    ("previousList", "Previous list", "shift+l", "shift+l"),
    ("nextListItem", "Next list item", "i", "i"),
    ("previousListItem", "Previous list item", "shift+i", "shift+i"),
    ("nextTable", "Next table", "t", "t"),
    ("previousTable", "Previous table", "shift+t", "shift+t"),
    ("nextImage", "Next graphic", "g", "g"),
    ("previousImage", "Previous graphic", "shift+g", "shift+g"),
    ("nextCheckbox", "Next check box", "x", "x"),
    ("previousCheckbox", "Previous check box", "shift+x", "shift+x"),
    ("nextRadioButton", "Next radio button", "r", "r"),
    ("previousRadioButton", "Previous radio button", "shift+r", "shift+r"),
    ("nextCombobox", "Next combo box", "c", "c"),
    ("previousCombobox", "Previous combo box", "shift+c", "shift+c"),
    ("nextEntry", "Next edit field", "e", "e"),
    ("previousEntry", "Previous edit field", "shift+e", "shift+e"),
    ("nextParagraph", "Next text paragraph", "p", "p"),
    ("previousParagraph", "Previous text paragraph", "shift+p", "shift+p"),
    ("nextFrame", "Next frame", "m", "m"),
    ("previousFrame", "Previous frame", "shift+m", "shift+m"),
    ("nextSeparator", "Next separator", "s", "s"),
    ("previousSeparator", "Previous separator", "shift+s", "shift+s"),
    ("nextBlockQuote", "Next block quote", "q", "q"),
    ("previousBlockQuote", "Previous block quote", "shift+q", "shift+q"),
    ("nextEmbeddedObject", "Next embedded object", "o", "o"),
    ("previousEmbeddedObject", "Previous embedded object", "shift+o", "shift+o"),
    ("nextAnnotation", "Next annotation", "a", "a"),
    ("previousAnnotation", "Previous annotation", "shift+a", "shift+a"),
    ("nextSpellingError", "Next spelling or grammar error", "w", "w"),
    (
        "previousSpellingError",
        "Previous spelling or grammar error",
        "shift+w",
        "shift+w",
    ),
    ("nextNotLinkBlock", "Next text after block of links", "n", "n"),
    (
        "previousNotLinkBlock",
        "Previous text after block of links",
        "shift+n",
        "shift+n",
    ),
    ("nextCharacter", "Next character", "rightArrow", "rightArrow"),
    ("previousCharacter", "Previous character", "leftArrow", "leftArrow"),
    ("nextWord", "Next word", "control+rightArrow", "control+rightArrow"),
    ("previousWord", "Previous word", "control+leftArrow", "control+leftArrow"),
    ("nextLine", "Next line", "downArrow", "downArrow"),
    ("previousLine", "Previous line", "upArrow", "upArrow"),
    (
        "nextParagraphText",
        "Next paragraph by text",
        "control+downArrow",
        "control+downArrow",
    ),
    (
        "previousParagraphText",
        "Previous paragraph by text",
        "control+upArrow",
        "control+upArrow",
    ),
    ("documentStart", "Start of document", "control+home", "control+home"),
    ("documentEnd", "End of document", "control+end", "control+end"),
    (
        "moveToContainerStart",
        "Move to start of containing element",
        "shift+,",
        "shift+,",
    ),
    ("movePastContainerEnd", "Move past end of containing element", ",", ","),
    ("refreshBrowseDocument", "Refresh browse-mode document", "NVDA+f5", "NVDA+f5"),
    (
        "exitEmbeddedObject",
        "Exit current embedded object",
        "NVDA+control+space",
        "NVDA+control+space",
    ),
    (
        "toggleNativeSelection",
        "Toggle native selection mode",
        "NVDA+shift+f10",
        "NVDA+shift+f10",
    ),
    (
        "previousTableColumn",
        "Previous table column",
        "control+alt+leftArrow",
        "control+alt+leftArrow",
    ),
    (
        "nextTableColumn",
        "Next table column",
        "control+alt+rightArrow",
        "control+alt+rightArrow",
    ),
    (
        "previousTableRow",
        "Previous table row",
        "control+alt+upArrow",
        "control+alt+upArrow",
    ),
    (
        "nextTableRow",
        "Next table row",
        "control+alt+downArrow",
        "control+alt+downArrow",
    ),
    ("firstTableColumn", "First table column", "control+alt+home", "control+alt+home"),
    ("lastTableColumn", "Last table column", "control+alt+end", "control+alt+end"),
    ("firstTableRow", "First table row", "control+alt+pageUp", "control+alt+pageUp"),
    ("lastTableRow", "Last table row", "control+alt+pageDown", "control+alt+pageDown"),
    ("readCurrent", "Read current location", "NVDA+tab", "NVDA+tab"),
    ("reportDetails", "Report details", "NVDA+d", "NVDA+d"),
    ("sayAll", "Read from current location", "NVDA+downArrow", "NVDA+a"),
    ("reportTitle", "Report window title", "NVDA+t", "NVDA+t"),
    ("readActiveWindow", "Read active window", "NVDA+b", "NVDA+b"),
    (
        "reportShortcutKey",
        "Report focused element shortcut key",
        "shift+numpad2",
        "NVDA+control+shift+.",
    ),
    ("reportCurrentLine", "Report current line", "NVDA+upArrow", "NVDA+l"),
    (
        "reportTextSelection",
        "Report current text selection",
        "NVDA+shift+upArrow",
        "NVDA+shift+s",
    ),
    ("reportTextFormatting", "Report text formatting at caret", "NVDA+f", "NVDA+f"),
    ("reportLinkDestination", "Report link destination", "NVDA+k", "NVDA+k"),
    (
        "sayAllTableColumn",
        "Read table column from current cell",
        "NVDA+control+alt+downArrow",
        "NVDA+control+alt+downArrow",
    ),
    (
        "sayAllTableRow",
        "Read table row from current cell",
        "NVDA+control+alt+rightArrow",
        "NVDA+control+alt+rightArrow",
    ),
    (
        "readTableColumn",
        "Read complete table column",
        "NVDA+control+alt+upArrow",
        "NVDA+control+alt+upArrow",
    ),
    (
        "readTableRow",
        "Read complete table row",
        "NVDA+control+alt+leftArrow",
        "NVDA+control+alt+leftArrow",
    ),
    (
        "reportCurrentObject",
        "Report current navigator object",
        "NVDA+numpad5",
        "NVDA+shift+o",
    ),
    (
        "moveToContainingObject",
        "Move to containing object",
        "NVDA+numpad8",
        "NVDA+shift+upArrow",
    ),
    (
        "moveToPreviousObject",
        "Move to previous sibling object",
        "NVDA+numpad4",
        "NVDA+shift+leftArrow",
    ),
    (
        "moveToPreviousObjectFlat",
        "Move to previous object in flattened view",
        "NVDA+numpad9",
        "NVDA+shift+[",
    ),
    (
        "moveToNextObject",
        "Move to next sibling object",
        "NVDA+numpad6",
        "NVDA+shift+rightArrow",
    ),
    (
        "moveToNextObjectFlat",
        "Move to next object in flattened view",
        "NVDA+numpad3",
        "NVDA+shift+]",
    ),
    (
        "moveToFirstContainedObject",
        "Move to first contained object",
        "NVDA+numpad2",
        "NVDA+shift+downArrow",
    ),
    (
        "moveToFocusObject",
        "Move navigator object to focus",
        "NVDA+numpadMinus",
        "NVDA+backspace",
    ),
    (
        "activateNavigatorObject",
        "Activate navigator object",
        "NVDA+numpadEnter",
        "NVDA+enter",
    ),
    (
        "moveFocusToReviewPosition",
        "Move focus to review position",
        "NVDA+shift+numpadMinus",
        "NVDA+shift+backspace",
    ),
    (
        "reportReviewLocation",
        "Report review cursor location",
        "NVDA+shift+numpadDelete",
        "NVDA+shift+delete",
    ),
    (
        "reviewTopLine",
        "Move review cursor to top line",
        "shift+numpad7",
        "NVDA+control+home",
    ),
    (
        "reviewPreviousLine",
        "Move review cursor to previous line",
        "numpad7",
        "NVDA+upArrow",
    ),
    ("reviewCurrentLine", "Report current review line", "numpad8", "NVDA+shift+."),
    ("reviewNextLine", "Move review cursor to next line", "numpad9", "NVDA+downArrow"),
    (
        "reviewBottomLine",
        "Move review cursor to bottom line",
        "shift+numpad9",
        "NVDA+control+end",
    ),
    (
        "reviewPreviousWord",
        "Move review cursor to previous word",
        "numpad4",
        "NVDA+control+leftArrow",
    ),
    ("reviewCurrentWord", "Report current review word", "numpad5", "NVDA+control+."),
    (
        "reviewNextWord",
        "Move review cursor to next word",
        "numpad6",
        "NVDA+control+rightArrow",
    ),
    (
        "reviewLineStart",
        "Move review cursor to line start",
        "shift+numpad1",
        "NVDA+home",
    ),
    (
        "reviewPreviousCharacter",
        "Move review cursor to previous character",
        "numpad1",
        "NVDA+leftArrow",
    ),
    ("reviewCurrentCharacter", "Report current review character", "numpad2", "NVDA+."),
    (
        "reviewNextCharacter",
        "Move review cursor to next character",
        "numpad3",
        "NVDA+rightArrow",
    ),
    ("reviewLineEnd", "Move review cursor to line end", "shift+numpad3", "NVDA+end"),
    (
        "reviewPreviousPage",
        "Move review cursor to previous page",
        "NVDA+pageUp",
        "NVDA+shift+pageUp",
    ),
    (
        "reviewNextPage",
        "Move review cursor to next page",
        "NVDA+pageDown",
        "NVDA+shift+pageDown",
    ),
    (
        "reviewSelectionStart",
        "Move review cursor to selection start",
        "NVDA+alt+home",
        "NVDA+alt+home",
    ),
    (
        "reviewSelectionEnd",
        "Move review cursor to selection end",
        "NVDA+alt+end",
        "NVDA+alt+end",
    ),
    ("sayAllReview", "Read from review cursor", "numpadPlus", "NVDA+shift+a"),
    ("setReviewCopyStart", "Mark review copy start", "NVDA+f9", "NVDA+f9"),
    (
        "copyToReviewPosition",
        "Select text through review position",
        "NVDA+f10",
        "NVDA+f10",
    ),
    (
        "moveToReviewCopyStart",
        "Move review cursor to copy start",
        "NVDA+shift+f9",
        "NVDA+shift+f9",
    ),
    (
        "reportReviewFormatting",
        "Report formatting at review cursor",
        "NVDA+shift+f",
        "NVDA+shift+f",
    ),
    ("nextReviewMode", "Switch to next review mode", "NVDA+numpad7", "NVDA+pageUp"),
    (
        "previousReviewMode",
        "Switch to previous review mode",
        "NVDA+numpad1",
        "NVDA+pageDown",
    ),
    ("leftMouseClick", "Click left mouse button", "numpadDivide", "NVDA+["),
    (
        "leftMouseLock",
        "Toggle left mouse button lock",
        "shift+numpadDivide",
        "NVDA+control+[",
    ),
    ("rightMouseClick", "Click right mouse button", "numpadMultiply", "NVDA+]"),
    (
        "rightMouseLock",
        "Toggle right mouse button lock",
        "shift+numpadMultiply",
        "NVDA+control+]",
    ),
    (
        "moveMouseToNavigatorObject",
        "Move mouse to navigator object",
        "NVDA+numpadDivide",
        "NVDA+shift+m",
    ),
    (
        "moveNavigatorToMouseObject",
        "Move navigator object to mouse object",
        "NVDA+numpadMultiply",
        "NVDA+shift+n",
    ),
    ("cycleSpeechMode", "Cycle speech mode", "NVDA+s", "NVDA+s"),
    (
        "brailleToggleTether",
        "Toggle braille tether",
        "NVDA+control+t",
        "NVDA+control+t",
    ),
    ("toggleFocusMode", "Toggle browse or focus mode", "NVDA+space", "NVDA+space"),
    (
        "toggleSingleLetterNavigation",
        "Toggle single letter navigation",
        "NVDA+shift+space",
        "NVDA+shift+space",
    ),
    ("elementsList", "Elements list", "NVDA+f7", "NVDA+f7"),
    ("find", "Find", "NVDA+control+f", "NVDA+control+f"),
    ("findNext", "Find next", "NVDA+f3", "NVDA+f3"),
    ("findPrevious", "Find previous", "NVDA+shift+f3", "NVDA+shift+f3"),
)
COMMAND_BY_ID = {item[0]: item for item in COMMANDS}

# NVDA exposes these browser quick-navigation scripts in Input Gestures, but
# deliberately assigns no default keys. Invoke the real tree-interceptor
# scripts instead of inventing global keyboard bindings that could collide
# with application shortcuts. The protocol reports this as structured
# delivery, while speech and braille still come from NVDA's presentation path.
DIRECT_COMMANDS = (
    ("nextArticle", "Next article", "nextArticle"),
    ("previousArticle", "Previous article", "previousArticle"),
    ("nextFigure", "Next figure", "nextFigure"),
    ("previousFigure", "Previous figure", "previousFigure"),
    ("nextGrouping", "Next grouping", "nextGrouping"),
    ("previousGrouping", "Previous grouping", "previousGrouping"),
    ("nextTab", "Next tab", "nextTab"),
    ("previousTab", "Previous tab", "previousTab"),
    ("nextMenuItem", "Next menu item", "nextMenuItem"),
    ("previousMenuItem", "Previous menu item", "previousMenuItem"),
    ("nextToggleButton", "Next toggle button", "nextToggleButton"),
    ("previousToggleButton", "Previous toggle button", "previousToggleButton"),
    ("nextProgressBar", "Next progress bar", "nextProgressBar"),
    ("previousProgressBar", "Previous progress bar", "previousProgressBar"),
    ("nextReference", "Next reference", "nextReference"),
    ("previousReference", "Previous reference", "previousReference"),
    ("nextMathFormula", "Next math formula", "nextMath"),
    ("previousMathFormula", "Previous math formula", "previousMath"),
    (
        "nextVerticalParagraph",
        "Next vertically aligned paragraph",
        "nextVerticalParagraph",
    ),
    (
        "previousVerticalParagraph",
        "Previous vertically aligned paragraph",
        "previousVerticalParagraph",
    ),
    ("nextSameStyle", "Next same style text", "nextSameStyle"),
    ("previousSameStyle", "Previous same style text", "previousSameStyle"),
    ("nextDifferentStyle", "Next different style text", "nextDifferentStyle"),
    (
        "previousDifferentStyle",
        "Previous different style text",
        "previousDifferentStyle",
    ),
)
DIRECT_COMMAND_BY_ID = {item[0]: item for item in DIRECT_COMMANDS}
DIRECT_GLOBAL_COMMANDS = (
    ("reportLanguage", "Report language at caret", "reportCaretLanguage"),
    ("reportCaretLocation", "Report caret location", "reportCaretLocation"),
)
DIRECT_GLOBAL_COMMAND_BY_ID = {item[0]: item for item in DIRECT_GLOBAL_COMMANDS}
DIRECT_BRAILLE_COMMANDS = (
    ("braillePanBack", "Pan braille display back", "braille_scrollBack"),
    ("braillePanForward", "Pan braille display forward", "braille_scrollForward"),
    (
        "braillePreviousLine",
        "Move braille display to previous line",
        "braille_previousLine",
    ),
    ("brailleNextLine", "Move braille display to next line", "braille_nextLine"),
    ("brailleRoute", "Route braille cell", "braille_routeTo"),
    (
        "brailleReportFormatting",
        "Report formatting at braille cell",
        "braille_reportFormatting",
    ),
)
DIRECT_BRAILLE_COMMAND_BY_ID = {item[0]: item for item in DIRECT_BRAILLE_COMMANDS}
DIRECT_SPEECH_COMMANDS = (
    ("stopSpeech", "Stop speech", "stop"),
    ("pauseSpeech", "Pause or resume speech", "pause"),
)
DIRECT_SPEECH_COMMAND_BY_ID = {item[0]: item for item in DIRECT_SPEECH_COMMANDS}
PRESENTATION_BOOLEAN_SETTINGS = {
    "reportKeyboardShortcuts": ("presentation", "reportKeyboardShortcuts"),
    "reportObjectPositionInformation": (
        "presentation",
        "reportObjectPositionInformation",
    ),
    "reportObjectDescriptions": ("presentation", "reportObjectDescriptions"),
    "reportDynamicContentChanges": ("presentation", "reportDynamicContentChanges"),
    "reportAriaDescription": ("annotations", "reportAriaDescription"),
    "reportDetails": ("annotations", "reportDetails"),
    "reportFontName": ("documentFormatting", "reportFontName"),
    "reportFontSize": ("documentFormatting", "reportFontSize"),
    "reportColor": ("documentFormatting", "reportColor"),
    "reportStyle": ("documentFormatting", "reportStyle"),
    "reportTables": ("documentFormatting", "reportTables"),
    "includeLayoutTables": ("documentFormatting", "includeLayoutTables"),
    "reportTableCellCoordinates": ("documentFormatting", "reportTableCellCoords"),
    "reportLinks": ("documentFormatting", "reportLinks"),
    "reportLinkType": ("documentFormatting", "reportLinkType"),
    "reportGraphics": ("documentFormatting", "reportGraphics"),
    "reportComments": ("documentFormatting", "reportComments"),
    "reportBookmarks": ("documentFormatting", "reportBookmarks"),
    "reportLists": ("documentFormatting", "reportLists"),
    "reportHeadings": ("documentFormatting", "reportHeadings"),
    "reportBlockQuotes": ("documentFormatting", "reportBlockQuotes"),
    "reportGroupings": ("documentFormatting", "reportGroupings"),
    "reportLandmarks": ("documentFormatting", "reportLandmarks"),
    "reportArticles": ("documentFormatting", "reportArticles"),
    "reportFrames": ("documentFormatting", "reportFrames"),
    "reportFigures": ("documentFormatting", "reportFigures"),
    "reportClickable": ("documentFormatting", "reportClickable"),
}
SYMBOL_LEVELS = {"none": 0, "some": 100, "most": 200, "all": 300, "character": 1000}
FONT_ATTRIBUTE_REPORTING = {"off": 0, "speech": 1, "braille": 2, "speechAndBraille": 3}
TABLE_HEADER_REPORTING = {"off": 0, "rowsAndColumns": 1, "rows": 2, "columns": 3}
SPELLING_ERROR_CHANNELS = {"speech": 1, "sound": 2, "braille": 4}
PRESENTATION_SETTING_KEYS = frozenset(PRESENTATION_BOOLEAN_SETTINGS) | {
    "speechSymbolLevel",
    "brailleTether",
    "fontAttributeReporting",
    "reportSpellingErrors",
    "reportTableHeaders",
}
ALL_COMMAND_IDS = (
    frozenset(COMMAND_BY_ID)
    | frozenset(DIRECT_COMMAND_BY_ID)
    | frozenset(DIRECT_GLOBAL_COMMAND_BY_ID)
    | frozenset(DIRECT_BRAILLE_COMMAND_BY_ID)
    | frozenset(DIRECT_SPEECH_COMMAND_BY_ID)
)
PROVENANCE_BY_KIND = {
    "speech": "screenReaderOutput",
    "braille": "screenReaderOutput",
    "focus": "screenReaderEvent",
    "mode": "screenReaderEvent",
    "liveRegion": "screenReaderEvent",
    "audio": "synthesizedAudio",
    "commandStarted": "adapterLifecycle",
    "commandSettled": "adapterLifecycle",
}


class OracleState:
    def __init__(self):
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.operation_lock = threading.Lock()
        self.sequence = 0
        self.events = []
        self.last_event_at = time.monotonic()
        self.active_session = None
        self.finished = {}
        self.command = "event"
        self.ready = False
        self.locale = "en-US"
        self.keyboard_layout = "desktop"
        self.live_region_context = None
        self.speech_paused = False

    def append(self, kind, text="", **fields):
        with self.condition:
            self.sequence += 1
            event = {
                "sequence": self.sequence,
                "monotonicNs": time.monotonic_ns(),
                "kind": kind,
                "causalCommand": self.command,
                "text": text or "",
                "provenance": fields.pop(
                    "provenance", PROVENANCE_BY_KIND.get(kind, "adapterLifecycle")
                ),
            }
            event.update(fields)
            self.events.append(event)
            if len(self.events) > MAX_EVENTS:
                del self.events[: len(self.events) - MAX_EVENTS]
            self.last_event_at = time.monotonic()
            self.condition.notify_all()
            return event

    def since(self, sequence):
        if self.events and sequence < self.events[0]["sequence"] - 1:
            raise RuntimeError("screen-reader event history was truncated")
        return [event.copy() for event in self.events if event["sequence"] > sequence]


STATE = OracleState()


def call_on_main(function, timeout=10.0):
    completed = threading.Event()
    result = {}

    def invoke():
        try:
            result["value"] = function()
        except BaseException as error:
            result["error"] = error
        finally:
            completed.set()

    queueHandler.queueFunction(queueHandler.eventQueue, invoke)
    if not completed.wait(timeout):
        raise TimeoutError("NVDA main thread did not process request")
    if "error" in result:
        raise result["error"]
    return result.get("value")


def emulate(gesture_name):
    def invoke():
        gesture = KeyboardInputGesture.fromName(gesture_name)
        inputCore.manager.emulateGesture(gesture)

    call_on_main(invoke)


def invoke_browse_mode_script(script_name):
    def invoke():
        focus = api.getFocusObject()
        interceptor = getattr(focus, "treeInterceptor", None)
        if interceptor is None:
            raise RuntimeError("NVDA browse-mode interceptor is unavailable")
        script = getattr(interceptor, "script_" + script_name, None)
        if not callable(script):
            raise RuntimeError("NVDA browse-mode script is unavailable")
        script(None)

    call_on_main(invoke)


def invoke_global_command_script(script_name):
    def invoke():
        script = getattr(globalCommands.commands, "script_" + script_name, None)
        if not callable(script):
            raise RuntimeError("NVDA global command script is unavailable")
        script(None)

    call_on_main(invoke)


class RoutingGesture:
    def __init__(self, routing_index):
        self.routingIndex = routing_index


def invoke_braille_command_script(script_name, routing_index=0):
    def invoke():
        script = getattr(globalCommands.commands, "script_" + script_name, None)
        if not callable(script):
            raise RuntimeError("NVDA braille command script is unavailable")
        gesture = (
            RoutingGesture(routing_index)
            if script_name
            in (
                "braille_routeTo",
                "braille_reportFormatting",
            )
            else None
        )
        script(gesture)

    call_on_main(invoke)


def invoke_speech_control(kind):
    def invoke():
        if kind == "stop":
            speech.cancelSpeech()
            with STATE.lock:
                STATE.speech_paused = False
            return
        if kind == "pause":
            with STATE.lock:
                STATE.speech_paused = not STATE.speech_paused
                paused = STATE.speech_paused
            speech.pauseSpeech(paused)
            return
        raise RuntimeError("unknown speech control")

    call_on_main(invoke)


def configure_session(locale, keyboard_layout):
    expected_language = "de" if locale == "de-DE" else "en"

    def apply_configuration():
        active_language = languageHandler.normalizeLanguage(
            languageHandler.getLanguage()
        )
        if not active_language or active_language.split("_")[0] != expected_language:
            raise RuntimeError(
                "NVDA process language does not match requested session locale"
            )
        config.conf["keyboard"]["keyboardLayout"] = keyboard_layout
        config.conf["keyboard"]["NVDAModifierKeys"] = 7

    call_on_main(apply_configuration)
    with STATE.lock:
        STATE.locale = locale
        STATE.keyboard_layout = keyboard_layout


def current_focus_is_protected():
    try:
        return bool(getattr(api.getFocusObject(), "isProtected", False))
    except Exception:
        return False


def read_presentation_settings():
    def read():
        settings = {
            name: bool(config.conf[section][key])
            for name, (section, key) in PRESENTATION_BOOLEAN_SETTINGS.items()
        }
        settings["speechSymbolLevel"] = next(
            (
                name
                for name, value in SYMBOL_LEVELS.items()
                if value == config.conf["speech"]["symbolLevel"]
            ),
            "some",
        )
        settings["brailleTether"] = config.conf["braille"]["tetherTo"]
        settings["fontAttributeReporting"] = next(
            (
                name
                for name, value in FONT_ATTRIBUTE_REPORTING.items()
                if value == config.conf["documentFormatting"]["fontAttributeReporting"]
            ),
            "off",
        )
        spelling = int(config.conf["documentFormatting"]["reportSpellingErrors2"])
        settings["reportSpellingErrors"] = [
            name for name, bit in SPELLING_ERROR_CHANNELS.items() if spelling & bit
        ]
        settings["reportTableHeaders"] = next(
            (
                name
                for name, value in TABLE_HEADER_REPORTING.items()
                if value == config.conf["documentFormatting"]["reportTableHeaders"]
            ),
            "rowsAndColumns",
        )
        return settings

    return call_on_main(read)


def validate_presentation_settings(settings):
    if not isinstance(settings, dict) or set(settings) != PRESENTATION_SETTING_KEYS:
        raise ValueError("presentation settings fields are invalid")
    if any(type(settings[name]) is not bool for name in PRESENTATION_BOOLEAN_SETTINGS):
        raise ValueError("presentation setting flags must be boolean")
    if settings["speechSymbolLevel"] not in SYMBOL_LEVELS:
        raise ValueError("speechSymbolLevel is invalid")
    if settings["brailleTether"] not in ("auto", "focus", "review"):
        raise ValueError("brailleTether is invalid")
    if settings["fontAttributeReporting"] not in FONT_ATTRIBUTE_REPORTING:
        raise ValueError("fontAttributeReporting is invalid")
    if settings["reportTableHeaders"] not in TABLE_HEADER_REPORTING:
        raise ValueError("reportTableHeaders is invalid")
    channels = settings["reportSpellingErrors"]
    if (
        not isinstance(channels, list)
        or len(channels) != len(set(channels))
        or any(channel not in SPELLING_ERROR_CHANNELS for channel in channels)
    ):
        raise ValueError("reportSpellingErrors is invalid")


def apply_presentation_settings(settings):
    validate_presentation_settings(settings)

    def apply():
        for name, (section, key) in PRESENTATION_BOOLEAN_SETTINGS.items():
            config.conf[section][key] = settings[name]
        config.conf["speech"]["symbolLevel"] = SYMBOL_LEVELS[
            settings["speechSymbolLevel"]
        ]
        if settings["brailleTether"] == "auto":
            config.conf["braille"]["tetherTo"] = "auto"
            # setTether expects the effective tether, not the configured
            # "auto" sentinel. Re-enter automatic mode from focus so the live
            # handler cannot remain stuck on review after a session reset.
            braille.handler.setTether("focus", auto=True)
        else:
            braille.handler.setTether(settings["brailleTether"], auto=False)
        config.conf["documentFormatting"]["fontAttributeReporting"] = (
            FONT_ATTRIBUTE_REPORTING[settings["fontAttributeReporting"]]
        )
        config.conf["documentFormatting"]["reportSpellingErrors2"] = sum(
            SPELLING_ERROR_CHANNELS[channel]
            for channel in settings["reportSpellingErrors"]
        )
        config.conf["documentFormatting"]["reportTableHeaders"] = (
            TABLE_HEADER_REPORTING[settings["reportTableHeaders"]]
        )

    call_on_main(apply)
    return read_presentation_settings()


def current_state():
    def inspect():
        focus = api.getFocusObject()
        navigator = api.getNavigatorObject()
        review_position = api.getReviewPosition()
        review_object = getattr(review_position, "obj", None)
        mouse_x, mouse_y = winUser.getCursorPos()

        def object_state(obj):
            if obj is None:
                return None
            protected = bool(getattr(obj, "isProtected", False))
            role = getattr(obj, "role", None)
            role_name = getattr(role, "displayString", None) or getattr(
                role, "name", None
            )
            try:
                left, top, width, height = obj.location
                location = {
                    "left": int(left),
                    "top": int(top),
                    "width": int(width),
                    "height": int(height),
                }
            except Exception:
                location = None
            object_name = "" if protected else str(getattr(obj, "name", "") or "")
            identity = "\x1f".join(
                str(value or "")
                for value in (
                    type(obj).__name__,
                    getattr(getattr(obj, "appModule", None), "appName", ""),
                    getattr(obj, "windowHandle", ""),
                    getattr(obj, "IAccessibleChildID", ""),
                    role_name,
                    object_name,
                    location,
                )
            )
            return {
                "id": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32],
                "role": str(role_name) if role_name else None,
                "name": object_name or None,
                "location": location,
                **({"redacted": True} if protected else {}),
            }

        app_name = getattr(getattr(focus, "appModule", None), "appName", "") or ""
        interceptor = getattr(focus, "treeInterceptor", None)
        role = getattr(focus, "role", None)
        role_name = getattr(role, "displayString", None) or getattr(role, "name", None)
        focus_protected = bool(getattr(focus, "isProtected", False))
        mode = (
            "focus"
            if interceptor is not None
            and bool(getattr(interceptor, "passThrough", False))
            else "browse"
        )
        return {
            "browserWindowActive": app_name.lower() in ("chrome", "msedge"),
            "webContentFocused": interceptor is not None,
            "cursorInDocument": interceptor is not None,
            "cursor": {"mode": mode},
            "focus": {
                "role": str(role_name) if role_name else None,
                "name": None
                if focus_protected
                else str(getattr(focus, "name", "") or "") or None,
                **({"redacted": True} if focus_protected else {}),
            },
            "navigator": object_state(navigator),
            "review": object_state(review_object),
            "mouse": {
                "x": int(mouse_x),
                "y": int(mouse_y),
                "object": object_state(api.getMouseObject()),
            },
            "speechMode": speech.getState().speechMode.name,
            "speechPaused": STATE.speech_paused,
        }

    value = call_on_main(inspect)
    with STATE.lock:
        value["lastSequence"] = STATE.sequence
    return value


def execute_action(command, argument):
    definition = (
        COMMAND_BY_ID.get(command)
        or DIRECT_COMMAND_BY_ID.get(command)
        or DIRECT_GLOBAL_COMMAND_BY_ID.get(command)
        or DIRECT_BRAILLE_COMMAND_BY_ID.get(command)
        or DIRECT_SPEECH_COMMAND_BY_ID[command]
    )
    with STATE.lock:
        before = STATE.sequence
        STATE.command = command
        layout = STATE.keyboard_layout
    STATE.append("commandStarted", definition[1])
    try:
        direct_browse = command in DIRECT_COMMAND_BY_ID
        direct_global = command in DIRECT_GLOBAL_COMMAND_BY_ID
        direct_braille = command in DIRECT_BRAILLE_COMMAND_BY_ID
        direct_speech = command in DIRECT_SPEECH_COMMAND_BY_ID
        direct = direct_browse or direct_global or direct_braille or direct_speech
        if direct_browse:
            script_name = DIRECT_COMMAND_BY_ID[command][2]
            gesture = "script:" + script_name
            invoke_browse_mode_script(script_name)
        elif direct_global:
            script_name = DIRECT_GLOBAL_COMMAND_BY_ID[command][2]
            gesture = "script:" + script_name
            invoke_global_command_script(script_name)
        elif direct_braille:
            script_name = DIRECT_BRAILLE_COMMAND_BY_ID[command][2]
            gesture = "script:" + script_name
            invoke_braille_command_script(script_name, int(argument or "0"))
        elif direct_speech:
            kind = DIRECT_SPEECH_COMMAND_BY_ID[command][2]
            gesture = "speech:" + kind
            invoke_speech_control(kind)
        else:
            gesture = definition[3] if layout == "laptop" else definition[2]
            emulate(gesture)
        if command == "find":
            time.sleep(0.35)
            call_on_main(lambda: api.copyToClip(argument, notify=False))
            emulate("control+v")
            emulate("enter")
        quiet_deadline = time.monotonic() + 0.45
        hard_deadline = time.monotonic() + 12.0
        timed_out = False
        while time.monotonic() < hard_deadline:
            with STATE.condition:
                quiet_deadline = max(quiet_deadline, STATE.last_event_at + 0.45)
                remaining = min(quiet_deadline, hard_deadline) - time.monotonic()
                if remaining <= 0:
                    timed_out = time.monotonic() >= hard_deadline
                    break
                STATE.condition.wait(remaining)
        if time.monotonic() >= hard_deadline and time.monotonic() < quiet_deadline:
            timed_out = True
        STATE.append("commandSettled", reason="timeout" if timed_out else "completed")
        with STATE.lock:
            cursor = STATE.sequence
            events = [
                event
                for event in STATE.since(before)
                if event.get("causalCommand") == command
            ]
        return {
            "command": command,
            "gesture": gesture,
            "delivery": "structured" if command == "find" or direct else "emulated",
            "beforeSequence": before,
            "cursor": cursor,
            "timedOut": timed_out,
            "events": events,
            "state": current_state(),
        }
    except BaseException as error:
        STATE.append("commandSettled", reason="failed", error=type(error).__name__)
        raise
    finally:
        with STATE.lock:
            STATE.command = "event"


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class CdpProxyHandler(BaseRequestHandler):
    def handle(self):
        try:
            upstream = socket.create_connection(("127.0.0.1", 9223), timeout=3.0)
        except OSError:
            return
        sockets = (self.request, upstream)
        peers = {self.request: upstream, upstream: self.request}
        pending = {self.request: bytearray(), upstream: bytearray()}
        try:
            for endpoint in sockets:
                endpoint.setblocking(False)
            while True:
                readable_candidates = [
                    endpoint
                    for endpoint in sockets
                    if len(pending[peers[endpoint]]) < 1024 * 1024
                ]
                writable_candidates = [
                    endpoint for endpoint in sockets if pending[endpoint]
                ]
                readable, writable, exceptional = select.select(
                    readable_candidates, writable_candidates, sockets, 30.0
                )
                if exceptional or (not readable and not writable):
                    if exceptional:
                        break
                    continue
                for source in readable:
                    try:
                        data = source.recv(65536)
                    except OSError:
                        return
                    if not data:
                        return
                    pending[peers[source]].extend(data)
                for target in writable:
                    try:
                        sent = target.send(pending[target])
                    except OSError:
                        return
                    if sent <= 0:
                        return
                    del pending[target][:sent]
        finally:
            try:
                upstream.close()
            except OSError:
                pass


class ThreadingTCPServer(ThreadingMixIn, TCPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "HooSaidThatNVDA/2.0"

    def log_message(self, format_string, *args):
        log.debug("HooSaidThat control: " + format_string, *args)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        try:
            if not self.authorized():
                return self.json_response(401, {"error": "unauthorized"})
            parsed = urlsplit(self.path)
            path = parsed.path
            if method == "GET" and path == "/v2/health":
                with STATE.lock:
                    return self.json_response(
                        200,
                        {
                            "status": "ok",
                            "protocolVersion": "2.0",
                            "screenReader": "nvda",
                            "version": getattr(versionInfo, "version", NVDA_VERSION),
                            "profile": PROFILE,
                            "locale": STATE.locale,
                            "keyboardLayout": STATE.keyboard_layout,
                            "ready": STATE.ready,
                            "captureBoundary": "nvda-presentation-hooks",
                            "browser": {
                                "name": "chrome",
                                "version": CHROME_VERSION,
                                "cdpPort": 9222,
                            },
                        },
                    )
            if method == "GET" and path == "/v2/actions":
                with STATE.lock:
                    layout = STATE.keyboard_layout
                return self.json_response(
                    200,
                    {
                        "profile": PROFILE,
                        "keyboardLayout": layout,
                        "commands": [
                            {
                                "id": item[0],
                                "label": item[1],
                                "desktopGestures": [item[2]],
                                "laptopGestures": [item[3]],
                                "delivery": "emulated",
                            }
                            for item in COMMANDS
                        ]
                        + [
                            {
                                "id": item[0],
                                "label": item[1],
                                "desktopGestures": [],
                                "laptopGestures": [],
                                "delivery": "structured",
                                "script": item[2],
                            }
                            for item in DIRECT_COMMANDS
                            + DIRECT_GLOBAL_COMMANDS
                            + DIRECT_BRAILLE_COMMANDS
                            + DIRECT_SPEECH_COMMANDS
                        ],
                    },
                )
            if method == "POST" and path == "/v2/sessions":
                return self.create_session()
            match = re.fullmatch(
                r"/v2/sessions/([0-9a-f]{32})/settings(?:/(reset))?",
                path,
            )
            if match:
                session_id, reset = match.groups()
                if method == "GET" and reset is None:
                    self.require_session(session_id)
                    return self.json_response(200, read_presentation_settings())
                if method == "POST" and reset is None:
                    return self.set_presentation_settings(session_id)
                if method == "POST" and reset == "reset":
                    return self.reset_presentation_settings(session_id)
            match = re.fullmatch(
                r"/v2/sessions/([0-9a-f]{32})/(state|actions|events|finish)", path
            )
            if match:
                session_id, operation = match.groups()
                if operation == "state" and method == "GET":
                    self.require_session(session_id)
                    return self.json_response(200, current_state())
                if operation == "actions" and method == "POST":
                    return self.action(session_id)
                if operation == "events" and method == "GET":
                    return self.events(session_id, parsed.query)
                if operation == "finish" and method == "POST":
                    return self.finish_session(session_id)
            match = re.fullmatch(
                r"/v2/sessions/([0-9a-f]{32})/artifacts/(screenreader-events)", path
            )
            if match and method == "GET":
                return self.artifact(match.group(1), match.group(2))
            return self.json_response(404, {"error": "not-found"})
        except ValueError as error:
            return self.json_response(400, {"error": str(error)[:500]})
        except PermissionError as error:
            return self.json_response(409, {"error": str(error)[:500]})
        except Exception as error:
            log.exception("HooSaidThat NVDA control request failed")
            return self.json_response(500, {"error": type(error).__name__})

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.control_token
        return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("invalid content length")
        if length < 2 or length > 1024 * 1024:
            raise ValueError("request body must contain 2 to 1048576 bytes")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            raise ValueError("request body must be UTF-8 JSON")
        if not isinstance(value, dict):
            raise ValueError("request body must be an object")
        return value

    def create_session(self):
        if not STATE.operation_lock.acquire(False):
            raise PermissionError("another session operation is active")
        try:
            return self._create_session()
        finally:
            STATE.operation_lock.release()

    def _create_session(self):
        body = self.read_json()
        allowed = {"testId", "recording", "profile", "locale", "keyboardLayout"}
        if set(body) != allowed:
            raise ValueError("session request fields are invalid")
        test_id = body.get("testId")
        if not isinstance(test_id, str) or not 1 <= len(test_id.encode("utf-8")) <= 500:
            raise ValueError("testId must contain 1 to 500 bytes")
        if not isinstance(body.get("recording"), bool):
            raise ValueError("recording must be boolean")
        if body.get("profile") != PROFILE:
            raise ValueError("unsupported profile")
        if body.get("locale") not in ("en-US", "de-DE"):
            raise ValueError("unsupported locale")
        if body.get("keyboardLayout") not in ("desktop", "laptop"):
            raise ValueError("unsupported keyboard layout")
        with STATE.lock:
            if STATE.active_session is not None:
                raise PermissionError("another test session is active")
        configure_session(body["locale"], body["keyboardLayout"])
        baseline_settings = read_presentation_settings()
        with STATE.lock:
            session_id = uuid.uuid4().hex
            STATE.active_session = {
                "id": session_id,
                "testId": test_id,
                "recording": body["recording"],
                "startSequence": STATE.sequence,
                "locale": body["locale"],
                "keyboardLayout": body["keyboardLayout"],
                "baselineSettings": baseline_settings,
            }
            session = STATE.active_session.copy()
        return self.json_response(201, session)

    def require_session(self, session_id):
        with STATE.lock:
            if STATE.active_session is None or STATE.active_session["id"] != session_id:
                raise PermissionError("session is not active")
            return STATE.active_session.copy()

    def action(self, session_id):
        if not STATE.operation_lock.acquire(False):
            raise PermissionError("another session operation is active")
        try:
            self.require_session(session_id)
            body = self.read_json()
            if set(body) - {"command", "argument"}:
                raise ValueError("action request fields are invalid")
            command = body.get("command")
            if command not in ALL_COMMAND_IDS:
                raise ValueError("unsupported command")
            argument = body.get("argument")
            if command == "find":
                if (
                    not isinstance(argument, str)
                    or not 1 <= len(argument.encode("utf-8")) <= 500
                ):
                    raise ValueError("find argument must contain 1 to 500 bytes")
            elif command in ("brailleRoute", "brailleReportFormatting"):
                if argument is not None and (
                    not isinstance(argument, str)
                    or not re.fullmatch(r"\d{1,3}", argument)
                    or int(argument) > 199
                ):
                    raise ValueError("braille cell must be an integer from 0 to 199")
            elif "argument" in body:
                raise ValueError("action does not accept an argument")
            return self.json_response(200, execute_action(command, argument))
        finally:
            STATE.operation_lock.release()

    def set_presentation_settings(self, session_id):
        if not STATE.operation_lock.acquire(False):
            raise PermissionError("another session operation is active")
        try:
            self.require_session(session_id)
            settings = apply_presentation_settings(self.read_json())
            return self.json_response(200, settings)
        finally:
            STATE.operation_lock.release()

    def reset_presentation_settings(self, session_id):
        if not STATE.operation_lock.acquire(False):
            raise PermissionError("another session operation is active")
        try:
            session = self.require_session(session_id)
            body = self.read_json()
            if body:
                raise ValueError("settings reset request must be empty")
            settings = apply_presentation_settings(session["baselineSettings"])
            return self.json_response(200, settings)
        finally:
            STATE.operation_lock.release()

    def events(self, session_id, query):
        self.require_session(session_id)
        values = parse_qs(query, keep_blank_values=True)
        if set(values) != {"after", "timeoutMs", "quietMs"}:
            raise ValueError("events query fields are invalid")
        try:
            after = int(values["after"][0])
            timeout_ms = int(values["timeoutMs"][0])
            quiet_ms = int(values["quietMs"][0])
        except (ValueError, KeyError, IndexError):
            raise ValueError("events query values are invalid")
        if after < 0 or not 1 <= timeout_ms <= 30000 or not 1 <= quiet_ms <= 5000:
            raise ValueError("events query values are out of range")
        deadline = time.monotonic() + timeout_ms / 1000.0
        timed_out = False
        with STATE.condition:
            while True:
                found = STATE.since(after)
                quiet = time.monotonic() - STATE.last_event_at >= quiet_ms / 1000.0
                if found and quiet:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                STATE.condition.wait(min(remaining, quiet_ms / 1000.0))
            cursor = STATE.sequence
            found = STATE.since(after)
        return self.json_response(
            200, {"cursor": cursor, "timedOut": timed_out, "events": found}
        )

    def finish_session(self, session_id):
        if not STATE.operation_lock.acquire(False):
            raise PermissionError("another session operation is active")
        session = None
        try:
            body = self.read_json()
            if body:
                raise ValueError("finish request must be empty")
            with STATE.lock:
                completed = STATE.finished.get(session_id)
            if completed is not None:
                return self.json_response(200, completed["result"])
            session = self.require_session(session_id)
            active_settings = read_presentation_settings()
            apply_presentation_settings(session["baselineSettings"])
            with STATE.lock:
                evidence = {
                    "schemaVersion": 1,
                    "captureBoundary": "NVDA processed speech queue and braille pre-write hooks",
                    "acousticEvidence": False,
                    "screenReader": {"name": "nvda", "version": NVDA_VERSION},
                    "profile": PROFILE,
                    "locale": session["locale"],
                    "keyboardLayout": session["keyboardLayout"],
                    "presentationSettings": active_settings,
                    "events": STATE.since(session["startSequence"]),
                }
                content = (
                    json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))
                    + "\n"
                ).encode("utf-8")
                digest = hashlib.sha256(content).hexdigest()
                cursor = STATE.sequence
                result = {
                    "sessionId": session_id,
                    "cursor": cursor,
                    "artifacts": [
                        {
                            "name": "screenreader-events",
                            "contentType": "application/json",
                            "bytes": len(content),
                            "sha256": digest,
                        }
                    ],
                }
                STATE.finished[session_id] = {"content": content, "result": result}
                while len(STATE.finished) > 8:
                    del STATE.finished[next(iter(STATE.finished))]
                STATE.active_session = None
            return self.json_response(200, result)
        except BaseException:
            if session is not None:
                try:
                    apply_presentation_settings(session["baselineSettings"])
                except Exception:
                    log.exception("Failed to restore NVDA settings after finish failure")
                finally:
                    with STATE.lock:
                        if (
                            STATE.active_session is not None
                            and STATE.active_session["id"] == session_id
                        ):
                            STATE.active_session = None
            raise
        finally:
            STATE.operation_lock.release()

    def artifact(self, session_id, name):
        with STATE.lock:
            completed = STATE.finished.get(session_id)
        if completed is None or name != "screenreader-events":
            return self.json_response(404, {"error": "artifact-not-found"})
        content = completed["content"]
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Disposition", 'attachment; filename="screenreader-events.json"')
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def json_response(self, status, value):
        content = (
            json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self):
        super().__init__()
        self.server = None
        self.server_thread = None
        self.cdp_proxy = None
        self.cdp_proxy_thread = None
        self.registered = []
        try:
            with open(TOKEN_PATH, "r", encoding="utf-8") as token_file:
                token = token_file.read().strip()
            if (
                len(token) < 32
                or len(token) > 256
                or not re.fullmatch(r"[A-Za-z0-9_-]+", token)
            ):
                raise ValueError("control token shape is invalid")
            speech.extensions.pre_speechQueued.register(self.on_speech)
            self.registered.append((speech.extensions.pre_speechQueued, self.on_speech))
            braille.pre_writeCells.register(self.on_braille)
            self.registered.append((braille.pre_writeCells, self.on_braille))
            braille.filter_displayDimensions.register(self.display_dimensions)
            self.registered.append(
                (braille.filter_displayDimensions, self.display_dimensions)
            )
            core.postNvdaStartup.register(self.on_startup)
            self.registered.append((core.postNvdaStartup, self.on_startup))
            self.server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
            self.server.control_token = token
            self.server_thread = threading.Thread(
                target=self.server.serve_forever,
                name="HooSaidThatNVDAControl",
                daemon=True,
            )
            self.server_thread.start()
            self.cdp_proxy = ThreadingTCPServer(("0.0.0.0", 9222), CdpProxyHandler)
            self.cdp_proxy_thread = threading.Thread(
                target=self.cdp_proxy.serve_forever,
                name="HooSaidThatChromeCDPProxy",
                daemon=True,
            )
            self.cdp_proxy_thread.start()
            log.info("HooSaidThat NVDA control registered on port %d", PORT)
        except Exception:
            log.exception("HooSaidThat NVDA control registration failed")
            self.terminate()

    def on_startup(self):
        with STATE.lock:
            STATE.ready = True

    def on_speech(self, speechSequence=None, priority=None, **kwargs):
        if not speechSequence:
            return
        text = "".join(item for item in speechSequence if isinstance(item, str)).strip()
        command_types = [
            type(item).__name__ for item in speechSequence if not isinstance(item, str)
        ]
        if text or command_types:
            redacted = current_focus_is_protected()
            STATE.append(
                "speech",
                text,
                speechCommands=[{"kind": item} for item in command_types],
                **({"redacted": True} if redacted else {}),
            )
            with STATE.lock:
                live_region = STATE.live_region_context
                if live_region is not None:
                    live_region["emitted"] = True
            if live_region is not None:
                STATE.append(
                    "liveRegion",
                    text,
                    priority=live_region["priority"],
                    **({"redacted": True} if redacted else {}),
                )

    def on_braille(self, cells=None, rawText="", currentCellCount=None, **kwargs):
        values = list(cells or [])
        text = str(rawText or "").strip()
        if text or values:
            redacted = current_focus_is_protected()
            STATE.append(
                "braille",
                text,
                brailleCells=base64.b64encode(
                    bytes(value & 0xFF for value in values)
                ).decode("ascii"),
                brailleCursor=0,
                **({"redacted": True} if redacted else {}),
            )

    def display_dimensions(self, value):
        return braille.DisplayDimensions(1, 120)

    def event_gainFocus(self, obj, nextHandler):
        nextHandler()
        try:
            role = getattr(obj, "role", None)
            role_name = getattr(role, "displayString", None) or getattr(
                role, "name", ""
            )
            name = str(getattr(obj, "name", "") or "")
            STATE.append(
                "focus",
                " ".join(part for part in (name, str(role_name or "")) if part),
                **(
                    {"redacted": True}
                    if bool(getattr(obj, "isProtected", False))
                    else {}
                ),
            )
        except Exception:
            log.debugWarning("HooSaidThat focus capture failed", exc_info=True)

    def event_liveRegionChange(self, obj, nextHandler):
        priority = str(getattr(obj, "liveRegionPoliteness", "") or "polite")
        priority = priority.rsplit(".", 1)[-1].lower()
        self.capture_live_region(
            obj, nextHandler, "assertive" if priority == "assertive" else "polite"
        )

    def event_alert(self, obj, nextHandler):
        self.capture_live_region(obj, nextHandler, "assertive")

    def capture_live_region(self, obj, nextHandler, priority):
        context = {"priority": priority, "emitted": False}
        with STATE.lock:
            previous_context = STATE.live_region_context
            STATE.live_region_context = context
        try:
            nextHandler()
        except Exception:
            log.debugWarning("HooSaidThat live-region handler failed", exc_info=True)
            raise
        finally:
            with STATE.lock:
                STATE.live_region_context = previous_context
        if not context["emitted"]:
            try:
                protected = bool(getattr(obj, "isProtected", False))
                text = (
                    "[redacted]"
                    if protected
                    else str(
                        getattr(obj, "name", "") or getattr(obj, "value", "") or ""
                    ).strip()
                )
                if not text:
                    now_ns = time.monotonic_ns()
                    with STATE.lock:
                        for event in reversed(STATE.events):
                            if now_ns - event["monotonicNs"] > 1_000_000_000:
                                break
                            if (
                                event["kind"] == "speech"
                                and event.get("causalCommand") == STATE.command
                                and event.get("text")
                            ):
                                text = event["text"]
                                break
                STATE.append(
                    "liveRegion",
                    text,
                    priority=priority,
                    **({"redacted": True} if protected else {}),
                )
            except Exception:
                log.debugWarning(
                    "HooSaidThat live-region capture failed", exc_info=True
                )

    def terminate(self):
        with STATE.lock:
            STATE.ready = False
        if self.server is not None:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass
            self.server = None
        if self.cdp_proxy is not None:
            try:
                self.cdp_proxy.shutdown()
                self.cdp_proxy.server_close()
            except Exception:
                pass
            self.cdp_proxy = None
        for extension, handler in reversed(self.registered):
            try:
                extension.unregister(handler)
            except Exception:
                pass
        self.registered = []
        try:
            super().terminate()
        except Exception:
            pass
