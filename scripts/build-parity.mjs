import { copyFile } from 'node:fs/promises';

// The compiled suite resolves this manifest relative to import.meta.url.
await copyFile(
  new URL('../oracle/parity/coverage.json', import.meta.url),
  new URL('../dist/oracle/parity/coverage.json', import.meta.url),
);
