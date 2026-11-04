import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export async function loadControlToken(path) {
  path = resolve(path);
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('invalid native control token file');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('base64url');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${token}\n`, { flag: 'wx', mode: 0o600 });
    return token;
  }
}

