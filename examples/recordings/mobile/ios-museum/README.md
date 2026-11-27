# Record a native iPhone feature

This UIKit sample has a heading, an appointment label, and a reservation button. It uses ordinary accessibility labels and traits. It does not generate audio. The accompanying scenario navigates to the button and back to the heading.

On an Apple Silicon Mac with a booted iOS 27+ simulator, Xcode 27.2 and the recorder installed, set `UDID` to the device identifier from `hoosaidthat-voiceover-ios doctor`. In Device Hub route the iPhone’s sound output to your virtual loopback, keeping the Mac’s default output on its own speakers. Run these commands from this directory:

```sh
./build.sh
xcrun simctl install "$UDID" build/MuseumBooking.app
npx --no-install hoosaidthat-record ios --udid "$UDID" --scenario navigation.json --audio-device "BlackHole 2ch"
```

Use the name of your own virtual audio device. The recording linked above used Steam Streaming Speakers as a dedicated loopback. The app also has an optional `--focus-demo` launch argument for testing routing: it asks UIKit to focus the three controls in sequence. The recorded scenario used four VoiceOver gestures.
