#!/bin/bash
set -euo pipefail
case "$(sysctl -n hw.model)" in VirtualMac*) ;; *) echo 'Refusing native test outside a macOS VM' >&2; exit 1;; esac
shared='/Volumes/My Shared Files/hoosaidthat'
test -f "$shared/guest-only-marker"
work="$HOME/hoosaidthat-voiceover"
cd "$work"
export PATH="$work/runtime/node-v26.13.0-darwin-arm64/bin:$PATH"
export SCREEN_READER=voiceover
export HST_NATIVE_TOKEN_FILE="$shared/control-token"
export HST_NATIVE_RESULTS="$shared/results/artifacts"
export HST_NATIVE_JSON="$shared/results/native-results.json"
mkdir -p "$shared/results"
# This process runs in the guest's logged-in desktop, even when SSH is headless.
# Request the same native reader activation used by the Command-F5 shortcut.
# Merely opening VoiceOver.app can leave the reader inactive. This native
# framework entry point is also used by Guidepup's macOS driver.
/usr/bin/osascript -l JavaScript <<'JXA'
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
$.dlopen('/usr/lib/libScreenReader.dylib', 1);
ObjC.bindFunction('_ScreenReaderStart', ['void', ['int']]);
$._ScreenReaderStart(0);
JXA
bridge=''
cleanup() {
  if [ -n "$bridge" ]; then kill -TERM "$bridge" 2>/dev/null || true; wait "$bridge" 2>/dev/null || true; fi
  pkill -x VoiceOver || true
}
trap cleanup EXIT
sleep 12
# Allow the freshly granted guest permissions and desktop services to settle
# before preparing Focus and dismissing existing native notification alerts.
/usr/bin/osascript -l JavaScript "$work/node_modules/@openhoo/hoosaidthat/oracle/macos-voiceover/quiet-desktop.js"
browser="$(node --input-type=module -e 'import { chromium } from "@playwright/test"; console.log(chromium.executablePath())')"
node node_modules/@openhoo/hoosaidthat/scripts/native-screen-reader.mjs --screen-reader voiceover --token-file "$HST_NATIVE_TOKEN_FILE" --browser-executable "$browser" >"$shared/results/bridge.log" 2>&1 &
bridge=$!
node --input-type=module - "$bridge" <<'JS'
import { readFileSync } from 'node:fs';
const token=readFileSync(process.env.HST_NATIVE_TOKEN_FILE,'utf8').trim();
const bridgePid=Number(process.argv[2]);
const deadline=Date.now()+45000;
while(Date.now()<deadline) {
  try { process.kill(bridgePid,0); } catch { throw new Error('VoiceOver bridge exited before readiness; see results/bridge.log'); }
  try { const response=await fetch('http://127.0.0.1:3003/v2/health',{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)}); if(response.ok) process.exit(0); } catch {}
  await new Promise(resolve=>setTimeout(resolve,500));
}
throw new Error('VoiceOver bridge did not become ready; see results/bridge.log');
JS
npx --no-install playwright test --config node_modules/@openhoo/hoosaidthat/oracle/native-check/playwright.config.mjs
