import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { HttpScreenReaderClient, ScreenReaderProtocolError } from '../src/client.js';
import type { ScreenReaderPresentationSettings } from '../src/types.js';

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
    delivery: 'physical',
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
  const baselineSettings = presentationSettingsFixture();
  let settings: ScreenReaderPresentationSettings = baselineSettings;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401, { error: 'unauthorized' });
    } else if (path === '/v2/health') {
      send(response, 200, {
        protocolVersion: '2.0',
        status: 'ok',
        version: '0.0.0-dev',
        profile: 'nvda-web-2026.1.1',
        locale: 'en-US',
        keyboardLayout: 'desktop',
        ready: true,
      });
    } else if (path === '/v2/actions') {
      send(response, 200, {
        profile: 'nvda-web-2026.1.1',
        keyboardLayout: 'desktop',
        commands: [{ id: 'nextHeading', label: 'Next heading' }],
      });
    } else if (path === '/v2/sessions' && request.method === 'POST') {
      send(response, 201, { id: 'hv-test', startSequence: 2 });
    } else if (path === '/v2/sessions/hv-test/state') {
      send(response, 200, {
        lastSequence: 2,
        browserWindowActive: true,
        webContentFocused: true,
        cursorInDocument: true,
        cursor: { mode: 'browse' },
        focus: { bus: ':1.5', path: '/focus' },
        browse: {
          id: 'browse-link',
          role: 'link',
          name: 'Skip to checkout',
          location: null,
          visited: false,
          quickNavigationTargets: ['link', 'unvisitedLink'],
        },
        navigator: { bus: ':1.5', path: '/heading' },
        review: { bus: ':1.5', path: '/heading' },
      });
    } else if (path === '/v2/sessions/hv-test/settings' && request.method === 'GET') {
      send(response, 200, settings);
    } else if (path === '/v2/sessions/hv-test/settings' && request.method === 'POST') {
      settings = JSON.parse(await readBody(request)) as ScreenReaderPresentationSettings;
      send(response, 200, settings);
    } else if (path === '/v2/sessions/hv-test/settings/reset' && request.method === 'POST') {
      settings = baselineSettings;
      send(response, 200, settings);
    } else if (path === '/v2/sessions/hv-test/actions') {
      send(response, 200, {
        command: 'nextHeading',
        delivery: 'physical',
        beforeSequence: 2,
        cursor: 6,
        timedOut: false,
        events: [
          {
            sequence: 3,
            monotonicNs: 10,
            kind: 'speech',
            causalCommand: 'nextHeading',
            source: { bus: ':1.5', path: '/org/a11y/atspi/accessible/42' },
            text: 'Checkout heading level 1',
            provenance: 'screenReaderOutput',
            redacted: true,
          },
          {
            sequence: 4,
            monotonicNs: 11,
            kind: 'braille',
            causalCommand: 'nextHeading',
            text: 'Checkout',
            brailleCells: Buffer.from([1, 2]).toString('base64'),
          },
          {
            sequence: 5,
            monotonicNs: 12,
            kind: 'focus',
            causalCommand: 'nextHeading',
          },
          {
            sequence: 6,
            monotonicNs: 13,
            kind: 'commandSettled',
            causalCommand: 'nextHeading',
            reason: 'completed',
          },
        ],
      });
    } else if (path === '/v2/sessions/hv-test/finish') {
      send(response, 200, {
        sessionId: 'hv-test',
        cursor: 5,
        artifacts: [
          {
            name: 'screenreader-events',
            contentType: 'application/json',
            bytes: artifactBody.length,
            sha256: digest,
          },
        ],
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
  const client = new HttpScreenReaderClient(
    {
      controlEndpoint: `http://127.0.0.1:${address.port}`,
      cdpEndpoint: 'http://127.0.0.1:9222',
      controlToken: token,
    },
    'hoovda',
  );
  assert.equal((await client.health()).screenReader.name, 'hoovda');
  await client.beginSession('test', true);
  const baseline = await client.presentationSettings();
  assert.equal(baseline.reportHeadings, true);
  const changed = await client.setPresentationSettings({
    ...baseline,
    brailleTether: 'review',
    reportHeadings: false,
  });
  assert.equal(changed.brailleTether, 'review');
  assert.equal(changed.reportHeadings, false);
  assert.deepEqual(await client.resetPresentationSettings(), baseline);
  assert.equal((await client.capabilities()).actions[0]?.action, 'nextHeading');
  const state = await client.state();
  assert.equal(state.lastSequence, 2);
  assert.equal(state.browse?.name, 'Skip to checkout');
  assert.equal(state.browse?.visited, false);
  assert.deepEqual(state.browse?.quickNavigationTargets, ['link', 'unvisitedLink']);
  assert.equal(state.navigator?.id, ':1.5:/heading');
  assert.equal(state.review?.id, ':1.5:/heading');
  assert.equal(await client.cursor(), 2);
  const action = await client.perform('nextHeading');
  assert.equal(action.delivery, 'physical');
  assert.equal(
    action.events?.find((event) => event.kind === 'speech')?.text,
    'Checkout heading level 1',
  );
  assert.deepEqual(action.events?.find((event) => event.kind === 'speech')?.source, {
    bus: ':1.5',
    path: '/org/a11y/atspi/accessible/42',
  });
  assert.equal(
    action.events?.find((event) => event.kind === 'speech')?.provenance,
    'screenReaderOutput',
  );
  assert.equal(action.events?.find((event) => event.kind === 'speech')?.redacted, true);
  assert.equal(action.events?.find((event) => event.kind === 'focus')?.text, '');
  assert.deepEqual(
    action.events?.find((event) => event.kind === 'braille' && event)?.kind,
    'braille',
  );
  assert.equal(action.events?.find((event) => event.kind === 'braille')?.cursor, 0);
  const artifacts = await client.finishSession();
  assert.equal(Buffer.from(artifacts[0]?.body ?? []).toString(), 'event evidence');
});

test('client drives real-NVDA v2 semantics and session configuration', async (t) => {
  let configured = false;
  let includeBrowserIdentity = true;
  const artifactBody = Buffer.from('{"screenReader":"nvda"}\n');
  const digest = createHash('sha256').update(artifactBody).digest('hex');
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401, { error: 'unauthorized' });
    } else if (path === '/v2/sessions' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      configured =
        body.profile === 'nvda-web-2026.1.1' &&
        body.locale === 'de-DE' &&
        body.keyboardLayout === 'laptop';
      send(response, 201, { id: 'nvda-test', startSequence: 8 });
    } else if (path === '/v2/health') {
      send(response, 200, {
        protocolVersion: '2.0',
        status: 'ok',
        screenReader: 'nvda',
        version: '2026.1.1',
        profile: 'nvda-web-2026.1.1',
        locale: 'de-DE',
        keyboardLayout: 'laptop',
        ready: true,
        ...(includeBrowserIdentity
          ? {
              browser: {
                name: 'chrome',
                version: '151.0.7922.47',
                cdpPort: 9222,
              },
            }
          : {}),
      });
    } else if (path === '/v2/actions' && request.method === 'GET') {
      send(response, 200, {
        commands: [
          { id: 'nextHeading', label: 'Next heading' },
          { id: 'nextArticle', label: 'Next article' },
          { id: 'find', label: 'Find' },
        ],
      });
    } else if (path === '/v2/sessions/nvda-test/state') {
      send(response, 200, {
        lastSequence: 8,
        browserWindowActive: true,
        webContentFocused: true,
        cursorInDocument: true,
        cursor: { mode: 'browse' },
      });
    } else if (path === '/v2/sessions/nvda-test/actions') {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const structured = typeof body.argument === 'string' || body.command === 'nextArticle';
      send(response, 200, {
        command: body.command,
        delivery: structured ? 'structured' : 'emulated',
        beforeSequence: 8,
        cursor: 10,
        timedOut: false,
        events: [
          {
            sequence: 9,
            monotonicNs: 20,
            kind: 'speech',
            causalCommand: body.command,
            text: 'Bestellung Überschrift Ebene 1',
          },
          {
            sequence: 10,
            monotonicNs: 21,
            kind: 'braille',
            causalCommand: body.command,
            text: 'Bestellung',
            brailleCells: Buffer.from([3, 9]).toString('base64'),
            brailleCursor: 1,
          },
        ],
      });
    } else if (path === '/v2/sessions/nvda-test/finish') {
      send(response, 200, {
        sessionId: 'nvda-test',
        cursor: 10,
        artifacts: [
          {
            name: 'screenreader-events',
            contentType: 'application/json',
            bytes: artifactBody.length,
            sha256: digest,
          },
        ],
      });
    } else if (path === '/v2/sessions/nvda-test/artifacts/screenreader-events') {
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
  const client = new HttpScreenReaderClient(
    {
      controlEndpoint: `http://127.0.0.1:${address.port}`,
      cdpEndpoint: 'http://127.0.0.1:9224',
      controlToken: token,
    },
    'nvda',
    15_000,
    { profile: 'nvda-web-2026.1.1', locale: 'de-DE', keyboardLayout: 'laptop' },
  );
  await client.beginSession('parity', true);
  assert(configured);
  const health = await client.health();
  assert.equal(health.screenReader.name, 'nvda');
  assert.equal(health.screenReader.capture, 'nvda-presentation-hooks');
  assert.equal(health.platform, 'windows');
  assert.equal(health.browser?.version, '151.0.7922.47');
  includeBrowserIdentity = false;
  await assert.rejects(client.health(), /invalid NVDA health response/);
  includeBrowserIdentity = true;
  const action = await client.perform('nextHeading');
  assert.equal(action.delivery, 'emulated');
  assert.equal(action.events?.[0]?.text, 'Bestellung Überschrift Ebene 1');
  const article = await client.perform('nextArticle');
  assert.equal(article.delivery, 'structured');
  const find = await client.perform('find', 'Bestellung');
  assert.equal(find.delivery, 'structured');
  assert.equal((await client.finishSession()).length, 1);
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
          {
            sequence: 6,
            monotonicNs: 20,
            kind: 'speech',
            text: 'second',
            command: 'SPEAK',
          },
          {
            sequence: 5,
            monotonicNs: 10,
            kind: 'speech',
            text: 'first',
            command: 'SPEAK',
          },
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
  await assert.rejects(() => client.readEvents(0, { timeoutMs: 30_001, quietMs: 10 }), /timeoutMs/);
});

