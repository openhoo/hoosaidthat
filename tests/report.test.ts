import assert from 'node:assert/strict';
import test from 'node:test';
import { addReportAudio, renderScreenReaderReport, sourceBounds, type ReportSnapshot } from '../src/report.js';
import { resolveOptions, type DownloadedArtifact, type SpeechEvent, type ScreenReaderHealth } from '../src/types.js';

const speech: SpeechEvent = { kind: 'speech', sequence: 2, monotonicNs: 9_000_000_000, command: 'nextHeading', text: 'Checkout heading level 1', source: { bus: ':1', path: '/heading' }, provenance: 'screenReaderOutput' };
const snapshot = (): ReportSnapshot => ({ index: 1, width: 800, height: 600, annotations: [{ speech }], observation: { action: 'nextHeading', label: 'Next heading', speech: speech.text, braille: '', speechEvents: [speech], brailleEvents: [], events: [speech], timedOut: false } });
const runtime: ScreenReaderHealth = { protocolVersion: 2, status: 'ready', screenReader: { name: 'hoovda', version: 'test', capture: 'hoovda-structured-presentation' }, platform: 'linux' };
const artifact = (name: string, body: Buffer): DownloadedArtifact => ({ name, body, contentType: 'application/json', bytes: body.length, sha256: '' });

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 12);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(1000, 24); bytes.writeUInt32LE(2000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(12, 40);
  [11, 22, 33, 44, 55, 66].forEach((sample, i) => bytes.writeInt16LE(sample, 44 + i * 2));
  return bytes;
}

test('web reports are opt in and validated', () => {
  assert.equal(resolveOptions().webReport, 'off');
  assert.equal(resolveOptions({ webReport: 'on' }).webReport, 'on');
  assert.throws(() => resolveOptions({ webReport: 'yes' as 'on' }), /webReport/);
});

test('native identity maps through document viewport and clips offscreen bounds', () => {
  const rootID = { bus: ':1', path: '/document' };
  const doc = { nodes: [
    { id: rootID, role: 'document web', attributes: { url: 'https://example.test/' }, bounds: { x: 50, y: 100, width: 800, height: 600 } },
    { id: speech.source, parent: rootID, bounds: { x: 40, y: 150, width: 110, height: 30 } },
  ] };
  assert.deepEqual(sourceBounds(doc, 'https://example.test/', speech, 800, 600), { x: 0, y: 50, width: 100, height: 30 });
  assert.equal(sourceBounds(doc, 'https://other.test/', speech, 800, 600), undefined);
  assert.equal(sourceBounds(doc, 'https://example.test/', { ...speech, source: { bus: ':1', path: '/other' } }, 800, 600), undefined);
});

test('audio uses exact exported samples rather than runtime timestamps', () => {
  const entry = snapshot();
  addReportAudio([entry], [artifact('screenreader-events', Buffer.from(JSON.stringify({ audioTimeline: [{ monotonicNs: speech.monotonicNs, startSample: 2, sampleCount: 3, sampleRate: 1000 }] }))), artifact('screenreader-audio', wav())]);
  const audio = entry.annotations[0]!.audio!;
  assert.equal(audio.startSample, 2);
  const clip = Buffer.from(audio.data.split(',')[1]!, 'base64');
  assert.equal(clip.readUInt32LE(40), 6);
  assert.deepEqual([...clip.subarray(44)], [33, 0, 44, 0, 55, 0]);
});

test('missing, ambiguous, mismatched and out of range audio indices stay unavailable', () => {
  for (const indices of [undefined, [{ monotonicNs: speech.monotonicNs, startSample: 99, sampleCount: 3, sampleRate: 1000 }], [{ monotonicNs: speech.monotonicNs, startSample: 2, sampleCount: 3, sampleRate: 2000 }], Array(2).fill({ monotonicNs: speech.monotonicNs, startSample: 2, sampleCount: 3, sampleRate: 1000 })]) {
    const entry = snapshot();
    addReportAudio([entry], [artifact('screenreader-events', Buffer.from(JSON.stringify({ audioTimeline: indices }))), artifact('screenreader-audio', wav())]);
    assert.equal(entry.annotations[0]!.audio, undefined);
  }
});

