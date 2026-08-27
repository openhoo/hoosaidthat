import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { HttpScreenReaderClient, ScreenReaderProtocolError } from '../src/client.js';

const token = 'unit-test-token';

test('client performs action and reads captured speech', async (t) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new HttpScreenReaderClient({
    controlEndpoint: endpoint,
    cdpEndpoint: 'http://127.0.0.1:9222',
    controlToken: token,
  });

  const health = await client.health();
  assert.equal(health.screenReader.name, 'orca');
  assert.equal(health.platform, 'linux');
  assert.deepEqual(await client.capabilities(), {
    protocolVersion: 1,
    actions: [{ action: 'nextHeading', label: 'Next heading' }],
  });
  assert.equal(await client.cursor(), 4);
  assert.deepEqual(await client.perform('nextHeading'), {
    action: 'nextHeading',
    afterSequence: 4,
    lastSequence: 4,
  });
  const events = await client.readEvents(4, { timeoutMs: 100, quietMs: 10 });
  assert.equal(events.events[0]?.text, 'Checkout heading level 1');
});

test('client rejects unauthorized response', async (t) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient({
    controlEndpoint: `http://127.0.0.1:${address.port}`,
    cdpEndpoint: 'http://127.0.0.1:9222',
    controlToken: 'wrong',
  });
  await assert.rejects(() => client.health(), ScreenReaderProtocolError);
});

test('client drives HooVDA v2 session and verifies artifacts', async (t) => {
  const artifactBody = Buffer.from('event evidence');
  const digest = createHash('sha256').update(artifactBody).digest('hex');
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401, { error: 'unauthorized' });
    } else if (path === '/v2/health') {
      send(response, 200, {
        protocolVersion: '2.0', status: 'ok', version: '0.0.0-dev',
        profile: 'nvda-web-2026.1.1', locale: 'en-US', keyboardLayout: 'desktop', ready: true,
      });
    } else if (path === '/v2/actions') {
      send(response, 200, {
        profile: 'nvda-web-2026.1.1', keyboardLayout: 'desktop',
        commands: [{ id: 'nextHeading', label: 'Next heading' }],
      });
    } else if (path === '/v2/sessions' && request.method === 'POST') {
      send(response, 201, { id: 'hv-test', startSequence: 2 });
    } else if (path === '/v2/sessions/hv-test/state') {
      send(response, 200, {
        lastSequence: 2, browserWindowActive: true, webContentFocused: true,
        cursor: { mode: 'browse' },
      });
    } else if (path === '/v2/sessions/hv-test/actions') {
      send(response, 200, {
        command: 'nextHeading', beforeSequence: 2, cursor: 5, timedOut: false,
        events: [
          {
            sequence: 3,
            monotonicNs: 10,
            kind: 'speech',
            causalCommand: 'nextHeading',
            source: { bus: ':1.5', path: '/org/a11y/atspi/accessible/42' },
            text: 'Checkout heading level 1',
          },
          { sequence: 4, monotonicNs: 11, kind: 'braille', causalCommand: 'nextHeading', text: 'Checkout', brailleCells: Buffer.from([1, 2]).toString('base64') },
          { sequence: 5, monotonicNs: 12, kind: 'commandSettled', causalCommand: 'nextHeading', reason: 'completed' },
        ],
      });
    } else if (path === '/v2/sessions/hv-test/finish') {
      send(response, 200, {
        sessionId: 'hv-test', cursor: 5,
        artifacts: [{ name: 'screenreader-events', contentType: 'application/json', bytes: artifactBody.length, sha256: digest }],
      });
    } else if (path === '/v2/sessions/hv-test/artifacts/screenreader-events') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(artifactBody);
    } else {
      send(response, 404, { error: 'not-found' });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient({
    controlEndpoint: `http://127.0.0.1:${address.port}`,
    cdpEndpoint: 'http://127.0.0.1:9222',
    controlToken: token,
  }, 'hoovda');
  assert.equal((await client.health()).screenReader.name, 'hoovda');
  await client.beginSession('test', true);
  assert.equal((await client.capabilities()).actions[0]?.action, 'nextHeading');
  assert.equal(await client.cursor(), 2);
  const action = await client.perform('nextHeading');
  assert.equal(action.events?.find((event) => event.kind === 'speech')?.text, 'Checkout heading level 1');
  assert.deepEqual(action.events?.find((event) => event.kind === 'speech')?.source, {
    bus: ':1.5',
    path: '/org/a11y/atspi/accessible/42',
  });
  assert.deepEqual(action.events?.find((event) => event.kind === 'braille' && event)?.kind, 'braille');
  assert.equal(action.events?.find((event) => event.kind === 'braille')?.cursor, 0);
  const artifacts = await client.finishSession();
  assert.equal(Buffer.from(artifacts[0]?.body ?? []).toString(), 'event evidence');
});

