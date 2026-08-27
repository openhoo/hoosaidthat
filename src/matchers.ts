import { expect as baseExpect } from '@playwright/test';
import { ScreenReaderSession } from './session.js';

type SpeechExpectation = string | RegExp;

export const expect = baseExpect.extend({
  toHaveSpoken(received: unknown, expected: SpeechExpectation) {
    const session = requireSession(received);
    const actual = session.spokenText();
    const pass = matches(actual, expected, false);
    return {
      pass,
      message: () =>
        pass
          ? `expected screen reader not to have spoken ${formatExpected(expected)}`
          : `expected screen reader to have spoken ${formatExpected(expected)}\n\nActual speech:\n${actual || '(none)'}`,
      actual,
      expected,
      name: 'toHaveSpoken',
    };
  },
  toHaveExactSpeech(received: unknown, expected: SpeechExpectation) {
    const session = requireSession(received);
    const actual = session.spokenText();
    const pass = matches(actual, expected, true);
    return {
      pass,
      message: () =>
        pass
          ? `expected screen reader not to have exact speech ${formatExpected(expected)}`
          : `expected exact screen-reader speech ${formatExpected(expected)}\n\nActual speech:\n${actual || '(none)'}`,
      actual,
      expected,
      name: 'toHaveExactSpeech',
    };
  },
  toHaveBraille(received: unknown, expected: SpeechExpectation) {
    const session = requireSession(received);
    const actual = session.brailleText();
    const pass = matches(actual, expected, false);
    return {
      pass,
      message: () =>
        pass
          ? `expected screen reader not to have braille ${formatExpected(expected)}`
          : `expected screen reader to have braille ${formatExpected(expected)}\n\nActual braille:\n${actual || '(none)'}`,
      actual,
      expected,
      name: 'toHaveBraille',
    };
  },
  toHaveExactBraille(received: unknown, expected: SpeechExpectation) {
    const session = requireSession(received);
    const actual = session.brailleText();
    const pass = matches(actual, expected, true);
    return {
      pass,
      message: () =>
        pass
          ? `expected screen reader not to have exact braille ${formatExpected(expected)}`
          : `expected exact screen-reader braille ${formatExpected(expected)}\n\nActual braille:\n${actual || '(none)'}`,
      actual,
      expected,
      name: 'toHaveExactBraille',
    };
  },
});

function requireSession(value: unknown): ScreenReaderSession {
  if (!(value instanceof ScreenReaderSession)) {
    throw new TypeError('toHaveSpoken expects a ScreenReaderSession');
  }
  return value;
}

function formatExpected(value: SpeechExpectation): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function matches(actual: string, expected: SpeechExpectation, exact: boolean): boolean {
  if (typeof expected === 'string') return exact ? actual === expected : actual.includes(expected);
  expected.lastIndex = 0;
  return expected.test(actual);
}

declare module '@playwright/test' {
  interface Matchers<R, T = unknown> {
    toHaveSpoken(expected: SpeechExpectation): R;
    toHaveExactSpeech(expected: SpeechExpectation): R;
    toHaveBraille(expected: SpeechExpectation): R;
    toHaveExactBraille(expected: SpeechExpectation): R;
  }
}
