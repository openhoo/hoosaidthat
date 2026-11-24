# UIKit diagnostic control

Use this project only when investigating an iPhone VoiceOver failure. Results describe the UIKit app in this directory; they do not establish Safari compatibility.

On an iPhone simulator with Xcode and iOS 27 or newer, use the same runtime and simulator UDID as the failing Safari scenario:

```sh
xcrun xcodebuild test -project NativeControl.xcodeproj -scheme NativeControl \
  -destination "platform=iOS Simulator,id=$udid" -parallel-testing-enabled NO \
  -only-testing:NativeControlUITests/NativeControlTests/testNativeVoiceOver \
  -resultBundlePath NativeControl.xcresult
xcrun xcresulttool export attachments --path NativeControl.xcresult --output-path NativeControl-evidence
```

The app shows a heading and button with a marker generated for each launch. When the app observes that VoiceOver is running, it posts UIKit's public screen-change notification with the heading. No application code synthesizes speech. The test requires VoiceOver to speak the marker on both forward and backward navigation and restores the original VoiceOver setting. Failed and successful test runs attach the observations as `native-uikit-control-voiceover-utterances` (apart from failures before the app is ready). Use `testUIKitRendering` separately to check that UIKit rendered the two controls on runtimes without the VoiceOver API.
