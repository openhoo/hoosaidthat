# Optional native VoiceOver preparation (scratch)

This is a candidate implementation on top of 7bafe0a. The preparation itself has not been qualified on iOS 27. The previous successful warm runs used different native applications.

From the repository root, run `node scripts/voiceover-ios.mjs run-prepared --udid UUID --results DIRECTORY`; the optional `--scenario FILE` has the normal Safari format. The ordinary `run` remains a cold Safari test.

The command holds the existing simulator lock and preserves its boot state across two independent xcodebuild invocations:

1. A separate UIKit application exposes one unique accessible label. Its app posts a standard screen-change notification targeting this real element. The preparation test enables VoiceOver and polls only the current speech for up to 120 seconds; it never synthesizes announcements or moves the cursor. Only speech containing the unpredictable label qualifies. Teardown restores the original VoiceOver setting.
2. After exactly one passing preparation test on the selected UDID, Safari is tested in the regular Xcode project. Only the resulting `VoiceOver.xcresult`/Safari transcript and report qualify Safari behavior.

The first test keeps its own `Preparation.xcresult` with a `hoosaidthat-voiceover-preparation` attachment, plus `preparation-xcodebuild.log`. A failure stops before Safari starts. Do not use a passing preparation to claim Safari support.
