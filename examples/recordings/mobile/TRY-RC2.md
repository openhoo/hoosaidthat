# Try the RC.2 recorder

Record a feature by hand with real VoiceOver or TalkBack. You can open a website, explore an installed app, or start directly in your own build. The MP4 includes the simulator screen and its audio. [Watch four examples](README.md).

## Install once

As of November 27, 2026, `0.1.6-rc.2` is available as a public preview outside the npm registry. In an empty directory with Node.js and npm, install the package and download the [standalone Bash companion](https://github.com/openhoo/hoosaidthat/blob/84904904bf0567c6f9896654e94b197977262504/examples/recordings/mobile/hst-film). No GitHub account is needed.

```sh
npm init -y
npm install --ignore-scripts https://raw.githubusercontent.com/openhoo/hoosaidthat/75faec6dba652ac2afc398341851f9aa56d6bda3/examples/recordings/mobile/preview/0.1.6-rc.2/openhoo-hoosaidthat-0.1.6-rc.2.tgz @playwright/test@1.62.1
curl -fLo hst-film https://raw.githubusercontent.com/openhoo/hoosaidthat/84904904bf0567c6f9896654e94b197977262504/examples/recordings/mobile/hst-film
chmod +x hst-film
./hst-film --help
```

Run the commands below from this directory. The helper uses its installed `node_modules/.bin/hoosaidthat-record`. If you prefer to verify or rebuild the SDK first, see the package details at the end.

## iPhone with VoiceOver

Follow the [iPhone setup](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/ios-voiceover.md) on a Mac with Xcode 27+, a booted iPhone simulator running iOS 27+, FFmpeg, and a dedicated audio loopback. In Device Hub, choose the loopback under **Device → Sound → Sound Output**. Leave the Mac’s own sound output on its usual device.

Copy your simulator’s UUID from `xcrun simctl list devices booted`, and set the actual name of its audio loopback:

```sh
export UDID="your-booted-iPhone-UUID"
export HST_AUDIO_DEVICE="BlackHole 2ch"
```

**Record your own build:**

```sh
./hst-film ios --install "/path/to/MyApp.app"
```

Use a **Simulator** build. The helper reads the bundle ID, installs the app on the selected iPhone, and opens it. To record a site or an app that’s already installed, open it in Device Hub and run `./hst-film ios`.

Wait for **Recording now**, navigate your feature, and let the last announcement finish. Press **Enter** or **Ctrl-C** in the terminal to save. Append `--duration 30` to stop after 30 seconds; a duration is required without an interactive terminal.

## Android with TalkBack

Follow the [Android emulator setup](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/oracle/android-talkback/README.md) on macOS or Linux with a graphical desktop. Install scrcpy, FFmpeg, the JDK, and Android SDK command-line tools (including `apkanalyzer` for your own APK). Prepare an AVD with TalkBack and a speech engine.

Set `ANDROID_HOME` to your SDK and `AVD` to the prepared emulator’s name. For example:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"  # On Linux this is often "$HOME/Android/Sdk"
"$ANDROID_HOME/emulator/emulator" -list-avds
export AVD="HST_TalkBack_API35"                  # Use a name from that list
```

**Record your own build:**

```sh
./hst-film android --install "/path/to/app-debug.apk"
```

Use a single installable APK. The helper reads its application ID and opens it in a disposable copy of the named emulator. Drive the feature in the scrcpy window. Let TalkBack finish, then **close the window** to save. Append `--duration 30` for a timed recording. To choose an existing app or visit a website yourself, run `./hst-film android`.

## Find or share the movie

Open `recording.mp4` in the run directory printed under `films/`. Set `HST_FILMS_DIR` to change where new recordings go. If a recording is quiet, you can make a listening copy with FFmpeg:

```sh
./hst-film louder "/path/to/recording.mp4"
```

This writes `recording-louder.mp4` next to the original. It copies the video stream, adjusts the audio level, and refuses to overwrite an existing copy.

For repeatable tests, use the SDK’s [scenario guide](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/mobile-recordings.md) and [booking example](https://github.com/openhoo/hoosaidthat/blob/2d99883002316be08700f6763303c72539929ac6/docs/examples/mobile/booking/booking.json). In a scripted iPhone Safari run, if XCTest reports that Safari has not loaded accessibility before the first feature action, close only Safari on the selected simulator and run the script again. Manual recording does not use XCTest.

## Package details

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
