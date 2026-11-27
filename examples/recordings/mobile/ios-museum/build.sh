#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
app="$PWD/build/MuseumBooking.app"
mkdir -p "$app"
xcrun --sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios27.0-simulator -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" App/Control.swift -o "$app/MuseumBooking"
python3 - "$app/Info.plist" <<'PY'
import sys,plistlib
with open(sys.argv[1],'wb') as out: plistlib.dump(dict(CFBundleIdentifier='ai.openhoo.hoosaidthat.MuseumBookingControl',CFBundleExecutable='MuseumBooking',CFBundleName='Museum Booking',CFBundleDisplayName='Museum Booking',CFBundlePackageType='APPL',CFBundleShortVersionString='1.0',CFBundleVersion='1',CFBundleSupportedPlatforms=['iPhoneSimulator'],MinimumOSVersion='27.0',UIDeviceFamily=[1],UILaunchScreen={},UIApplicationSceneManifest={'UIApplicationSupportsMultipleScenes':False,'UISceneConfigurations':{}}),out)
PY
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify "$app"