test('client rejects unsupported runtimes and malformed capabilities', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/v1/actions') {
      send(response, 200, {
        protocolVersion: 1,
        actions: [
          { action: 'nextHeading', label: 'Next heading' },
          { action: 'nextHeading', label: 'Duplicate' },
        ],
      });
      return;
    }
    send(response, 200, {
      protocolVersion: 1,
      status: 'ready',
      screenReader: {
        name: 'orca',
        version: 'unsupported runtime',
        capture: 'speech-dispatcher-output-module',
      },
      browser: { name: 'chromium', version: '151', cdpPort: 9222 },
      platform: 'unsupported',
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient({
    controlEndpoint: `http://127.0.0.1:${address.port}`,
    cdpEndpoint: 'http://127.0.0.1:9222',
    controlToken: token,
  });
  await assert.rejects(() => client.health(), /invalid screen-reader health/);
  await assert.rejects(() => client.capabilities(), /invalid screen-reader capabilities/);
});

test('client rejects malformed and out-of-order evidence', async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/v1/events') {
      send(response, 200, {
        protocolVersion: 1,
        events: [
          { sequence: 6, monotonicNs: 20, kind: 'speech', text: 'second', command: 'SPEAK' },
          { sequence: 5, monotonicNs: 10, kind: 'speech', text: 'first', command: 'SPEAK' },
        ],
        lastSequence: 6,
        timedOut: false,
      });
      return;
    }
    send(response, 200, {
      protocolVersion: 1,
      status: 'ready',
      screenReader: { name: 'orca' },
      browser: {},
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient({
    controlEndpoint: `http://127.0.0.1:${address.port}`,
    cdpEndpoint: 'http://127.0.0.1:9222',
    controlToken: token,
  });
  await assert.rejects(() => client.health(), /invalid screen-reader health response/);
  await assert.rejects(
    () => client.readEvents(4, { timeoutMs: 100, quietMs: 10 }),
    /not strictly ordered/,
  );
});

test('client validates event query bounds before transport', async () => {
  const client = new HttpScreenReaderClient({
    controlEndpoint: 'http://127.0.0.1:1',
    cdpEndpoint: 'http://127.0.0.1:2',
    controlToken: token,
  });
  await assert.rejects(
    () => client.readEvents(-1, { timeoutMs: 100, quietMs: 10 }),
    /afterSequence/,
  );
  await assert.rejects(
    () => client.readEvents(0, { timeoutMs: 30_001, quietMs: 10 }),
    /timeoutMs/,
  );
});

function handler(request: IncomingMessage, response: ServerResponse): void {
  if (request.headers.authorization !== `Bearer ${token}`) {
    send(response, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/v1/health') {
    send(response, 200, {
      protocolVersion: 1,
      status: 'ready',
      screenReader: {
        name: 'orca',
        version: 'Orca 50.2',
        capture: 'speech-dispatcher-output-module',
      },
      browser: { name: 'chromium', version: '150', cdpPort: 9222 },
      platform: 'linux',
    });
  } else if (url.pathname === '/v1/state') {
    send(response, 200, {
      protocolVersion: 1,
      lastSequence: 4,
      focus: {
        browserWindowActive: true,
        webContentFocused: true,
        role: 'document web',
        name: 'Checkout',
      },
    });
  } else if (url.pathname === '/v1/actions' && request.method === 'GET') {
    send(response, 200, {
      protocolVersion: 1,
      actions: [{ action: 'nextHeading', label: 'Next heading' }],
    });
  } else if (url.pathname === '/v1/actions' && request.method === 'POST') {
    send(response, 200, {
      protocolVersion: 1,
      action: 'nextHeading',
      afterSequence: 4,
    });
  } else if (url.pathname === '/v1/events') {
    send(response, 200, {
      protocolVersion: 1,
      events: [
        {
          sequence: 5,
          monotonicNs: 123,
          kind: 'speech',
          text: 'Checkout heading level 1',
          command: 'SPEAK',
        },
      ],
      lastSequence: 5,
      timedOut: false,
    });
  } else {
    send(response, 404, { error: 'not-found' });
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
