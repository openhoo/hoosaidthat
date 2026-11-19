#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { ScreenReaderRuntime, HttpScreenReaderClient, resolveOptions } from '@openhoo/hoosaidthat';

const { values } = parseArgs({ options: {
  image: { type: 'string' }, runtime: { type: 'string' }, source: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: hoosaidthat-hoovda-doctor [--image IMAGE] [--runtime docker|podman] [--source FULL_HOOSAIDTHAT_COMMIT]');
  process.exit(0);
}
const sha = /^[a-f0-9]{40}$/;
const pkg = createRequire(import.meta.url)('@openhoo/hoosaidthat/package.json');
const pin = JSON.parse(readFileSync(new URL('../images/hoovda/source.json', import.meta.url), 'utf8'));
if (pin.repository !== 'openhoo/hoovda' || !sha.test(pin.commit)) throw Error('Invalid installed HooVDA source pin');
if (values.source !== undefined && !sha.test(values.source)) throw Error('--source requires a full HooSaidThat commit');
if (values.runtime !== undefined && !['docker','podman'].includes(values.runtime)) throw Error('--runtime must be docker or podman');

async function probe() {
  const options = resolveOptions({ screenReader: 'hoovda', runtime: values.runtime, image: values.image });
  const runtime = await ScreenReaderRuntime.start(options, 0);
  const server = createServer();
  let browser;
  try {
    const inspect = (...args) => execFileSync(runtime.engine, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024 }).trim();
    const id = inspect('container', 'inspect', '--format', '{{.Image}}', runtime.containerName);
    const [image] = JSON.parse(inspect('image', 'inspect', id));
    const labels = image.Config.Labels ?? {};
    const source = labels['org.opencontainers.image.revision'];
    if (!/^sha256:[a-f0-9]{64}$/.test(id) || image.Id !== id || image.Os !== 'linux' || image.Architecture !== 'amd64' ||
        labels['dev.hoosaidthat.screenreader'] !== 'hoovda') throw Error('Expected a managed HooVDA linux/amd64 image');
    if (!sha.test(source) || (values.source && values.source !== source)) throw Error('HooSaidThat image source does not match the expected commit');
    const client = new HttpScreenReaderClient(runtime.endpoints, 'hoovda');
    const health = await client.health();
    if (labels['dev.hoosaidthat.hoovda.revision'] !== pin.commit || health.screenReader.revision !== pin.commit)
      throw Error('Installed package pin, image engine label and running HooVDA commit must match');

    const marker = randomUUID();
    const path = '/' + randomUUID();
    server.on('request', (req, res) => {
      if (req.method !== 'GET' || req.url !== path) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end(marker);
    });
    await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
    browser = await chromium.connectOverCDP(runtime.endpoints.cdpEndpoint, { timeout: 8_000 });
    const page = await browser.newPage();
    const response = await page.goto('http://127.0.0.1:' + server.address().port + path, { timeout: 8_000 });
    if (response?.status() !== 200 || (await page.locator('body').innerText({ timeout: 4_000 })) !== marker)
      throw Error('Runtime Chromium did not read the marker served by this host');
    return { package: pkg.name, version: pkg.version, engine: runtime.engine, imageId: id, imageSource: source,
      imageVersion: labels['org.opencontainers.image.version'], hoovda: pin.commit, platform: 'linux/amd64',
      authenticatedControl: true, browserCDP: true, hostLoopback: true };
  } finally {
    server.closeAllConnections();
    try {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (browser) await browser.close();
    } finally { await runtime.stop(); }
  }
}
try { console.log(JSON.stringify(await probe(), null, 2)); }
catch (err) { console.error(err.message); process.exitCode = 1; }