test('malformed recording manifests preserve the report without fabricated audio', () => {
  const entry = snapshot();
  assert.doesNotThrow(() => addReportAudio([entry], [artifact('screenreader-events', Buffer.from('{')), artifact('screenreader-audio', wav())]));
  assert.equal(entry.annotations[0]!.audio, undefined);
});

test('invalid duplicate timeline entries cannot disambiguate a speech timestamp', () => {
  const entry = snapshot();
  const valid = { monotonicNs: speech.monotonicNs, startSample: 2, sampleCount: 3, sampleRate: 1000 };
  addReportAudio([entry], [artifact('screenreader-events', Buffer.from(JSON.stringify({ audioTimeline: [valid, { ...valid, sampleCount: -1 }] }))), artifact('screenreader-audio', wav())]);
  assert.equal(entry.annotations[0]!.audio, undefined);
});

test('malformed and ambiguous WAV containers never provide original audio', () => {
  const manifest = artifact('screenreader-events', Buffer.from(JSON.stringify({ audioTimeline: [{ monotonicNs: speech.monotonicNs, startSample: 2, sampleCount: 3, sampleRate: 1000 }] })));
  const badRiffLength = wav();
  badRiffLength.writeUInt32LE(4, 4);
  const badBlockSize = wav();
  badBlockSize.writeUInt16LE(1, 32);
  const partialFrame = wav().subarray(0, 55);
  partialFrame.writeUInt32LE(partialFrame.length - 8, 4);
  partialFrame.writeUInt32LE(11, 40);
  const duplicateData = Buffer.concat([wav(), wav().subarray(36)]);
  duplicateData.writeUInt32LE(duplicateData.length - 8, 4);
  for (const body of [badRiffLength, badBlockSize, partialFrame, duplicateData]) {
    const entry = snapshot();
    addReportAudio([entry], [manifest, artifact('screenreader-audio', body)]);
    assert.equal(entry.annotations[0]!.audio, undefined);
  }
});

