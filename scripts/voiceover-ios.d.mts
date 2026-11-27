export type IPhoneVoiceOverMovement = 'forward' | 'backward' | 'in' | 'out';
export type IPhoneVoiceOverAction = 'current' | 'activate' | IPhoneVoiceOverMovement;

export type IPhoneVoiceOverStep =
  | { action: IPhoneVoiceOverAction; expect?: string; until?: never; maxMoves?: never }
  | { action: IPhoneVoiceOverMovement; until: string; maxMoves: number; expect?: never };

export type IPhoneVoiceOverScenario = ({ url: string; bundleId?: never } | { bundleId: string; url?: never }) & {
  /** Wait for this exact accessibility label on the page before enabling VoiceOver. */
  readyText?: string;
  steps: readonly IPhoneVoiceOverStep[];
}

export interface IPhoneVoiceOverOptions {
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
    events: { step: number; action: IPhoneVoiceOverAction; utterance: string }[];
  };
}

/** Run one native XCTest scenario on an iPhone simulator. Rejects if setup, speech, or an expectation fails. */
export function runIPhoneVoiceOver(
  scenario: IPhoneVoiceOverScenario,
  options?: IPhoneVoiceOverOptions,
): Promise<{ outputDirectory: string; report: IPhoneVoiceOverReport }>;

export interface IPhoneVoiceOverRecording {
  file: 'recording.mp4';
  audioSource: 'simulator output via virtual loopback';
  audioDevice: string;
  durationSeconds: number;
  width: number;
  height: number;
  peakDb: number;
}

/** Record actual device output during the scenario and reject silent or incomplete recordings. */
export function recordIPhoneVoiceOver(
  scenario: IPhoneVoiceOverScenario,
  options?: IPhoneVoiceOverOptions & { audioDevice?: string },
): Promise<{ outputDirectory: string; report: IPhoneVoiceOverReport & { recording: IPhoneVoiceOverRecording } }>;
