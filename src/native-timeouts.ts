// The native bridge runs these phases in sequence. JAWS sends one key chord per action.
export const NATIVE_FOCUS_PROBE_TIMEOUT_MS = 10_000;
export const AT_DRIVER_REQUEST_TIMEOUT_MS = 10_000;
export const NATIVE_ACTION_SETTLE_TIMEOUT_MS = 15_000;

export function jawsActionBudgetMs(clientTimeoutMs: number): number {
  return NATIVE_FOCUS_PROBE_TIMEOUT_MS + AT_DRIVER_REQUEST_TIMEOUT_MS +
    Math.max(clientTimeoutMs, NATIVE_ACTION_SETTLE_TIMEOUT_MS);
}
