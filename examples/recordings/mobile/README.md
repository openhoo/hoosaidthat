# Feature recordings with TalkBack

## Book a visit in a browser

[Download or play the 31-second MP4](https://raw.githubusercontent.com/openhoo/hoosaidthat/examples/mobile-recordings/examples/recordings/mobile/android-talkback-booking.mp4). [English captions](android-talkback-booking.en.vtt) are available separately. The green rectangle is TalkBack’s current focus. At 0:25 the button has been activated and TalkBack says “Visit reserved.” The video includes audio from the Android 15 emulator.

| Time | TalkBack output |
| --- | --- |
| 0:05 | Book a visit. Heading 1. |
| 0:09 | Choose your appointment. |
| 0:12 | Reserve Tuesday. Button. Press Alt + Enter to activate. |
| 0:16 | Choose your appointment. |
| 0:20 | Reserve Tuesday. Button. Press Alt + Enter to activate. |
| 0:25 | Visit reserved. |

The [sample page](../../../docs/examples/mobile/booking/index.html) and [scenario](../../../docs/examples/mobile/booking/booking.json) ship with the recorder. Follow the [recording guide](../../../docs/mobile-recordings.md) to record your own feature. This movie was recorded from a clean installation of the [CI package](https://github.com/openhoo/hoosaidthat/actions/runs/45968512363), archive SHA-256 `395bac471f6f51783ba6e95da14f05d5f9731f7fd316dcf87f93ab8d05b90e06`. The key phrases were checked against both the TalkBack transcript and speech recognition on the MP4. The page and booking are synthetic.

## Visit Display settings in a native app

[Download or play the 13-second MP4](https://raw.githubusercontent.com/openhoo/hoosaidthat/examples/mobile-recordings/examples/recordings/mobile/android-talkback-settings.mp4) · [English captions](android-talkback-settings.en.vtt).

A driver opens Android Settings, opens **Display & touch**, and returns to Settings. The green TalkBack outline moves from the profile button to the back button. The recording includes the emulator’s volume announcement.

| Time | TalkBack output |
| --- | --- |
| 0:01 | Settings. |
| 0:02 | Profile picture. Double tap to open Google Account. Button. |
| 0:06 | Ringtone volume set to 71 percent. |
| 0:09 | Display and touch. |
| 0:11 | Navigate up. Button. |
| 0:12 | Settings. |

See the [native driver example](../../../docs/examples/mobile/android-settings.mjs). This movie came from an installed development archive built at `6e2d679` on Android 15 with TalkBack 15.0. The words “Settings,” “Display and touch,” and “Navigate up” appear in both speech recognition on the saved audio and TalkBack’s own transcript.
