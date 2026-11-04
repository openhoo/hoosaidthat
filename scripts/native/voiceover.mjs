import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KEY } from './commands.mjs';
const execute = promisify(execFile);
const KEY_CODES = new Map([
  [KEY.tab, 48], [KEY.enter, 36], [KEY.escape, 53], [KEY.space, 49],
  [KEY.home, 115], [KEY.end, 119], [KEY.left, 123], [KEY.right, 124],
  [KEY.up, 126], [KEY.down, 125], [KEY.f3, 99], [KEY.f4, 118], [KEY.f6, 97],
]);
const MODIFIERS = new Map([[KEY.control, 'control down'], [KEY.alt, 'option down'],
  [KEY.shift, 'shift down'], [KEY.command, 'command down']]);
const MODIFIER_CODES = new Map([[KEY.control, 59], [KEY.alt, 58], [KEY.shift, 56], [KEY.command, 55]]);

export function voiceOverKeyScript(keys) {
  const modifiers = keys.filter(key => MODIFIERS.has(key) && key !== KEY.shift).map(key => MODIFIERS.get(key));
  const ordinary = keys.filter(key => !MODIFIERS.has(key));
  if (!ordinary.length && keys.length === 1 && MODIFIER_CODES.has(keys[0])) {
    return `tell application "System Events" to key code ${MODIFIER_CODES.get(keys[0])}`;
  }
  if (ordinary.length !== 1) throw new Error('unsupported VoiceOver key chord');
  const key = ordinary[0];
  if (!KEY_CODES.has(key) && !/^[a-z0-9]$/.test(key)) throw new Error('unsupported VoiceOver key');
  const action = KEY_CODES.has(key) ? `key code ${KEY_CODES.get(key)}` : `keystroke ${JSON.stringify(key)}`;
  const command = `${action}${modifiers.length ? ` using {${modifiers.join(', ')}}` : ''}`;
  if (!keys.includes(KEY.shift)) return `tell application "System Events" to ${command}`;
  // Hold Shift physically, as Guidepup does, and release it on either the
  // success or failure path.
  return `tell application "System Events"\nkey down shift\ntry\n${command}\non error errorText number errorNumber\nkey up shift\nerror errorText number errorNumber\nend try\nkey up shift\nend tell`;
}

// Apple's native VoiceOver last-phrase scripting API. This is a sampled caption
// boundary, not a complete utterance stream: identical consecutive phrases and
// phrases replaced between polls cannot be distinguished. Never replay stale text.
export class VoiceOverDriver {
  capture = 'voiceover-last-phrase';
  outputSource = 'voiceover-applescript-last-phrase';
  #onSpeech;
  #lastPhrase = '';
  #failure;
  #closed = false;
  #timer;
  #chain = Promise.resolve();
  #execute;

