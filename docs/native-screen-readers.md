# VoiceOver

The `voiceover-web` profile drives actual VoiceOver in a dedicated macOS guest.
A macOS VM provides the operating system required by VoiceOver. The Playwright
client and synthetic bridge checks can run in a Linux container.

## VoiceOver in an isolated macOS guest

Install Tart from its official distribution. Then:

```bash
npm ci
npm run build
npm run voiceover:macos:doctor
npm run voiceover:macos:run
```

The helper clones the immutable Cirrus macOS base image in
`oracle/macos-voiceover/runtime-lock.json`, installs the pinned Node runtime,
installs this package and Playwright, and runs the native smoke suite inside
the guest. It stops the guest when the job ends. No local desktop automation
or audio passthrough is used.

Configuration:

| Variable | Default |
| --- | --- |
| `HST_TART_BIN` | `tart` on PATH |
| `HST_VOICEOVER_RUNTIME_ROOT` | `~/VMs/hoosaidthat-voiceover` |
| `TART_HOME` | `<runtime-root>/tart` |
| `HST_VOICEOVER_VM` | `hoosaidthat-voiceover` (dedicated `hoosaidthat-*` names only) |
| `HST_VOICEOVER_COMMAND_TIMEOUT_MS` | 30 minutes per provisioning/test command |

Guest logs, Playwright attachments and the JSON result appear under
`<runtime-root>/shared/results`. The Cirrus image has public `admin:admin`
bootstrap credentials on its private VM network. Its SSH host key is retained
in the runtime's `known_hosts`. Keep the guest on the default shared network.
The helper shares no home directory, host credential store, or source checkout.

The guest needs Accessibility, keyboard delivery, AppleEvents control of
System Events/VoiceOver, and VoiceOver's **Allow VoiceOver to be controlled
with AppleScript** preference. The provisioner grants only those automation
permissions in the disposable guest. It never disables SIP. Protected or
unsupported TCC databases fail provisioning; configure the permissions inside
the guest in that case. Host permissions and preferences are untouched.

Chrome can retain VoiceOver's cursor in a toolbar when a new test window opens,
even while native keyboard focus belongs to the page. `returnToPage()` aligns
the reader, traverses the native window if necessary, and verifies its cursor
through AX hit tests against the focused web document. A web-area rectangle
that includes a native scrollbar is entered before accepting child membership.
Losing browser focus, changing documents, or failing cursor verification fails
the action and preserves a bounded diagnostic code in the native evidence.

## Connecting a prepared guest

```bash
hoosaidthat-native --screen-reader voiceover --token-file /private/path/control-token
```

Run the bridge inside a macOS guest with Node 22+, Chrome/Chromium and VoiceOver.
It uses a temporary browser profile, attests the native reader and browser focus,
and requires actual speech before serving. Control and CDP bind to loopback on
3003/9225; use `--control-port`, `--cdp-port` and `--browser-executable` to override.
The token is created privately and never printed. One worker owns each desktop.

```ts
import { defineConfig } from '@openhoo/hoosaidthat';

export default defineConfig({
  workers: 1,
  fullyParallel: false,
  use: {
    screenReaderOptions: {
      screenReader: 'voiceover',
      runtime: 'external',
      controlEndpoint: process.env.HOOSAIDTHAT_VOICEOVER_CONTROL_ENDPOINT,
      cdpEndpoint: process.env.HOOSAIDTHAT_VOICEOVER_CDP_ENDPOINT,
      controlToken: process.env.HOOSAIDTHAT_VOICEOVER_CONTROL_TOKEN,
      locale: 'en-US',
      keyboardLayout: 'desktop',
      webReport: 'on',
    },
  },
});
```

Locale is operator configured and must match the reader. Native mappings require
`desktop`. The experimental `--at-driver-endpoint ws://127.0.0.1:4382/session`
transport accepts loopback plaintext or secure WebSockets. Native process/version
attestation remains required. Actual qualification uses the default scripting API.

## Commands and evidence

The runtime advertises mapped native commands only: keyboard focus traversal,
activation, current output, document start/end and selected heading/link/table/
image navigation. Unsupported settings, cursor-mode detection and braille fail
explicitly. VoiceOver uses its own VO modifier chords.

The default VoiceOver boundary polls `content of last phrase` every 100 ms.
It records a phrase only when the native value changes. **Identical consecutive
phrases and phrases replaced between polls cannot be recovered.** An action
with no distinguishable speech times out. No stale caption is replayed as a
successful announcement. This capture is suitable for bounded checks, not a
claim of complete VoiceOver utterance coverage. Streaming AT Driver capture
has the distinct `voiceover-speech-output` boundary.

Finished sessions retain a SHA-256-bound `screenreader-events` artifact with
the reader/version/profile/capture boundary. Actual speech has
`screenReaderOutput` provenance. Lifecycle markers remain separate. Late
sampled output is drained before a new command is attributed. Disconnects,
event-history overflow and native identity changes fail closed; finish still
preserves completed evidence. Last eight finished sessions are retained for
idempotent artifact downloads.

The adapter does not invent braille, acoustic audio, cursor position, or element
geometry. Web reports retain page snapshots and transcripts, with unavailable
audio/geometry marked accordingly.

## Qualification

`oracle/native-check` is an installed-package smoke suite for actual reader
heading navigation, keyboard focus and an asynchronous live region. The source
checkout also has `npm run test:e2e:native`. A successful synthetic bridge test
is not a successful native smoke run. Keep the native JSON report and artifacts
when claiming a particular reader/OS/browser combination is qualified.

Verified on November 4, 2026:

| Reader / OS / browser | Actual native check | Scope |
| --- | --- | --- |
| VoiceOver 10 (993), macOS 26.6.2, Chrome 151.0.7922.34 | 2/2 passed from the installed package in a headless Tart guest, including cold managed startup and automatic shutdown | Heading navigation, keyboard button focus, asynchronous live-region speech |

The VoiceOver run used the immutable guest image in `runtime-lock.json`, no
host audio or desktop window, and the `voiceover-last-phrase` capture boundary.
This qualifies the two bounded scenarios for that combination; it is not a
command or browser compatibility matrix. Local JSON, transcripts, hashes and
portable HTML reports are retained under
`test-results/native-qualification/2026-11-04/voiceover` (ignored by Git).
