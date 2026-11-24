# VoiceOver

The `voiceover-web` profile drives Apple's VoiceOver in Chrome on macOS. Use
a dedicated test Mac or a macOS guest. The Playwright client can run separately.

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
the guest in that case. It restarts the guest TCC service after applying the
grants so cached decisions are reloaded. Host permissions and preferences are untouched.
After the guest desktop starts, the runner enables and verifies Do Not Disturb
through its native Focus controls. It dismisses existing system notification alerts through
their native Close actions and verifies that no alert remains. These guest-only
steps prevent background-activity banners from covering the tested cursor;
AX hit tests still reject actual occlusion.
The managed setup waits up to 60 seconds for cold-login authorization to become
available. Persisting authorization errors stop the run with their native error.

Chrome can retain VoiceOver's cursor in a toolbar when a new test window opens,
even while native keyboard focus belongs to the page. `returnToPage()` aligns
the reader, traverses the native window if necessary, and verifies its cursor
through AX hit tests against the focused web document. A web-area rectangle
that includes a native scrollbar is entered before accepting child membership.
Native AX position and size distinguish the selected web area itself from a
cursor on one of its descendants, including when every rectangle hit is inside
the document. Entry gestures stop once descendant membership is verified.
Losing browser focus, changing documents, or failing cursor verification fails
the action and preserves a bounded diagnostic code in the native evidence.

## Running directly on a test Mac

Use a logged-in Mac that can give the test exclusive use of the desktop. The
bridge opens a temporary Chrome profile in the foreground, moves the VoiceOver
cursor and sends real keystrokes. Switching apps during a test can change
what VoiceOver announces. Use the guest above to keep using your own desktop.

Install Node.js 22+ and Google Chrome (or supply a Chromium executable with
`--browser-executable`). Enable VoiceOver. In [VoiceOver Utility → General](https://support.apple.com/guide/voiceover/cpvougen/mac),
turn on **Allow VoiceOver to be controlled with AppleScript**. Keep Control
and Option enabled as VoiceOver modifiers for the built-in key mappings. Give the
terminal or runner that launches the bridge **Accessibility** permission in
**System Settings → Privacy & Security**, and allow it to automate **System
Events** and **VoiceOver** if macOS prompts. Run the following from a source checkout:

```bash
npm ci
npm run build
node scripts/native-screen-reader.mjs --doctor
```

The doctor checks whether VoiceOver is running and the launching terminal has
Accessibility permission. It exits with status 1 if either is missing. It
does not open Chrome, send keystrokes, or request permissions. The actual
bridge checks scripting access, focus and speech during startup.

Start the bridge and leave it running:

```bash
node scripts/native-screen-reader.mjs --screen-reader voiceover \
  --token-file "$HOME/.hoosaidthat/voiceover.token" --locale en-US
```

After it prints the control and CDP endpoints, run the two example tests from
the same checkout in a second shell (for example, via SSH to avoid taking
focus from Chrome):

```bash
HST_NATIVE_TOKEN_FILE="$HOME/.hoosaidthat/voiceover.token" npm run test:e2e:native
```

The bridge creates the token file privately if missing. It listens on loopback
ports 3003 (control) and 9225 (CDP). Press Ctrl+C in its terminal when finished.
With the installed package, `hoosaidthat-native` runs the same bridge. A
manually prepared macOS guest uses the same commands.

## Connecting a Playwright project

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

The default VoiceOver boundary reads `content of last phrase`, then schedules
the next sample after 100 ms. AppleScript execution extends the actual interval.
It records a phrase only when the native value changes. **Identical consecutive
phrases and phrases replaced between polls cannot be recovered.** An action
with no distinguishable speech times out. No stale caption is replayed as a
successful announcement. This capture is suitable for bounded checks, not a
claim of complete VoiceOver utterance coverage. Streaming AT Driver capture
has the distinct `voiceover-speech-output` boundary.

`toHaveSpoken` checks the last observation immediately. A polite live region can
arrive after an earlier help hint has settled. For asynchronous announcements,
take a `screenReader.checkpoint()` before the action, then use `expect.poll`
to read actual captured speech from that same checkpoint with
`screenReader.readFrom(checkpoint)`. The native smoke suite demonstrates this
with a bounded 15-second assertion on the expected announcement.

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
The same two scenarios also passed three times each across worker restarts
(6/6, no retries or skips) before the final cold installed-package check.
This qualifies the two bounded scenarios for that combination; it is not a
command or browser compatibility matrix. Local JSON, transcripts, hashes and
portable HTML reports are retained under
`test-results/release-voiceover/repeated-qualified` and
`test-results/release-voiceover/final-qualified` (ignored by Git).