test('client rejects mismatched HooVDA action delivery claims', async (t) => {
  for (const item of [
    {
      action: 'nextHeading' as const,
      argument: undefined,
      delivery: 'structured',
    },
    {
      action: 'nextArticle' as const,
      argument: undefined,
      delivery: 'physical',
    },
    { action: 'find' as const, argument: 'Checkout', delivery: 'physical' },
  ] as const) {
    await t.test(`${item.action} reported as ${item.delivery}`, async (subtest) => {
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (path === '/v2/sessions') {
          send(response, 201, { id: 'delivery-test', startSequence: 0 });
        } else if (path === '/v2/sessions/delivery-test/actions') {
          send(response, 200, {
            command: item.action,
            delivery: item.delivery,
            beforeSequence: 0,
            cursor: 0,
            timedOut: false,
            events: [],
          });
        } else {
          send(response, 404, { error: 'not-found' });
        }
      });
      server.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      subtest.after(() => server.close());
      const address = server.address();
      assert(address && typeof address !== 'string');
      const client = new HttpScreenReaderClient(
        {
          controlEndpoint: `http://127.0.0.1:${address.port}`,
          cdpEndpoint: 'http://127.0.0.1:9222',
          controlToken: token,
        },
        'hoovda',
      );
      await client.beginSession('delivery-test', false);
      await assert.rejects(
        () => client.perform(item.action, item.argument),
        /invalid HooVDA action response/,
      );
    });
  }
});

