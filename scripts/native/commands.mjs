export function nativeCommands(screenReader) {
  if (screenReader !== 'talkback') throw new Error('native reader must be talkback');
  return talkbackCommands();
}

// Android keycodes, TalkBack's default keymap with the Alt trigger modifier.
// Source: google/talkback, keyboard/DefaultKeyComboModel.java.
// Probe actions use native accessibility focus; they never construct speech.
export function talkbackCommands() {
  const alt = 57, shift = 59, ctrl = 113;
  const commands = {
    nextFocusable: [[61]], previousFocusable: [[shift, 61]],
    activate: [[alt, 66]], activateWithSpace: [[62]], escape: [[111]],
    returnToPage: 'focusWeb', readCurrent: 'readCurrent',
    documentStart: [[alt, ctrl, 21]], documentEnd: [[alt, ctrl, 22]],
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
