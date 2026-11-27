# Try the RC.2 recorder

Record a native app or website by hand on a simulator. The MP4 includes the screen and the sound you heard, including VoiceOver or TalkBack and any app audio. No test script is required.

## Install the preview

As of November 27, 2026, `0.1.6-rc.2` has not been published to the npm registry. Install the public preview and its Playwright peer in an empty directory with Node.js and npm. No GitHub account or source build is needed.

```sh
npm init -y
npm install --ignore-scripts https://raw.githubusercontent.com/openhoo/hoosaidthat/75faec6dba652ac2afc398341851f9aa56d6bda3/examples/recordings/mobile/preview/0.1.6-rc.2/openhoo-hoosaidthat-0.1.6-rc.2.tgz @playwright/test@1.62.1
npx --no-install hoosaidthat-record --help
```

<details>
<summary>Download and check the tarball, rebuild from source, or get it from CI</summary>

To verify the tarball before installing, download it and check its SHA-256. On Linux, you can substitute `sha256sum -c -` for `shasum -a 256 -c -`.

```sh
curl -fLO https://raw.githubusercontent.com/openhoo/hoosaidthat/75faec6dba652ac2afc398341851f9aa56d6bda3/examples/recordings/mobile/preview/0.1.6-rc.2/openhoo-hoosaidthat-0.1.6-rc.2.tgz
printf '%s  %s\n' e1776e0b1d1415742d1ae5602415f03c76b0d7ab85caeaf91a66fb3a4ded8d85 openhoo-hoosaidthat-0.1.6-rc.2.tgz | shasum -a 256 -c -
```

When the checksum prints `OK`, install with `npm install --ignore-scripts ./openhoo-hoosaidthat-0.1.6-rc.2.tgz @playwright/test@1.62.1`.

The [signed preview commit](https://github.com/openhoo/hoosaidthat/commit/75faec6dba652ac2afc398341851f9aa56d6bda3) includes the [checksum file](https://raw.githubusercontent.com/openhoo/hoosaidthat/75faec6dba652ac2afc398341851f9aa56d6bda3/examples/recordings/mobile/preview/0.1.6-rc.2/SHA256SUMS). To rebuild the same package from the [signed SDK source](https://github.com/openhoo/hoosaidthat/commit/2d99883002316be08700f6763303c72539929ac6), start in a new directory. Node.js 24.22.3 and npm 11.20.0 produced the same SHA-256 as CI.

```sh
umask 022
curl -fL https://codeload.github.com/openhoo/hoosaidthat/tar.gz/2d99883002316be08700f6763303c72539929ac6 -o sdk-source.tar.gz
mkdir sdk-source
tar -xzf sdk-source.tar.gz --strip-components=1 -C sdk-source
(cd sdk-source && npm ci && npm run build && npm pack --pack-destination ..)
```

With a signed-in GitHub CLI, you can also retrieve the original from [CI](https://github.com/openhoo/hoosaidthat/actions/runs/45978539642) until December 27, 2026:

```sh
gh run download 45978539642 -R openhoo/hoosaidthat -n installable-sdk
```

Check and install either tarball with the commands above.

</details>

## Record a feature

**iPhone with VoiceOver.** Follow the [iPhone setup](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/ios-voiceover.md) on a Mac with Xcode 27+, a booted iPhone simulator running iOS 27+, FFmpeg and an audio loopback. In Device Hub, select the loopback under **Device → Sound → Sound Output** and leave the Mac’s own output on its usual device. Open your app or website. Set `UDID` to the iPhone identifier from `xcrun simctl list devices booted`. Use your loopback’s actual name in the command.

```sh
npx --no-install hoosaidthat-record ios --manual --udid "$UDID" --audio-device "BlackHole 2ch" --results films
```

When the terminal says **Recording now**, navigate in Device Hub. Let the last announcement finish and press **Enter** or **Ctrl-C** in the terminal to save. Without an interactive terminal, add `--duration 30` to stop after 30 seconds.

**Android with TalkBack.** Follow the [Android emulator setup](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/oracle/android-talkback/README.md) and install scrcpy and FFmpeg on a computer with a graphical desktop. Set `AVD` to the name of your prepared Android Virtual Device; `emulator -list-avds` lists the available names. Start in Settings, or substitute the package name of another app installed on that AVD.

```sh
npx --no-install hoosaidthat-record android --manual --avd "$AVD" --app com.android.settings --results films
```

Navigate in the scrcpy window. Let TalkBack finish speaking, then **close the window** to save. You can also add `--duration 30` for a timed recording. Omit `--app com.android.settings` to choose the app yourself.

On either platform, open `recording.mp4` in the run directory printed by the command under `films/`. To replay a feature automatically, see the [scenario guide](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/mobile-recordings.md) and [booking example](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/examples/mobile/booking/booking.json).
