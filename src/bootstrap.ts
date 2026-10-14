/** Only bootstrap files owned by the Linux images or Windows reference VM. */
export function isRuntimeBootstrapURL(value: string): boolean {
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
