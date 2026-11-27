// AT Driver uses WebDriver key code points. Each array is one OS key chord.
// Source: Apple's VoiceOver command reference.
export const KEY = Object.freeze({
  tab: '\ue004', enter: '\ue007', shift: '\ue008', control: '\ue009',
  alt: '\ue00a', escape: '\ue00c', space: '\ue00d', end: '\ue010',
  home: '\ue011', left: '\ue012', up: '\ue013', right: '\ue014',
  down: '\ue015', insert: '\ue016', f3: '\ue033', f4: '\ue034',
  f6: '\ue036', f7: '\ue037', command: '\ue03d',
});

export function nativeCommands(screenReader) {
  if (screenReader === 'talkback') return talkbackCommands();
  const k = KEY;
  const common = {
    nextFocusable: [[k.tab]], previousFocusable: [[k.shift, k.tab]],
    activateWithSpace: [[k.space]], escape: [[k.escape]],
    returnToPage: [[k.f6]], stopSpeech: [[k.control]],
  };
  if (screenReader === 'jaws') {
    const commands = {
      ...common, activate: [[k.enter]],
      readCurrent: [[k.insert, k.tab]], reportTitle: [[k.insert, 't']],
      reportCurrentLine: [[k.insert, k.up]], sayAll: [[k.insert, k.down]],
      documentStart: [[k.control, k.home]], documentEnd: [[k.control, k.end]],
      nextLine: [[k.down]], previousLine: [[k.up]],
      nextCharacter: [[k.right]], previousCharacter: [[k.left]],
      nextWord: [[k.control, k.right]], previousWord: [[k.control, k.left]],
      nextTableColumn: [[k.control, k.alt, k.right]],
      previousTableColumn: [[k.control, k.alt, k.left]],
      nextTableRow: [[k.control, k.alt, k.down]],
      previousTableRow: [[k.control, k.alt, k.up]],
      elementsList: [[k.insert, k.f3]],
    };
    // JAWS K is PlaceMarker, and C includes list boxes and tree views.
    // Neither shortcut implements a generic link-only or combo-box-only action.
    const quick = {
      Heading: 'h', Landmark: 'r', Button: 'b', FormField: 'f',
      RadioButton: 'a', Entry: 'e', Image: 'g', ListItem: 'i', List: 'l',
      Frame: 'm', NotLinkBlock: 'n', Article: 'o', Paragraph: 'p',
      Table: 't', UnvisitedLink: 'u', VisitedLink: 'v', Checkbox: 'x',
      Separator: '-', Tab: "'",
    };
    for (let level = 1; level <= 6; level++) quick[`Heading${level}`] = String(level);
    for (const [name, key] of Object.entries(quick)) {
      commands[`next${name}`] = [[key]];
      commands[`previous${name}`] = [[k.shift, key]];
    }
    return commands;
  }
  if (screenReader !== 'voiceover') throw new Error('native reader must be jaws, voiceover or talkback');
  const vo = [k.control, k.alt];
  const commands = {
    ...common, activate: [[...vo, k.space]],
    // Chrome's native address-bar round trip returns keyboard focus to content.
    // The default VoiceOver driver then verifies its own cursor through AX.
    returnToPage: [[k.command, 'l'], [k.escape]],
    moveToFocusObject: [[...vo, k.shift, k.f4]],
    readCurrent: [[...vo, k.f3]],
    reportCurrentLine: [[...vo, 'l']], sayAll: [[...vo, 'a']],
    documentStart: [[...vo, k.shift, k.home]],
    documentEnd: [[...vo, k.shift, k.end]],
    elementsList: [[...vo, 'u']],
  };
  const quick = { Heading: 'h', Link: 'l', Table: 't', Image: 'g', VisitedLink: 'v' };
  for (const [name, key] of Object.entries(quick)) {
    commands[`next${name}`] = [[...vo, k.command, key]];
    commands[`previous${name}`] = [[...vo, k.command, k.shift, key]];
  }
  return commands;
}

// Android keycodes, TalkBack's default keymap with the Alt trigger modifier.
// Source: google/talkback, keyboard/DefaultKeyComboModel.java.
// Probe actions use native accessibility focus; they never construct speech.
export function talkbackCommands() {
  const alt = 57, shift = 59, ctrl = 113;
  const commands = {
    nextFocusable: [[61]], previousFocusable: [[shift, 61]],
    // TalkBack navigation follows reading order, including non-focusable text.
    moveToNextObjectFlat: [[alt, 22]], moveToPreviousObjectFlat: [[alt, 21]],
    activate: [[alt, 66]], activateWithSpace: [[62]], escape: [[111]],
    returnToPage: 'focusWeb', readCurrent: 'readCurrent',
    documentStart: 'documentStart', documentEnd: 'documentEnd',
    sayAll: [[alt, ctrl, shift, 66]],
    nextCharacter: [[alt, shift, 22]], previousCharacter: [[alt, shift, 21]],
    nextWord: [[alt, ctrl, shift, 22]], previousWord: [[alt, ctrl, shift, 21]],
  };
  const quick = { Heading: 36, Landmark: 32, Button: 30, FormField: 31,
    Checkbox: 52, Combobox: 54, Entry: 33, Image: 35, Link: 40,
    List: 43, ListItem: 37, Table: 48, VisitedLink: 50, UnvisitedLink: 49 };
  for (let level = 1; level <= 6; level++) quick[`Heading${level}`] = 7 + level;
  for (const [name, key] of Object.entries(quick)) {
    commands[`next${name}`] = [[alt, key]];
    commands[`previous${name}`] = [[alt, shift, key]];
  }
  return commands;
}
