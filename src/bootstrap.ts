export const NATIVE_BOOTSTRAP_URL = 'data:text/html,<html lang="en"><title>HooSaidThat native bootstrap</title><button>Screen reader ready</button></html>';

export const RUNTIME_KEEP_ALIVE_URL = 'data:text/html,<title>HooSaidThat runtime keepalive</title>';

/** Only bootstrap pages owned by the runtime. */
export function isRuntimeBootstrapURL(value: string): boolean {
  if (value === NATIVE_BOOTSTRAP_URL || value === RUNTIME_KEEP_ALIVE_URL) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.hostname !== '') return false;
    const path = decodeURIComponent(url.pathname);
    return path === '/opt/hoosaidthat/bootstrap.html' ||
      path.toLowerCase() === '/c:/hoosaidthat/bootstrap.html';
  } catch {
    return false;
  }
}
