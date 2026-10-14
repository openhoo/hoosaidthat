import { reportWebsite } from './report-viewer.js';
import type { Page } from '@playwright/test';
import type { DownloadedArtifact, ScreenReaderHealth, ScreenReaderObservation, SpeechEvent } from './types.js';

export interface ReportRect { x: number; y: number; width: number; height: number }
export interface ReportAnnotation {
  /** Original captured speech event, including its source and provenance. */
  speech: SpeechEvent;
  bounds?: ReportRect;
  association?: 'native-source' | 'explicit-focus-target';
  audio?: { data: string; startSample: number; sampleCount: number; sampleRate: number };
}
export interface ReportSnapshot {
  index: number;
  observation: ScreenReaderObservation;
  width: number;
  height: number;
  image?: string;
  annotations: ReportAnnotation[];
  error?: string;
}
export interface ScreenReaderReport {
  title: string;
  runtime: ScreenReaderHealth;
  snapshots: ReportSnapshot[];
}

type NativeID = { bus: string; path: string };
type NativeNode = { id?: NativeID; parent?: NativeID; role?: string; bounds?: ReportRect; attributes?: { url?: string } };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const finiteRect = (value: unknown): value is ReportRect => object(value) &&
  ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
  Number(value.width) > 0 && Number(value.height) > 0;

