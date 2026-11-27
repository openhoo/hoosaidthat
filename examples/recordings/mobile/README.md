# Feature recordings with VoiceOver and TalkBack

**[Try the RC.2 recorder](TRY-RC2.md)** to record your own app or website by hand. The four examples below include real simulator audio, English captions, and notes on the builds used to make them.

## Confirm a checkout in iPhone Safari

[Play or download the 46-second iPhone checkout MP4](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/ios-voiceover-checkout.mp4) · [English captions](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/ios-voiceover-checkout.en.vtt).

VoiceOver reads the **Confirm order** button, moves back to **Order summary**, then forward to the button. A double tap activates the button. On the next forward movement you hear **Receipt ready** and see the focus outline around the new label. The letters and digits in the labels identify this synthetic run.

To reproduce on a supported, routed iPhone simulator, run the built-in example:

```sh
npx --no-install hoosaidthat-record ios --udid "$UDID" --audio-device "BlackHole 2ch" --results films
```

This is the unedited MP4 written by the installed [candidate archive](https://github.com/openhoo/hoosaidthat/actions/runs/45974196315), SHA-256 `857b8e5dc81a7388dd7ab70236a649faf6dd283bb6b1dcc00cee13ef6576b64c`. Independent speech recognition recovered the three checkout phrases from its audio. The first and last frames remain in Safari. The package ran on Xcode 27.2 and iOS 27.0.

## Book a visit in a browser

[Download or play the 31-second MP4](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/android-talkback-booking.mp4). [English captions](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/android-talkback-booking.en.vtt) are available separately. The green rectangle is TalkBack’s current focus. At 0:25 the button has been activated and TalkBack says “Visit reserved.” The video includes audio from the Android 15 emulator.

| Time | TalkBack output |
| --- | --- |
| 0:05 | Book a visit. Heading 1. |
| 0:09 | Choose your appointment. |
| 0:12 | Reserve Tuesday. Button. Press Alt + Enter to activate. |
| 0:16 | Choose your appointment. |
| 0:20 | Reserve Tuesday. Button. Press Alt + Enter to activate. |
| 0:25 | Visit reserved. |

The [sample page](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/examples/mobile/booking/index.html) and [scenario](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/examples/mobile/booking/booking.json) ship with the recorder. Follow the [recording guide](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/mobile-recordings.md) to record your own feature. This movie was recorded from a clean installation of the [CI package](https://github.com/openhoo/hoosaidthat/actions/runs/45968512363), archive SHA-256 `395bac471f6f51783ba6e95da14f05d5f9731f7fd316dcf87f93ab8d05b90e06`. The key phrases were checked against both the TalkBack transcript and speech recognition on the MP4. The page and booking are synthetic.

## Visit Display settings in a native app

[Download or play the 13-second MP4](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/android-talkback-settings.mp4) · [English captions](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/android-talkback-settings.en.vtt).

A driver opens Android Settings, opens **Display & touch**, and returns to Settings. The green TalkBack outline moves from the profile button to the back button. The recording includes the emulator’s volume announcement.

| Time | TalkBack output |
| --- | --- |
| 0:01 | Settings. |
| 0:02 | Profile picture. Double tap to open Google Account. Button. |
| 0:06 | Ringtone volume set to 71 percent. |
| 0:09 | Display and touch. |
| 0:11 | Navigate up. Button. |
| 0:12 | Settings. |

See the [native driver example](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/examples/mobile/android-settings.mjs). This movie came from an installed development archive built at `6e2d679` on Android 15 with TalkBack 15.0. The words “Settings,” “Display and touch,” and “Navigate up” appear in both speech recognition on the saved audio and TalkBack’s own transcript.

## Browse a museum booking on iPhone

[Download or play the 35-second iPhone MP4](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/ios-voiceover-museum.mp4) · [English captions](https://raw.githubusercontent.com/openhoo/hoosaidthat/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/ios-voiceover-museum.en.vtt) · [Sample UIKit app and runnable scenario](https://github.com/openhoo/hoosaidthat/blob/857056f64847a96ed6002add0e15eacccef9c78f/examples/recordings/mobile/ios-museum/README.md).

VoiceOver moves forward to the appointment description and the button, then back to the heading. Listen for the following words and watch the black focus outline move with them:

| Time | VoiceOver output |
| --- | --- |
| 0:00 | Choose your appointment. |
| 0:09 | Reserve Tuesday. Button. |
| 0:17 | Choose your appointment. |
| 0:25 | Book a museum visit. Heading. |

HooSaidThat drove an iOS 27.0 simulator with Xcode 27.2. All four observations agreed across the native VoiceOver transcript, the app’s accessibility focus events, and independent speech recognition on the movie. Video was exported from the original XCTest attachment using its presentation timestamps. The AAC track is unchanged from the installed recorder’s original capture. This walkthrough demonstrates navigation; it does not submit a booking.
