// Android's shell input skips the accessibility input filter. Register a virtual
// USB keyboard with Android's CTS uinput tool so the keys travel through TalkBack.
// Android keycodes -> Linux input keycodes (Android 15 data/keyboards/Generic.kl).
const keys = new Map([
  [57, 56], [59, 42], [113, 29], // Left Alt, Shift, Control
  [21, 105], [22, 106], [61, 15], [62, 57], [66, 28], [111, 1], // Left, Right, Tab, Space, Enter, Escape
  [30, 48], [31, 46], [32, 32], [33, 18], [35, 34], [36, 35], [37, 23], [40, 38], // B C D E G H I L
  [43, 24], [48, 20], [49, 22], [50, 47], [52, 45], [54, 44], // O T U V X Z
  [8, 2], [9, 3], [10, 4], [11, 5], [12, 6], [13, 7], // 1–6
]);
const modifiers = new Set([57, 59, 113]);
const withId = data => JSON.stringify({ id: 1, ...data });
const configuration = [{ type: 100, data: [1] }, { type: 101, data: [30, ...keys.values()] }]; // EV_KEY; include KEY_A to classify as alphabetic

export async function sendEmulatorChord(adb, chord) {
  if (!Array.isArray(chord) || !chord.length || !chord.every(code => keys.has(code)) ||
      new Set(chord).size !== chord.length || modifiers.has(chord.at(-1)) ||
      !chord.slice(0, -1).every(code => modifiers.has(code))) {
    throw new Error('unsupported TalkBack emulator keyboard chord');
  }
  const codes = chord.map(code => keys.get(code));
  const packets = (order, value) => order.flatMap(code => [1, code, value, 0, 0, 0]); // EV_KEY then SYN_REPORT
  const stream = [
    { command: 'register', name: 'HooSaidThat keyboard', vid: 6353, pid: 32767, bus: 'usb', configuration },
    // Android's uinput file playback requires a delay for InputReader registration.
    { command: 'delay', duration: 500 },
    { command: 'inject', events: packets(codes, 1) }, { command: 'delay', duration: 100 },
    { command: 'inject', events: packets(codes.toReversed(), 0) }, { command: 'delay', duration: 100 },
  ].map(withId).join('\n');
  // Only literals above and mapped numeric codes enter this command. EOF (or
  // disconnect) removes this invocation's keyboard, including any held keys.
  await adb('shell', '-T', `printf '%s\\n' '${stream}' | uinput -`);
}