/** Match by native object identity, never by similarity between spoken text and DOM text. */
export function sourceBounds(document: unknown, url: string, speech: SpeechEvent, width: number, height: number): ReportRect | undefined {
  if (!speech.source || !object(document) || !Array.isArray(document.nodes) ||
    !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const nodes = document.nodes.filter(object) as NativeNode[];
  const key = (id: unknown): string | undefined => object(id) && typeof id.bus === 'string' && id.bus.length > 0 &&
    typeof id.path === 'string' && id.path.startsWith('/') && id.path !== '/org/a11y/atspi/null' ? JSON.stringify([id.bus, id.path]) : undefined;
  const identities = new Map<string, NativeNode | undefined>();
  for (const node of nodes) {
    const identity = key(node.id);
    if (identity) identities.set(identity, identities.has(identity) ? undefined : node);
  }
  const unique = (node: NativeNode): boolean => {
    const identity = key(node.id);
    return identity !== undefined && identities.get(identity) === node;
  };
  const within = (node: NativeNode, root: NativeNode): boolean => {
    if (!unique(root)) return false;
    const visited = new Set<NativeNode>();
    let ancestor: NativeNode | undefined = node;
    while (ancestor) {
      if (!unique(ancestor) || visited.has(ancestor)) return false;
      if (ancestor === root) return true;
      visited.add(ancestor);
      const parent = key(ancestor.parent);
      ancestor = parent ? identities.get(parent) : undefined;
    }
    return false;
  };
  const documents = nodes.filter(node => node.role === 'document web' && node.attributes?.url === url && finiteRect(node.bounds));
  // A same-URL iframe is a descendant of the top viewport, not a second
  // independent candidate viewport. Unrelated matching roots remain ambiguous.
  const roots = documents.filter(node => !documents.some(candidate => candidate !== node && within(node, candidate)));
  if (roots.length !== 1) return undefined;
  const rootNode = roots[0]!;
  if (!unique(rootNode)) return undefined;
  const root = rootNode.bounds!;
  const source = key(speech.source);
  const node = source ? identities.get(source) : undefined;
  if (!finiteRect(node?.bounds)) return undefined;
  // A native graph can contain browser chrome or stale documents. Their
  // coordinates alone never establish an association with this page.
  if (!within(node, rootNode)) return undefined;
  // AT-SPI coordinates are physical screen coordinates. The top document gives
  // the actual viewport origin and scale, including native browser chrome.
  const scale = width / root.width;
  const x = Math.max(0, (node.bounds.x - root.x) * scale);
  const y = Math.max(0, (node.bounds.y - root.y) * scale);
  const right = Math.min(width, (node.bounds.x + node.bounds.width - root.x) * scale);
  const bottom = Math.min(height, (node.bounds.y + node.bounds.height - root.y) * scale);
  return [x, y, right, bottom].every(Number.isFinite) && right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

export async function captureReportSnapshot(page: Page, observation: ScreenReaderObservation, index: number, document: unknown): Promise<ReportSnapshot> {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const png = await page.screenshot({
    scale: 'css',
    // Hide evidence chrome without removing it or exposing it to the reader.
    style: '#__hoosaidthat_screenreader_overlay__ { visibility: hidden !important; }',
    mask: page.frames().map(frame => frame.locator('input[type="password"], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i]')),
  });
  return {
    index, observation, ...dimensions,
    image: `data:image/png;base64,${png.toString('base64')}`,
    annotations: observation.speechEvents.map(speech => {
      const bounds = sourceBounds(document, page.url(), speech, dimensions.width, dimensions.height);
      return { speech, ...(bounds ? { bounds, association: 'native-source' as const } : {}) };
    }),
  };
}

interface AudioIndex { monotonicNs: number; startSample: number; sampleCount: number; sampleRate: number }

/** Cut original PCM samples. The HTML never invokes speech synthesis. */
export function addReportAudio(snapshots: ReportSnapshot[], artifacts: readonly DownloadedArtifact[]): void {
  const events = artifacts.filter(artifact => artifact.name === 'screenreader-events');
  const wav = artifacts.filter(artifact => artifact.name === 'screenreader-audio');
  if (events.length !== 1 || wav.length !== 1) return;
  let manifest: unknown;
  try { manifest = JSON.parse(Buffer.from(events[0]!.body).toString('utf8')); }
  catch { return; }
  if (!object(manifest) || !Array.isArray(manifest.audioTimeline)) return;
  const indices = new Map<number, AudioIndex | undefined>();
  for (const entry of manifest.audioTimeline) {
    if (!object(entry) || !Number.isSafeInteger(entry.monotonicNs) || Number(entry.monotonicNs) < 0) continue;
    const timestamp = Number(entry.monotonicNs);
    const valid = ['startSample', 'sampleCount', 'sampleRate'].every(key => Number.isSafeInteger(entry[key]) && Number(entry[key]) >= 0) &&
      Number(entry.sampleRate) > 0 && Number(entry.sampleCount) > 0;
    // Even an invalid second entry makes the originating timestamp ambiguous.
    indices.set(timestamp, indices.has(timestamp) || !valid ? undefined : entry as unknown as AudioIndex);
  }
  const bytes = Buffer.from(wav[0]!.body);
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return;
  let format: Buffer | undefined;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return;
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size % 2) > bytes.length) return;
    const kind = bytes.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') {
      if (format) return;
      format = bytes.subarray(start, start + size);
    }
    if (kind === 'data') {
      if (pcm) return;
      pcm = bytes.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !pcm || format.length < 16 || format.readUInt16LE(0) !== 1) return;
  const blockSize = format.readUInt16LE(12);
  const rate = format.readUInt32LE(4);
  const channels = format.readUInt16LE(2);
  const bits = format.readUInt16LE(14);
  if (channels === 0 || rate === 0 || ![8, 16, 24, 32].includes(bits) ||
    blockSize !== channels * bits / 8 || format.readUInt32LE(8) !== rate * blockSize || pcm.length % blockSize !== 0) return;
  const frames = pcm.length / blockSize;
  for (const snapshot of snapshots) for (const annotation of snapshot.annotations) {
    const entry = indices.get(annotation.speech.monotonicNs);
    if (!entry || entry.sampleRate !== rate || entry.startSample > frames || entry.sampleCount > frames - entry.startSample) continue;
    const samples = pcm.subarray(entry.startSample * blockSize, (entry.startSample + entry.sampleCount) * blockSize);
    const fmtPadding = format.length % 2;
    const header = Buffer.alloc(28 + format.length + fmtPadding);
    const samplePadding = Buffer.alloc(samples.length % 2);
    header.write('RIFF'); header.writeUInt32LE(header.length + samples.length + samplePadding.length - 8, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(format.length, 16); format.copy(header, 20);
    header.write('data', 20 + format.length + fmtPadding); header.writeUInt32LE(samples.length, 24 + format.length + fmtPadding);
    annotation.audio = { data: `data:audio/wav;base64,${Buffer.concat([header, samples, samplePadding]).toString('base64')}`, startSample: entry.startSample, sampleCount: entry.sampleCount, sampleRate: rate };
  }
}

/** A single portable file: embedded images/audio, no server or external assets. */
export function renderScreenReaderReport(report: ScreenReaderReport): string {
  return reportWebsite(report);
}
