# Record a feature with VoiceOver or TalkBack

Use `hoosaidthat-record` from a project that has this SDK and its supported
Playwright peer installed. Both platforms can follow the same web navigation
scenario. Each invocation makes its own run directory. The MP4 contains device
pixels and routed audio, including sounds your app makes. The separate transcript
is what the screen reader reported as text.

## Record your first feature

Start your site, then save this example as `checkout.json`. Replace the URL
and labels with ones from your page. A local development server can stay bound
to loopback when it runs on the same computer as the emulator.

```json
{
  "url": "http://127.0.0.1:8080/checkout",
  "readyText": "Confirm order",
  "steps": [
    { "action": "forward", "until": "Order summary", "maxMoves": 30 },
    { "action": "forward", "expect": "Confirm order" },
    { "action": "backward", "expect": "Order summary" }
  ]
}
```

```sh
npx --no-install hoosaidthat-record ios --scenario checkout.json --audio-device "BlackHole 2ch" --results films
npx --no-install hoosaidthat-record android --scenario checkout.json --avd HST_TalkBack_API35 --results films
```

Open `recording.mp4` in the run directory printed by the command. Omit
`--scenario` to try the packaged smoke test. Each requested recording requires
a working audio source; the transcript is never read out afterward to make
the soundtrack.

- **iPhone:** use macOS with Xcode 27+, a dedicated iPhone simulator with iOS
  27+, FFmpeg/ffprobe, and a virtual audio loopback. Route the simulator's
  sound output to the named loopback in Device Hub. Keep the Mac's default
  audio output separate so other apps aren't mixed into the movie. To select
  among iPhones, run `npx --no-install hoosaidthat-voiceover-ios doctor` and
  pass `--udid UUID`. See [iPhone setup and scenarios](ios-voiceover.md).
- **Android:** create the [TalkBack AVD](../oracle/android-talkback/README.md)
  with Chrome, TalkBack, an installed speech engine, and hardware keyboard
  support. Install scrcpy and FFmpeg and put them on PATH alongside the
  Android SDK and JDK tools. The recorder builds the two helpers if needed.
  Use `--tts-engine PACKAGE` to select another installed voice engine or
  `--locale de-DE` for an AVD already configured for German. A loopback web
  scenario forwards only its explicit URL port into the disposable emulator.

For both readers, `forward` and `backward` move in reading order; `current`
reads the selection. Match a literal substring with `expect`, or repeat a
movement with `until` and a limit of 1–50 moves. Reader output and element
order can differ across platforms. If they do, use a separate scenario rather
than weakening the expected text. `readyText` is a page readiness check; it
cannot satisfy a speech expectation.

## Record a longer Android flow

The JSON runner also supports `activate`, `nextButton`, `previousButton`,
`nextHeading`, `previousHeading`, `nextLink` and `previousLink` on Android.
For logins, typing, navigation between pages or existing regression tests,
run the desired Playwright test as the child. For example:

```sh
npx --no-install hoosaidthat-record android --avd HST_TalkBack_API35 -- \
  npx playwright test --config android.config.ts --grep "change a booking"
```

Use one worker, `screenReader: 'talkback'`, `runtime: 'external'`, and the
HooSaidThat test fixture. The child receives the device endpoints. Use a site
the emulator can reach; for a custom command, the runner cannot infer your
server port. The movie covers the child command, so select one test to get
one feature per movie.

## What the files prove

The transcripts come directly from VoiceOver's XCTest service or TalkBack's
TTS requests. The soundtrack comes from the simulator output on iOS and the
guest on Android. Neither track isolates the reader from your app's other
sounds. Use a quiet test page or app when the voice alone matters. Inspect
the actual movie before sharing it: screens, speech, and transcripts can all
contain the data used by the test. A simulator recording establishes behavior
for that device configuration; test a physical phone separately if required.
