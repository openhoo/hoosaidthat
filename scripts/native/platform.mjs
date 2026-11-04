import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const executeFile = promisify(execFile);
async function executeProbe(stage, binary, args, options) {
  try { return await executeFile(binary, args, options); }
  catch (error) {
    error.nativeFaultCode = `VOICEOVER_${stage}_${error.killed ? 'TIMEOUT' : 'SCRIPT_ERROR'}`;
    error.nativeScriptNumber = Number(/\((-?\d+)\)\s*$/.exec(error.stderr ?? '')?.[1]) || undefined;
    throw error;
  }
}

export function assertNativePlatform(screenReader, platform = process.platform) {
  if (screenReader !== 'voiceover') throw new Error('native reader must be voiceover');
  const expected = 'darwin';
  if (platform !== expected) {
    throw new Error(`${screenReader} requires an interactive ${'macOS'} host; Linux containers can run the Playwright client`);
  }
}

export function voiceOverCursorMembership(rectangle, positionBytes, sizeBytes, hits) {
  function pair(encoded) {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(encoded)) throw new Error('invalid native document geometry');
    const bytes = Buffer.from(encoded, 'base64');
    const values = [bytes.readDoubleLE(0), bytes.readDoubleLE(8)];
    if (bytes.length !== 16 || !values.every(Number.isFinite)) throw new Error('invalid native document geometry');
    return values;
  }
  const [x, y] = pair(positionBytes);
  const [width, height] = pair(sizeBytes);
  if (width <= 0 || height <= 0) throw new Error('invalid native document geometry');
  // The VO outline can include a native scrollbar and its small focus border.
  // A selected web area requires interaction even when all AX hit tests pass.
  const atDocument = Math.abs(rectangle[0] - x) <= 4 && Math.abs(rectangle[1] - y) <= 4 &&
    Math.abs(rectangle[2] - rectangle[0] - width) <= 24 &&
    Math.abs(rectangle[3] - rectangle[1] - height) <= 24;
  return { readerCursorInDocument: hits.readerCursorInDocument === true && !atDocument,
    readerCursorAtDocument: hits.readerCursorAtDocument === true && atDocument };
}

export async function nativeProbe(screenReader, browserPid, { voiceOverCursor = false } = {}) {
  assertNativePlatform(screenReader);
  if (!Number.isSafeInteger(browserPid) || browserPid <= 0) throw new Error('native browser PID is required');
  const directory = new URL('.', import.meta.url);
  const command = '/usr/bin/osascript';
  const args = ['-l', 'JavaScript', fileURLToPath(new URL('focus-macos.js', directory)), String(browserPid)];
  let rectangle;
  if (screenReader === 'voiceover' && voiceOverCursor) {
    const { stdout: bounds } = await executeProbe('CURSOR', '/usr/bin/osascript', ['-e', 'tell application "VoiceOver" to return bounds of vo cursor'], { timeout: 5000, maxBuffer: 1024 });
    rectangle = bounds.trim().split(/,\s*/).map(Number);
    if (rectangle.length !== 4 || !rectangle.every(Number.isFinite)) throw new Error('invalid native VoiceOver cursor bounds');
    args.push(JSON.stringify(rectangle));
  }
  const { stdout } = await executeProbe('AX_FOCUS', command, args, { timeout: 5000, maxBuffer: 65536, windowsHide: true });
  const value = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (value.screenReader !== screenReader || typeof value.browserWindowActive !== 'boolean' ||
      typeof value.webContentFocused !== 'boolean' ||
      !(value.documentTitle === null || typeof value.documentTitle === 'string') ||
      !(value.documentURL === null || typeof value.documentURL === 'string')) {
    throw new Error('invalid native accessibility probe');
  }
  if (rectangle && value.webContentFocused) {
    Object.assign(value, voiceOverCursorMembership(rectangle, value.documentPosition, value.documentSize, value));
  }
  if (screenReader === 'voiceover') {
    const [os, bundle] = await Promise.all([
      executeProbe('OS_VERSION', '/usr/bin/sw_vers', ['-productVersion'], { timeout: 3000 }),
      executeProbe('READER_VERSION', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '-c', 'Print :CFBundleVersion',
        '/System/Library/CoreServices/VoiceOver.app/Contents/Info.plist'], { timeout: 3000 }),
    ]);
    const [shortVersion, build] = bundle.stdout.trim().split(/\r?\n/);
    if (!shortVersion || !build) throw new Error('could not identify the native VoiceOver bundle');
    value.version = `${shortVersion} (${build}) macOS ${os.stdout.trim()}`;
  }
  if (typeof value.version !== 'string' || !/^\d[\w. +()-]{0,99}$/.test(value.version)) throw new Error('invalid native screen reader version');
  const focus = value.webContentFocused ? {
    id: `native-document:${browserPid}:${createHash('sha256').update(value.documentURL ?? value.documentTitle ?? '').digest('hex')}`,
    role: 'document web', name: value.documentTitle,
    ...(value.documentURL ? { documentUrlSha256: createHash('sha256').update(value.documentURL).digest('hex') } : {}),
    location: null,
  } : null;
  // Raw URLs remain inside the native host. Protected field contents are never read.
  return { version: value.version, browserWindowActive: value.browserWindowActive,
    webContentFocused: value.webContentFocused, focus,
    ...(typeof value.readerCursorInDocument === 'boolean' ? { readerCursorInDocument: value.readerCursorInDocument } : {}),
    ...(typeof value.readerCursorAtDocument === 'boolean' ? { readerCursorAtDocument: value.readerCursorAtDocument } : {}) };
}