test('client clears a remotely finished session before rejecting its manifest', async (t) => {
  let sessions = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/v2/sessions') {
      sessions += 1;
      send(response, 201, { id: `session-${sessions}`, startSequence: 0 });
    } else if (path === '/v2/sessions/session-1/finish') {
      send(response, 200, { sessionId: 'session-1', artifacts: 'invalid' });
    } else {
      send(response, 404, { error: 'not-found' });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient(
    {
      controlEndpoint: `http://127.0.0.1:${address.port}`,
      cdpEndpoint: 'http://127.0.0.1:9222',
      controlToken: token,
    },
    'hoovda',
  );

  await client.beginSession('first', false);
  await assert.rejects(() => client.finishSession(), /invalid HooVDA finish response/);
  await client.beginSession('second', false);
  assert.equal(sessions, 2);
});

test('client waits for an in-flight operation before finishing a session', async (t) => {
  let finishAttempts = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/v2/sessions') {
      send(response, 201, { id: 'busy-session', startSequence: 0 });
    } else if (path === '/v2/sessions/busy-session/finish') {
      finishAttempts += 1;
      if (finishAttempts < 3) {
        send(response, 409, { error: 'another session operation is active' });
      } else {
        send(response, 200, { sessionId: 'busy-session', artifacts: [] });
      }
    } else {
      send(response, 404, { error: 'not-found' });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient(
    {
      controlEndpoint: `http://127.0.0.1:${address.port}`,
      cdpEndpoint: 'http://127.0.0.1:9222',
      controlToken: token,
    },
    'hoovda',
  );

  await client.beginSession('busy', false);
  assert.deepEqual(await client.finishSession(), []);
  assert.equal(finishAttempts, 3);
});

