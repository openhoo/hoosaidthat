#!/bin/bash
set -euo pipefail
# This script is shipped for the disposable guest only. Never configure the host.
case "$(sysctl -n hw.model)" in VirtualMac*) ;; *) echo 'Refusing to configure VoiceOver outside a macOS VM' >&2; exit 1;; esac
shared='/Volumes/My Shared Files/hoosaidthat'
test -f "$shared/guest-only-marker"
work="$HOME/hoosaidthat-voiceover"
mkdir -p "$work"
cp "$shared/payload/hoosaidthat.tgz" "$work/hoosaidthat.tgz"
cp "$shared/payload/runtime-lock.json" "$work/runtime-lock.json"
cd "$work"
/usr/bin/python3 - <<'PY'
import hashlib,json,os,tarfile,urllib.request
spec=json.load(open('runtime-lock.json'))['node']
if not os.path.exists('node.tar.gz') or hashlib.sha256(open('node.tar.gz','rb').read()).hexdigest()!=spec['sha256']:
    urllib.request.urlretrieve(spec['url'],'node.tar.gz')
    if hashlib.sha256(open('node.tar.gz','rb').read()).hexdigest()!=spec['sha256']: raise RuntimeError('Node SHA-256 mismatch')
with tarfile.open('node.tar.gz') as archive: archive.extractall('runtime')
PY
export PATH="$work/runtime/node-v26.13.0-darwin-arm64/bin:$PATH"
npm install --ignore-scripts --no-audit --no-fund ./hoosaidthat.tgz '@playwright/test@1.62.1'
npx --no-install playwright install chromium
# Use Apple's supported scripting preference, solely in the fresh guest.
defaults write com.apple.VoiceOver4/default SCREnableAppleScript -bool true
defaults write com.apple.VoiceOverTraining doNotShowSplashScreen -bool true
# Prevent macOS from presenting a microphone prompt during modifier gestures.
# This is the same guest preference used by Guidepup's automation setup.
defaults write com.apple.HIToolbox AppleDictationAutoEnable -bool false
# Tab must reach buttons as well as text inputs in the guest browser.
defaults write NSGlobalDomain AppleKeyboardUIMode -int 2
if ! test -e /private/var/db/Accessibility/.VoiceOverAppleScriptEnabled; then
  if ! csrutil status | /usr/bin/grep -q 'status: disabled'; then
    echo 'Enable VoiceOver AppleScript control in the guest UI; its authorization flag is protected by SIP.' >&2
    exit 1
  fi
  # Matches Apple's authorization marker used by VoiceOver Utility and the
  # official Guidepup CI setup, only in this guarded disposable guest.
  sudo -n /bin/sh -c 'printf a > /private/var/db/Accessibility/.VoiceOverAppleScriptEnabled'
fi
# Current Cirrus base images allow CI provisioning of TCC. This uses named
# columns, grants only AX/keyboard and the two automation targets, and never
# changes SIP. A protected or unknown database fails instead of broadening access.
/usr/bin/python3 "$shared/payload/permissions.py"
# A Cirrus background-activity banner can cover the native VoiceOver cursor.
# Use the guest's actual Focus controls; keep strict cursor hit-testing enabled.
/usr/bin/osascript -l JavaScript "$work/node_modules/@openhoo/hoosaidthat/oracle/macos-voiceover/quiet-desktop.js"
echo 'Guest provisioned; native speech still must pass the startup probe.'
