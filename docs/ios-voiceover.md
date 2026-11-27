# Test and record features with VoiceOver on an iPhone simulator

Use a dedicated iPhone simulator with iOS 27 or later and Xcode 27 or later.
In Xcode Settings → Components, install an iOS Simulator runtime; create a
simulated iPhone in [Device Hub](https://developer.apple.com/documentation/xcode/device-hub) if needed (Xcode → Open Developer Tool → Device Hub). If several Xcode
versions are installed, set `DEVELOPER_DIR` to the desired Xcode's
`Contents/Developer` directory. No Appium server or signing identity is needed.

From a checkout:

```sh
npm run voiceover:ios:doctor
npm run voiceover:ios:run -- --udid <UDID-from-doctor>
```

From a project with this version of the package installed, use
`npx --no-install hoosaidthat-voiceover-ios doctor` and
`npx --no-install hoosaidthat-voiceover-ios run --udid <UDID>`. With a single
eligible simulator you can omit the UDID. The doctor does not boot a device.
The default test serves a temporary page on loopback with a unique heading
and button. It navigates to the button, back to the heading and forward to
the button again, and checks what VoiceOver reported each time.

## Run against your own page

Start your website, save a scenario as JSON, and pass it to the runner:

```json
{
  "url": "http://127.0.0.1:8080/checkout",
  "readyText": "Pay now",
  "steps": [
    { "action": "forward", "until": "Order summary", "maxMoves": 30 },
    { "action": "forward", "expect": "Pay now" },
    { "action": "current", "expect": "Pay now" },
    { "action": "backward", "expect": "Order summary" }
  ]
}
```

```sh
npm run voiceover:ios:run -- --udid <UDID> --scenario checkout.json
```

Use a URL reachable from the simulator. The optional `readyText` waits for an
exact accessibility label on the page before starting VoiceOver. Only the
reader's returned speech satisfies a scenario step. Put identifying page text in the first
expectation so a Safari toolbar or an error page cannot satisfy your test.
If Safari presents its first-run setup, finish it once on that simulator.
Navigation uses its configured language; match the words it actually speaks.

| Action | What the test reads |
| --- | --- |
| `current` | VoiceOver's speech for its current selection |
| `forward`, `backward` | Speech after moving to the next or previous element |
| `in`, `out` | Speech after moving into or out of the current container |

An `expect` is a case-sensitive literal substring of one utterance. On a
movement, `until` repeats that movement until the substring appears. Supply
`maxMoves` (1–50); exhausting the limit fails. Without an expectation, the
step still requires nonempty speech. A scenario accepts 1–100 steps.

## Record a feature with real simulator sound

Install FFmpeg (including `ffprobe`) on the Mac and a virtual loopback audio
device such as BlackHole 2ch. Open the iPhone in Device Hub and select that
device under **Device → Sound → Sound Output**. Keep the Mac’s own sound output
on its speakers or headphones. Reserve the loopback for this simulator and stop
other apps playing to it. Complete Safari’s first-run prompts on this simulator.

Keep the simulator booted and visible in Device Hub, then run:

```sh
npx --no-install hoosaidthat-voiceover-ios record --udid <UDID> \
  --scenario checkout.json --audio-device "BlackHole 2ch" --results ./recordings
```

The run directory contains **recording.mp4** (H.264 video, AAC audio),
**transcript.json** and **report.json**. The recording starts after the target
is ready and VoiceOver has initialized. It ends after the last step. Recording
paces navigation to let speech finish; long descriptions or slow speech settings
can still be interrupted. Transcript events include the action's elapsed time
from the start of the scenario. The report identifies the selected audio device,
duration, frame size and measured peak volume.

When `readyText` is visible and hittable, recording starts by touching its
center once with VoiceOver on to establish focus before the movie. Set it to
the element where the walkthrough should begin. Recording uses actual
one-finger right/left flicks for forward/backward and queries native VoiceOver
for the resulting utterance. The transcript-only `run` command uses Apple's
service navigation methods.

The movie contains the simulator's audio output, which can include VoiceOver,
app sounds and other device sounds. The transcript records Apple's returned
utterances separately. The runner rejects missing tracks and silence; it does
not transcribe the audio to prove each word is audible. Use a quiet feature
with a distinctive phrase to confirm routing when setting up a new Mac.
With the default settings, the physical microphone and default Mac output cannot be selected. If just one
eligible loopback is installed, you can omit `--audio-device`. On a disposable
Mac used only for this run, you may instead select the loopback as the Mac's
default output, leave Device Hub on System, and add `--dedicated-mac-output`
with an explicit `--audio-device`. That mode records **all sounds routed to
that Mac output**; the report labels it accordingly. Microphones remain
ineligible. Before recording, the runner checks that the simulator's output is
actually routed to that device. Ctrl-C requests XCTest teardown and stops both
recorders. An unresponsive XCTest process may be unable to restore VoiceOver;
check that setting on a pre-booted simulator after a forced interruption.

For an installed native app, use its bundle ID instead of a URL:

```json
{
  "bundleId": "com.example.shop",
  "readyText": "Cart",
  "steps": [
    { "action": "forward", "until": "Checkout", "maxMoves": 20 },
    { "action": "activate" },
    { "action": "forward", "until": "Shipping address", "maxMoves": 10 }
  ]
}
```

`activate` sends an XCTest one-finger double tap to the foreground screen while
VoiceOver is enabled, then reads the service's current utterance. Assert a
distinctive result on this or a subsequent step to verify the transition. The
runner stops if the scenario leaves the target app. It does not install apps.
After activating a text field, `{ "action": "type", "text": "Sample" }` types
through XCTest and reads current focus. Use sample data: typed text is included
in the scenario report and may be spoken or visible in the recording.

The programmatic equivalent is `recordIPhoneVoiceOver(scenario, { udid,
audioDevice, resultsDirectory })` from `@openhoo/hoosaidthat/ios`.

## Use a Playwright test

Import `runIPhoneVoiceOver` from `@openhoo/hoosaidthat/ios` in a test that
runs on your Mac. The helper opens the URL in Mobile Safari and rejects if
VoiceOver does not speak the expected text. Start your site before the test
(for example with Playwright's `webServer` setting) and use one worker per
simulator. The example assumes a single eligible iPhone; if you have several,
pass `udid` in the options alongside `resultsDirectory`.

```ts
import { test } from '@playwright/test';
import { runIPhoneVoiceOver } from '@openhoo/hoosaidthat/ios';

test('VoiceOver reads the checkout summary on iPhone', async ({}, testInfo) => {
  test.setTimeout(30 * 60_000); // Allows for a cold simulator boot and XCTest build.
  const { report } = await runIPhoneVoiceOver({
    url: 'http://127.0.0.1:8080/checkout',
    steps: [
      { action: 'forward', until: 'Order summary', maxMoves: 30 },
      { action: 'forward', expect: 'Pay now' },
    ],
  }, { resultsDirectory: testInfo.outputPath('iphone') });
  await testInfo.attach('iPhone VoiceOver', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});
```

The return value also includes `outputDirectory`, the location of
`VoiceOver.xcresult` and the transcript. If a native test fails, inspect
the run directory under the specified `resultsDirectory`.

## Verification status

On November 24, 2026, a [native XCTest run](https://github.com/openhoo/hoosaidthat/actions/runs/45444402575/job/138624068935)
on an iPhone 18 Pro simulator with iOS 27.0 (24A434) and Xcode 27.1
(27A9275) captured three utterances from Mobile Safari: the button, the
heading after moving backward, and the same button after moving forward.
Each included the page's unique marker. The [recorded transcript and report](evidence/ios-voiceover-27.0.json) include the exact utterances. Safari passed one native test; the
separate UIKit control in the same diagnostic job failed. That simulator
had already been booted and VoiceOver had previously been enabled. A
[second job](https://github.com/openhoo/hoosaidthat/actions/runs/45448162533)
repeated all three Safari observations after an independent native VoiceOver
session on another runner.

Cold iOS 27.2 runs reached the expected page but failed on the first forward
command with no utterances. Use the verified runtime when possible. On a fresh simulator the runner starts Safari before opening the URL and
allows up to three minutes for the page marker. It reads the current VoiceOver
focus without moving it. After 100 seconds of silence it can re-enable a
service it originally found off. It never retries a movement that may have changed focus.

## Results and scope

Each run prints its own directory under `test-results/ios-voiceover/`
(change the parent with `--results`). Open `VoiceOver.xcresult` in Xcode for
diagnostics. `transcript.json` records the actual utterances, including repeated
moves. On success, `report.json` also records the Xcode and simulator versions,
the UDID and the scenario. Failed UI tests retain whatever transcript XCTest
was able to attach, alongside `xcodebuild.log`. Results contain tested URLs,
page text and possibly screenshots. Treat them as test data.

The UI test opens Mobile Safari and uses Apple's
[XCUIVoiceOverService](https://developer.apple.com/documentation/xcuiautomation/xcuivoiceoverservice)
on the simulated iPhone. It restores the simulator's prior VoiceOver setting
during teardown. The CLI shuts down a simulator that it booted. Safari history,
tabs and site data can remain on that simulator. Host VoiceOver is not required.

The `run` command checks the service's returned speech text. The `record`
command also captures the simulator screen and routed audio. Neither command
captures braille, rotor gestures, or a stream of unsolicited live-region text. It runs independently of the desktop
Chrome/Playwright fixture; `screenReader: 'voiceover'` still selects the Mac
adapter. A simulator result does not qualify a physical iPhone.
