# Test a website with VoiceOver on an iPhone simulator

Use a dedicated iPhone simulator with iOS 27 or later and Xcode 27 or later.
In Xcode Settings → Components, install an iOS Simulator runtime; create an
iPhone in Xcode's Devices and Simulators window if needed. If several Xcode
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

Use a URL reachable from the simulator. Put identifying page text in the first
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

This runner tests web navigation and the service's returned speech text.
It does not access the acoustic output, braille, rotor gestures, or a stream
of unsolicited live-region announcements. It runs independently of the desktop
Chrome/Playwright fixture; `screenReader: 'voiceover'` still selects the Mac
adapter. A simulator result does not qualify a physical iPhone.