  static async connect({ runScript } = {}) {
    const driver = new VoiceOverDriver(runScript);
    driver.#lastPhrase = await driver.#read();
    driver.#schedule();
    return driver;
  }
  constructor(runScript = async script => {
    const { stdout } = await execute('/usr/bin/osascript', ['-e', script], { timeout: 5000, maxBuffer: 65536 });
    return stdout.trimEnd();
  }) { this.#execute = runScript; }
  onSpeech(callback) { this.#onSpeech = callback; }
  assertReady() { if (this.#failure) throw this.#failure; if (this.#closed) throw new Error('VoiceOver driver closed'); }
  async drain() { this.assertReady(); await this.#enqueue(() => this.#sample()); }
  async press(chords) {
    this.assertReady();
    return this.#enqueue(async () => {
      for (const keys of chords) await this.#execute(voiceOverKeyScript(keys));
    });
  }
  async focusWeb(probe) {
    this.assertReady();
    let stage = 'VERIFY_CURSOR';
    return this.#enqueue(async () => {
      try {
        const deadline = Date.now() + 12000;
        let expectedDocument;
        let atDocument = false;
        const inDocument = async () => {
          stage = 'VERIFY_CURSOR';
          const state = await probe();
          if (!state.browserWindowActive) throw new Error('the owned browser lost native focus');
          expectedDocument ??= state.focus?.id;
          if (state.webContentFocused && expectedDocument && state.focus?.id !== expectedDocument) throw new Error('native focus changed to another document');
          if (typeof state.readerCursorInDocument !== 'boolean') throw new Error('native VoiceOver cursor verification is required');
          atDocument = state.readerCursorAtDocument === true;
          return state.readerCursorInDocument;
        };
        const move = direction => {
          stage = `MOVE_${direction.toUpperCase().replaceAll(' ', '_')}`;
          return this.#execute(`tell application "VoiceOver" to tell vo cursor to move ${direction}`);
        };
        if (await inDocument()) return;
        stage = 'ALIGN_KEYBOARD';
        await this.#execute('tell application "VoiceOver" to tell commander to perform command "move voiceover cursor to keyboard focus"');
        if (await inDocument()) return;
        // Chrome can retain VoiceOver inside a toolbar group after opening a
        // test window. Leave that scope, then traverse the native window tree.
        // Every success is verified by AX hit-testing the actual VO cursor.
        for (let index = 0; index < 6; index++) await move('out of item');
        await move('into item');
        for (let index = 0; index < 16 && Date.now() < deadline; index++) {
          if (await inDocument()) return;
          if (atDocument) {
            await move('into item');
            if (!(await inDocument())) throw new Error('VoiceOver left the verified web document');
            return;
          }
          await move('right');
        }
        stage = 'ENTER_DOCUMENT';
        throw new Error('VoiceOver cursor did not enter the owned web document');
      } catch (error) {
        const reasons = new Map([
          ['the owned browser lost native focus', 'BROWSER_FOCUS_LOST'],
          ['native focus changed to another document', 'DOCUMENT_CHANGED'],
          ['native VoiceOver cursor verification is required', 'MISSING_CURSOR_PROOF'],
          ['VoiceOver left the verified web document', 'LEFT_DOCUMENT'],
          ['VoiceOver cursor did not enter the owned web document', 'DOCUMENT_NOT_FOUND'],
        ]);
        const reason = error.killed ? 'TIMEOUT' : reasons.get(error.message) ?? 'SCRIPT_ERROR';
        error.nativeFaultCode = `VOICEOVER_${stage}_${reason}`;
        throw error;
      }
    });
  }
  async close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#chain.catch(() => {});
  }
  #enqueue(callback) {
    const operation = this.#chain.then(callback);
    this.#chain = operation.catch(error => { this.#failure ??= error; });
    return operation;
  }
  #read() {
    // Normalize the native missing value before serialization. Scripting and
    // authorization failures still reject and make the driver unhealthy.
    return this.#execute('tell application "VoiceOver"\nset phraseText to content of last phrase\nif phraseText is missing value then return ""\nreturn phraseText\nend tell').catch(error => {
      error.nativeFaultCode = 'VOICEOVER_PHRASE_SCRIPT_ERROR';
      error.nativeScriptNumber = Number(/\((-?\d+)\)\s*$/.exec(error.stderr ?? '')?.[1]) || undefined;
      throw error;
    });
  }
  async #sample() {
    const phrase = await this.#read();
    if (typeof phrase !== 'string' || Buffer.byteLength(phrase) > 16384) throw new Error('invalid VoiceOver phrase');
    if (phrase !== this.#lastPhrase) {
      this.#lastPhrase = phrase;
      if (phrase.trim()) this.#onSpeech?.(phrase);
    }
  }
  #schedule() {
    if (this.#closed || this.#failure) return;
    this.#timer = setTimeout(async () => {
      await this.#enqueue(() => this.#sample()).catch(() => {});
      this.#schedule();
    }, 100);
    this.#timer.unref();
  }
}
