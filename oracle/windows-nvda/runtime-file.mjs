import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync } from 'node:fs';

// These files belong to the Linux Docker controller. Inspect and read a single
// open file, including during image extraction, without following a final symlink.
export function readRuntimeFile(path, max, { privateCopy = false, ownerOnly = false } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > max)
      throw new Error('Expected a bounded regular runtime file: ' + path);
    if (ownerOnly && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
      throw new Error('Expected a private control token owned by the current user.');
    if (privateCopy) fchmodSync(fd, 0o600);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (n === 0) break;
      offset += n;
    }
    if (offset !== bytes.length || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
      throw new Error('Runtime file changed size while being read: ' + path);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