test('client safely retries finish after a dropped response', async (t) => {
  let finishAttempts = 0;
  const finishBodies: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/v2/sessions') {
      send(response, 201, { id: 'retry-session', startSequence: 0 });
    } else if (path === '/v2/sessions/retry-session/finish') {
      finishAttempts += 1;
      finishBodies.push(await readBody(request));
      if (finishAttempts === 1) {
        request.socket.destroy();
        return;
      }
      send(response, 200, { sessionId: 'retry-session', artifacts: [] });
    } else {
      send(response, 404, { error: 'not-found' });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient(
    {
      controlEndpoint: `http://127.0.0.1:${address.port}`,
      cdpEndpoint: 'http://127.0.0.1:9222',
      controlToken: token,
    },
    'hoovda',
  );

  await client.beginSession('retry', false);
  assert.deepEqual(await client.finishSession(), []);
  assert.equal(finishAttempts, 2);
  assert.deepEqual(finishBodies, ['{}', '{}']);
});

test('client bounds identifiers and error response bodies', async (t) => {
  const server = createServer((_request, response) => {
    const body = 'x'.repeat(5_000);
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient(
    {
      controlEndpoint: `http://127.0.0.1:${address.port}`,
      cdpEndpoint: 'http://127.0.0.1:9222',
      controlToken: token,
    },
    'hoovda',
  );

  await assert.rejects(() => client.beginSession('x'.repeat(501), false), /testId/);
  await assert.rejects(() => client.health(), /exceeded 4096 bytes/);
});

test('client rejects redirects without forwarding bearer authorization', async (t) => {
  let redirectedAuthorization: string | undefined;
  const target = createServer((request, response) => {
    redirectedAuthorization = request.headers.authorization;
    send(response, 200, {});
  });
  target.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => target.once('listening', resolve));
  t.after(() => target.close());
  const targetAddress = target.address();
  assert(targetAddress && typeof targetAddress !== 'string');

  const redirect = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${targetAddress.port}/captured`,
    });
    response.end();
  });
  redirect.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => redirect.once('listening', resolve));
  t.after(() => redirect.close());
  const redirectAddress = redirect.address();
  assert(redirectAddress && typeof redirectAddress !== 'string');

  const client = new HttpScreenReaderClient({
    controlEndpoint: `http://127.0.0.1:${redirectAddress.port}`,
    cdpEndpoint: 'http://127.0.0.1:9222',
    controlToken: token,
  });
  await assert.rejects(() => client.health(), /screen-reader request failed/);
  assert.equal(redirectedAuthorization, undefined);
});

test('client rejects malformed optional protocol-v2 state and action arguments', async (t) => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/v2/sessions') {
      send(response, 201, { id: 'strict-state', startSequence: 0 });
    } else if (path === '/v2/sessions/strict-state/state') {
      send(response, 200, {
        lastSequence: 0,
        browserWindowActive: true,
        webContentFocused: true,
        cursorInDocument: true,
        cursor: { mode: 'browse' },
        navigator: { id: '', role: null, name: null, location: null },
      });
    } else {
      send(response, 404, { error: 'not-found' });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new HttpScreenReaderClient(
    {
      controlEndpoint: `http://127.0.0.1:${address.port}`,
      cdpEndpoint: 'http://127.0.0.1:9222',
      controlToken: token,
    },
    'hoovda',
  );

  await client.beginSession('strict-state', false);
  await assert.rejects(() => client.state(), /invalid HooVDA state response/);
  await assert.rejects(() => client.perform('find'), /find requires a query/);
  await assert.rejects(
    () => client.perform('nextHeading', 'unexpected'),
    /does not accept a structured argument/,
  );
  await assert.rejects(() => client.perform('find', 'x'.repeat(501)), /structured action argument/);
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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function presentationSettingsFixture() {
  return {
    speechSymbolLevel: 'some' as const,
    brailleTether: 'auto' as const,
    reportKeyboardShortcuts: true,
    reportObjectPositionInformation: true,
    reportObjectDescriptions: true,
    reportDynamicContentChanges: true,
    reportAriaDescription: true,
    reportDetails: true,
    reportFontName: false,
    reportFontSize: false,
    fontAttributeReporting: 'off' as const,
    reportColor: false,
    reportStyle: false,
    reportSpellingErrors: ['speech'] as const,
    reportTables: true,
    includeLayoutTables: false,
    reportTableHeaders: 'rowsAndColumns' as const,
    reportTableCellCoordinates: true,
    reportLinks: true,
    reportLinkType: true,
    reportGraphics: true,
    reportComments: true,
    reportBookmarks: true,
    reportLists: true,
    reportHeadings: true,
    reportBlockQuotes: true,
    reportGroupings: true,
    reportLandmarks: true,
    reportArticles: false,
    reportFrames: true,
    reportFigures: true,
    reportClickable: true,
  };
}