test('odd length PCM clips keep their exact sample count and RIFF padding', () => {
  const bytes = Buffer.alloc(50);
  wav().copy(bytes, 0, 0, 44);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.writeUInt32LE(1000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.writeUInt32LE(6, 40);
  bytes.set([11, 22, 33, 44, 55, 66], 44);
  const entry = snapshot();
  addReportAudio([entry], [artifact('screenreader-events', Buffer.from(JSON.stringify({ audioTimeline: [{ monotonicNs: speech.monotonicNs, startSample: 2, sampleCount: 3, sampleRate: 1000 }] }))), artifact('screenreader-audio', bytes)]);
  const clip = Buffer.from(entry.annotations[0]!.audio!.data.split(',')[1]!, 'base64');
  assert.equal(clip.readUInt32LE(40), 3);
  assert.equal(clip.length, 48);
  assert.equal(clip.readUInt32LE(4), 40);
  assert.deepEqual([...clip.subarray(44)], [33, 44, 55, 0]);
});

test('ambiguous native identities and invalid viewport dimensions remain unpositioned', () => {
  const rootID = { bus: ':1', path: '/document' };
  const root = { id: rootID, role: 'document web', attributes: { url: 'https://example.test/' }, bounds: { x: 50, y: 100, width: 800, height: 600 } };
  const node = { id: speech.source, parent: rootID, bounds: { x: 60, y: 150, width: 100, height: 30 } };
  assert.equal(sourceBounds({ nodes: [root, node, node] }, 'https://example.test/', speech, 800, 600), undefined);
  assert.equal(sourceBounds({ nodes: [root, node] }, 'https://example.test/', speech, Number.POSITIVE_INFINITY, 600), undefined);
});

test('anonymous, corrupt and duplicate document identities never establish native association', () => {
  const rootID = { bus: ':1', path: '/document' };
  const baseRoot = { role: 'document web', attributes: { url: 'https://example.test/' }, bounds: { x: 50, y: 100, width: 800, height: 600 } };
  const node = { id: speech.source, parent: rootID, bounds: { x: 60, y: 150, width: 100, height: 30 } };
  assert.equal(sourceBounds({ nodes: [baseRoot, node] }, 'https://example.test/', speech, 800, 600), undefined, 'An anonymous viewport cannot claim an unrelated source');
  for (const id of [{ bus: '', path: '/document' }, { bus: ':1', path: 'document' }, { bus: ':1', path: '/org/a11y/atspi/null' }]) {
    const root = { ...baseRoot, id };
    assert.equal(sourceBounds({ nodes: [root] }, 'https://example.test/', { ...speech, source: id }, 800, 600), undefined, 'Matching a corrupt root source is insufficient');
  }
  const root = { ...baseRoot, id: rootID };
  assert.equal(sourceBounds({ nodes: [root, { id: rootID, role: 'frame' }, node] }, 'https://example.test/', speech, 800, 600), undefined, 'A duplicate viewport identity is ambiguous even across roles');
  assert.deepEqual(sourceBounds({ nodes: [root] }, 'https://example.test/', { ...speech, source: rootID }, 800, 600), { x: 0, y: 0, width: 800, height: 600 }, 'A uniquely identified document source remains valid');
});

test('native geometry is only associated with descendants of the captured page', () => {
  const rootID = { bus: ':1', path: '/document' };
  const root = { id: rootID, role: 'document web', attributes: { url: 'https://example.test/' }, bounds: { x: 50, y: 100, width: 800, height: 600 } };
  const node = { id: speech.source, parent: { bus: ':1', path: '/other-document' }, bounds: { x: 60, y: 150, width: 100, height: 30 } };
  assert.equal(sourceBounds({ nodes: [root, node] }, 'https://example.test/', speech, 800, 600), undefined);
  assert.deepEqual(sourceBounds({ nodes: [root, { ...node, parent: rootID }] }, 'https://example.test/', speech, 800, 600), { x: 10, y: 50, width: 100, height: 30 });
});

test('same-URL child documents use the uniquely identified top document viewport', () => {
  const rootID = { bus: ':1', path: '/document' };
  const frameID = { bus: ':1', path: '/frame' };
  const root = { id: rootID, role: 'document web', attributes: { url: 'https://example.test/' }, bounds: { x: 50, y: 100, width: 800, height: 600 } };
  const frame = { id: frameID, parent: rootID, role: 'document web', attributes: { url: 'https://example.test/' }, bounds: { x: 100, y: 150, width: 300, height: 200 } };
  const node = { id: speech.source, parent: frameID, bounds: { x: 120, y: 180, width: 100, height: 30 } };
  assert.deepEqual(sourceBounds({ nodes: [root, frame, node] }, 'https://example.test/', speech, 800, 600), { x: 70, y: 80, width: 100, height: 30 });
  assert.equal(sourceBounds({ nodes: [root, { ...frame, parent: undefined }, node] }, 'https://example.test/', speech, 800, 600), undefined, 'Independent same-URL roots remain ambiguous');
});

test('untrusted titles and speech cannot escape embedded JSON or create HTML', () => {
  const entry = snapshot();
  entry.annotations[0]!.speech = { ...speech, text: '</script><script>window.pwned=true</script>' };
  const html = renderScreenReaderReport({ title: '</script><img src=x onerror=alert(1)>', runtime, snapshots: [entry] });
  assert.equal(html.includes('</script><img'), false);
  assert.equal(html.includes('</script><script>window.pwned'), false);
  assert.match(html, /connect-src 'none'/);
  assert.equal(html.includes('speechSynthesis'), false);
});
