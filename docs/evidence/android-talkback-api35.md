# TalkBack on the Android 15 emulator

On November 25, 2026, both tests in
[`talkback.spec.mjs`](../../oracle/android-talkback/talkback.spec.mjs) passed
on a cold managed AVD and on a separately prepared, already running emulator.
The final cold run of commit `3235fb1` passed both tests in 43.4 seconds
after setup; the repository suite passed all 445 tests.

| Component | Tested configuration |
| --- | --- |
| Host | WSL2 Linux, x86_64, KVM, Node 24.22.3 |
| Android Emulator | 37.3.10, headless, Lavapipe, guest Vulkan disabled |
| Virtual device | Pixel 6, 4 vCPUs, 4096 MiB RAM, 10 GiB data, hardware keyboard enabled |
| System image | Android 15, API 35, Google Play x86_64, revision 9 |
| Screen reader | Google TalkBack 15.0.0.639625893, en-US, Default Alt keyboard shortcuts |
| Browser | Chrome 124.0.6367.219 |

## Reproduce

Prepare the SDK, AVD and two helper APKs as in the
[Android guide](../../oracle/android-talkback/README.md). Then run:

```bash
HST_EMULATOR_GPU=lavapipe HST_TALKBACK_RESULTS="$PWD/talkback-results" \
  npm run talkback:android:run -- --avd HST_TalkBack_API35 --token-file ~/.hst/talkback-token
```

The managed run installed the helpers in a disposable guest and verified a
fresh bootstrap announcement before the suite started. After the run, its
serial and Chrome adb forward were gone; the separately connected emulator
remained available. The prepared emulator ran the same suite with `--serial`.

## Captured synthesis requests

Each row quotes requests attributed to TalkBack in the managed run's
`screenreader/screen-reader-flow.txt` attachments. The navigation and
asynchronous observation are separate tests.

| Action | Requests, in order |
| --- | --- |
| Start of document | “Start”, “heading 1” |
| Next heading | “Checkout summary”, “heading 2” |
| Next button | “Continue checkout”, “button”, “Press Alt + ENTER to activate” |
| Activate current element | “Checkout is ready” |
| Observe an asynchronous status update after a Playwright click | “Continue checkout”, “button”, “Checkout is ready”, “Press select to activate” |

This verifies TalkBack's requests to the Android test text-to-speech service.
It does not establish audible playback, the behavior of every mapped shortcut,
or support for physical phones, other versions or other languages.
