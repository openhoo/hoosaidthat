export type IPhoneVoiceOverMovement = 'forward' | 'backward' | 'in' | 'out';
export type IPhoneVoiceOverAction = 'current' | 'activate' | 'type' | IPhoneVoiceOverMovement;

export type IPhoneVoiceOverStep =
  | { action: Exclude<IPhoneVoiceOverAction, 'type'>; expect?: string; until?: never; maxMoves?: never; text?: never }
  | { action: 'type'; text: string; expect?: string; until?: never; maxMoves?: never }
  | { action: IPhoneVoiceOverMovement; until: string; maxMoves: number; expect?: never };

export type IPhoneVoiceOverScenario = ({ url: string; bundleId?: never } | { bundleId: string; url?: never }) & {
  /** Wait for this exact accessibility label on the page before enabling VoiceOver. */
  readyText?: string;
  /** In a recording, touch the center of this exact accessible label once to establish VoiceOver focus. Use a noninteractive heading. */
  initialFocusText?: string;
  steps: readonly IPhoneVoiceOverStep[];
}

export interface IPhoneVoiceOverOptions {
  /** Stop the recording and request native XCTest teardown. */
  signal?: AbortSignal;
  /** Select a simulator explicitly when more than one eligible iPhone is available. */
  udid?: string;
  /** Parent directory for the unique run directory and its native XCTest artifacts. */
  resultsDirectory?: string;
}

export interface IPhoneVoiceOverReport {
  screenReader: 'VoiceOver';
  browser?: 'Mobile Safari';
  bundleId?: string;
  captureBoundary: string;
  xcode: string;
  sdk: string;
  device: { udid: string; name: string; state: string; runtime: string; build?: string };
  scenario: IPhoneVoiceOverScenario;
  transcript: {
    version: 1;
    url?: string;
    bundleId?: string;
    completed: true;
    events: { step: number; action: IPhoneVoiceOverAction; utterance: string; secondsFromStart?: number }[];
  };
}

/** Run one native XCTest scenario on an iPhone simulator. Rejects if setup, speech, or an expectation fails. */
export function runIPhoneVoiceOver(
  scenario: IPhoneVoiceOverScenario,
  options?: IPhoneVoiceOverOptions,
): Promise<{ outputDirectory: string; report: IPhoneVoiceOverReport }>;

export interface IPhoneVoiceOverRecording {
  file: 'recording.mp4';
  videoSource: 'XCTest device screen recording';
  screenOffsetSeconds: number;
  audioSource: 'simulator output via virtual loopback' | 'dedicated Mac output via virtual loopback (includes host audio)';
  audioDevice: string;
  durationSeconds: number;
  width: number;
  height: number;
  peakDb: number;
}

/** Record actual device output during the scenario and reject silent or incomplete recordings. */
export function recordIPhoneVoiceOver(
  scenario: IPhoneVoiceOverScenario,
  options?: IPhoneVoiceOverOptions & { audioDevice?: string; dedicatedMacOutput?: boolean },
): Promise<{ outputDirectory: string; report: IPhoneVoiceOverReport & { recording: IPhoneVoiceOverRecording } }>;
