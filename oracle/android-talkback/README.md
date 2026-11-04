# TalkBack on Android

Experimental real TalkBack adapter for Chrome on an explicitly selected Android
device or emulator. It uses protocol v2, the `talkback-web` profile, and the
`talkback-tts-output` capture boundary. It has no NVDA parity claim.

The Node bridge runs on the computer connected to the device through `adb`.
The screen reader and Chrome run on Android. This adapter does not install,
download or emulate TalkBack and does not start an emulator automatically.

## Prepare a dedicated test device

Requirements:

- Android 14 / API 34 or newer. Keyboard combinations use Android's native
  `input keyboard keycombination` command.
- Google TalkBack (`com.google.android.marvin.talkback`) enabled, its tutorial
  completed, and **Default keymap**, **Alt modifier**, default shortcuts selected
  in TalkBack's physical keyboard settings. Classic and customized keymaps are
  not supported. Configure the reader language to `en-US` or `de-DE`.
- Chrome (`com.android.chrome`) installed, its first-run prompts completed,
  and a web page foreground. Chrome variants and embedded WebViews are not
  currently supported.
- Developer options and USB debugging enabled, the host authorized, and `adb`
  on PATH. `HST_ADB_BIN` can select another executable. Wireless adb serials
  work when the device is already paired and connected.
- Node 22+ and this package's compatible Playwright version on the host.

Use a dedicated emulator or test device with a dedicated Chrome profile. The
test TTS engine is silent and stores TalkBack's synthesis requests in private
app storage. The test fixture clears Chrome cookies and storage for network
origins visited by its test pages. It does not provide a fresh browser profile
or erase captured speech on shutdown.
Context init scripts, exposed bindings and other persistent-context options
remain across tests. Use separate device/Chrome sessions when full isolation
is required. Device viewport, locale and voice settings come from Android;
desktop context emulation options are unavailable.

## Build and install the helper APKs

The capture app is a real Android `TextToSpeechService`. The probe is a separate
instrumentation app so inspection does not restart the TTS process. It connects
to `UiAutomation` with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`, leaving
TalkBack active. No root, accessibility overlay, TalkBack patch or network
service on the device is required.

Install Android SDK `platforms;android-35` and `build-tools;35.0.0` with the
official SDK manager. Set `ANDROID_HOME` and `JAVA_HOME` to the SDK and JDK
(JDK 17+), then run from the package directory:

```bash
npm run build
npm run talkback:android:build
adb devices -l
adb -s emulator-5554 install -r oracle/android-talkback/build/hoosaidthat-capture.apk
adb -s emulator-5554 install -r oracle/android-talkback/build/hoosaidthat-probe.apk
```

Builds use the SDK's `aapt2`, D8, zipalign and apksigner directly. Both APKs are
signed and verified with a generated test key under the ignored `build/`
directory. This is a test-only debug signing key, not a release identity. Keep
it when updating an existing installation, or uninstall the old helpers first.
The npm package includes Java sources and the build command; APKs and signing
keys are excluded.

On Android, open **Settings → Text-to-speech output → Preferred engine** and
select **HooSaidThat capture TTS**. If TalkBack has an explicit engine override,
select the capture engine there as well. Resume TalkBack after changing the
engine and confirm Chrome's web content can receive accessibility focus.
Selecting this engine silences TalkBack; use a disposable emulator or arrange
another way to operate the test device during setup.

## Check and run

Replace the example serial with the exact value from `adb devices`:

```bash
npm run talkback:android:doctor -- --serial emulator-5554
npm run talkback:android:run -- --serial emulator-5554 --token-file /tmp/hst-talkback/control-token
```

`doctor` checks the Android API, installed reader/browser versions, enabled
TalkBack, selected capture engine and native Chrome window. It reports speech
as **not tested**. `run` additionally opens an owned bootstrap tab, captures a
new TalkBack utterance, starts authenticated control, and runs the packaged
heading/button/live-region smoke tests. Silent startup or failed native focus
prevents the bridge from reporting ready.

To run a consumer suite instead:

```bash
hoosaidthat-talkback-android run --serial emulator-5554 --token-file /tmp/hst-talkback/control-token -- npx playwright test
```

```ts
import { defineConfig } from '@openhoo/hoosaidthat';

