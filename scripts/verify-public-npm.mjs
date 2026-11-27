import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { verifyNpmPublication } from './release-receipt.mjs';

const WINDOW = 60 * 60_000;
const transientStatus = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
const transientNetwork = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
class Pending extends Error {}

async function metadataAt(url, request, signal) {
  try {
    const response = await request(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { Accept: 'application/json' }, cache: 'no-store', signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (transientStatus.has(response.status)) throw new Pending('HTTP ' + response.status);
      throw new Error('Unexpected registry HTTP status: ' + response.status);
    }
    // Read the body under the same request timeout and never log registry-supplied content.
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Registry metadata is too large');
      parts.push(part);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new Error('Invalid registry metadata JSON'); }
  } catch (error) {
    if (error instanceof Pending) throw error;
    if (signal.aborted || transientNetwork.has(error.cause?.code ?? error.code)) {
      throw new Pending('temporary network failure');
    }
    // fetch can include connection details in its error. Do not print them.
    if (error instanceof TypeError) throw new Error('Invalid registry response or connection');
    throw error;
  }
}

export async function readPublishedPackage(receipt, {
  request = fetch, now = () => performance.now(), wait = sleep, log = () => {},
} = {}) {
  const pkg = receipt?.package;
  if (receipt?.status !== 'published' || pkg?.name !== '@openhoo/hoosaidthat' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) ||
      !/^[0-9a-f]{40}$/.test(pkg.shasum) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity)) {
    throw new Error('Expected an accepted HooSaidThat publication receipt');
  }
  const url = 'https://registry.npmjs.org/@openhoo%2fhoosaidthat/' + pkg.version;
  const expectedUrl = 'https://registry.npmjs.org/-/npm/v1/attestations/@openhoo%2fhoosaidthat@' + pkg.version;
  const deadline = now() + WINDOW;
  let delay = 5_000;
  while (now() < deadline) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(15_000, deadline - now()))));
      const metadata = await metadataAt(url, request, signal);
      const dist = metadata?.dist, attest = dist?.attestations;
      // Missing attestations can lag publication. Never retry conflicting identity, digest or provenance.
      const identityMatches = metadata?.name === pkg.name && metadata.version === pkg.version &&
        dist?.shasum === pkg.shasum && dist.integrity === pkg.integrity;
      if (identityMatches && (attest === undefined ||
          (attest?.url === expectedUrl && attest.provenance === undefined))) {
        throw new Pending('provenance metadata not yet visible');
      }
      return verifyNpmPublication(receipt, metadata);
    } catch (error) {
      if (!(error instanceof Pending)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const pause = Math.min(delay, remaining);
      log(error.message + '; waiting ' + Math.ceil(pause / 1000) + 's for public npm metadata');
      await wait(pause);
      delay = Math.min(delay * 2, 60_000);
    }
  }
  throw new Error('npm accepted the publish, but public readback did not finish within 60 minutes. Keep the receipt and rerun only this readback.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-public-npm.mjs <receipt.json>');
    const path = process.argv[2];
    let receipt;
    try { receipt = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('Cannot read publication receipt JSON'); }
    const verified = await readPublishedPackage(receipt, { log: console.log });
    const temp = path + '.' + process.pid + '.tmp';
    writeFileSync(temp, JSON.stringify(verified, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    console.log('Verified the public npm package integrity and provenance metadata.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