export default defineConfig({
  workers: 1,
  fullyParallel: false,
  use: {
    screenReaderOptions: {
      screenReader: 'talkback',
      runtime: 'external',
      locale: 'en-US',
      keyboardLayout: 'desktop',
      quietMs: 500,
      webReport: 'on',
    },
  },
});
```

`run` provides `HOOSAIDTHAT_TALKBACK_CONTROL_ENDPOINT`,
`HOOSAIDTHAT_TALKBACK_CDP_ENDPOINT`, and `HOOSAIDTHAT_TALKBACK_CONTROL_TOKEN` to
its child. `start` serves those endpoints until Ctrl+C and prints the endpoint
and token-file paths, never the token. For a separately started suite, pass the
endpoints and token through `screenReaderOptions` or these environment variables.
The default host loopback ports are control **3005** and CDP **9227**. Override
them with `--control-port` and `--cdp-port`; `--locale de-DE` configures a German
bridge session. One bridge holds a host lease per explicit device serial.
Shutdown removes its own adb forward and bootstrap tab and leaves the prepared
device running. A crash can leave a stale lease; startup reports its exact path
so it can be removed after checking that the old bridge has stopped.

Host development servers are not automatically reachable as Android localhost.
Use an emulator's host gateway or create a specific `adb -s SERIAL reverse`
mapping for your application's port. The bridge never changes application
networking or the device's accessibility/TTS settings automatically.

## Actions and capture boundaries

The adapter advertises only mapped commands: Tab/Shift+Tab keyboard focus,
activation, document start/end, reading from the current location, word and
character navigation, headings (including levels 1–6), landmarks, buttons,
controls, checkboxes, combo boxes, edit fields, graphics, links, lists, list
items and tables. Structural shortcuts use TalkBack's Default Alt keymap.
`returnToPage` requests native WebView accessibility focus; `readCurrent`
clears and restores the currently focused native accessible object's focus.
Both require Android to accept the action. They do not derive announcements
from DOM text. Normal Playwright locators and speech assertions remain available.

The native probe verifies the foreground package and whether native focus is
inside Chrome's WebView. It returns no input values or password text. It does
not expose an exact accessible-document URL, cursor mode, braille, NVDA
presentation settings, arbitrary find, or unmapped desktop commands.

The capture engine accepts evidence only from TalkBack's Android UID using
`SynthesisRequest.getCallerUid()`. Requests from other TTS clients are excluded.
UTF-8, multiline and identical successive utterances are preserved. The host
validates a generation ID and consecutive sequence numbers; truncation, restart,
wrong UID, oversized utterance or capacity loss makes capture fail. Old speech
is drained before a new command. Capture is bounded to approximately 2 MiB per
TTS process; restart the bridge after restarting the capture engine for a fresh
run. After a reader/probe/device failure, finish retains already collected
events with artifact integrity metadata.

These are actual **synthesis requests**, not proof of audible playback or
utterance completion. The test engine returns short silent PCM and does not
preserve natural voice timing. Interruptions and continuous-reading behavior
can differ from a normal voice. Neither a WAV/audio track nor a braille display
is claimed. Text/JSON transcripts, runtime identity, screenshots and annotated
HTML reports use the existing evidence path.

## Verification

`npm test` covers options, protocol identity, synthetic native bridge round trips,
capture corruption/loss, event attribution, Android gestures and CDP forwarding.
`npm run talkback:android:build` compiles both Java helpers against Android 35 and
verifies their APK signatures. These checks alone do not qualify real TalkBack
behavior. Run the device smoke suite above on the intended TalkBack/Chrome/OS
versions and retain its Playwright attachments before claiming that combination
works. The initial adapter has not yet been qualified on a real Android runtime.

Primary implementation references: Android `TextToSpeechService`,
`SynthesisRequest.getCallerUid()`, `UiAutomation` and `AccessibilityNodeInfo`;
Google TalkBack's `DefaultKeyComboModel.java` in `google/talkback`; Chrome's
Android remote-debugging protocol; and the installed compatible Playwright
Android implementation.
