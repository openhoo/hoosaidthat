# HooSaidThat for Playwright

Normal Playwright tests with real Linux screenreader actions and evidence.
Supported adapters: Orca protocol v1 and clean-room Go HooVDA protocol v2.
HooVDA targets the immutable `nvda-web-2026.1.1` web profile through black-box
conformance; it contains no NVDA code or binary.

```ts
import { expect, test } from '@openhoo/hoosaidthat';

test('checkout is announced', async ({ page, screenReader }) => {
  await page.goto('/checkout');
  await screenReader.returnToPage();
  await screenReader.nextHeading();
  await expect(screenReader).toHaveSpoken(/Checkout.*heading/i);
  await expect(screenReader).toHaveBraille(/Checkout/i);

  await screenReader.focus(page.getByRole('button', { name: 'Pay now' }));
  await expect(screenReader).toHaveSpoken(/Pay now.*button/i);
});
```

## Release state

Private development only. No npm package or OCI image may be published until
HooVDA's independently captured NVDA 2026.1.1 oracle corpus is complete and
`hoovda conformance` passes. Current code does not claim full NVDA parity.
The manual release workflow and required credentials are documented in
[`docs/releasing.md`](docs/releasing.md); it performs this gate again before
publishing version-only artifacts with SBOM and provenance attestations.

## Local build

HooVDA engine and Playwright runtime use separate private repositories:

```bash
git clone git@github.com:openhoo/hoovda.git ../hoovda
npm ci
npm run image:build:hoovda
npm run image:smoke:hoovda
```

Orca remains available:

```bash
npm run image:build:orca
npm run image:smoke:orca
```

Both paths are Linux/amd64. No Windows, VM, KVM, Wine, NVDA executable, or
NVDA fork enters normal runtime or CI.

## Configuration

```ts
import { defineConfig } from '@openhoo/hoosaidthat';

export default defineConfig({
  use: {
    video: 'on',
    trace: 'retain-on-failure',
    screenReaderOptions: {
      screenReader: 'hoovda',
      image: 'hoosaidthat-hoovda:dev',
      profile: 'nvda-web-2026.1.1',
      locale: 'en-US',
      keyboardLayout: 'desktop',
      recording: 'on',
      overlay: true,
      actionScreenshots: 'on',
    },
  },
});
```

One runtime container starts per Playwright worker. Playwright connects over
CDP to Chromium inside it. Ordinary `page`, `context`, trace, screenshot, and
assertion APIs remain available. Host networking lets container Chromium reach
Linux development servers at `127.0.0.1`.

Only run trusted sites. Chromium uses `--no-sandbox`, loopback CDP, and host
networking. Screenreader control binds to loopback and requires a random bearer
token.

## Actions and evidence

Actions become complete physical X11 gestures, then pass through the actual
AT-SPI device listener:

```ts
await screenReader.act('nextLandmark');
await screenReader.act('nextHeading2');
await screenReader.act('nextFormField');
await screenReader.act('activate');
```

Each observation contains ordered typed events plus derived text:

```ts
const observation = await screenReader.nextHeading();
console.log(observation.speech);
console.log(observation.braille);
console.log(observation.events); // speech, braille, focus, mode, audio, lifecycle
```

For output caused by ordinary page operations:

```ts
const observation = await screenReader.observe('Open dialog', async () => {
  await page.getByRole('button', { name: 'Open' }).click();
});
```

Regression-test a complete stable flow with Playwright snapshots:

```ts
await screenReader.nextHeading();
await screenReader.nextFormField();
await screenReader.activate();
await expect(screenReader.transcript()).toMatchSnapshot('checkout.hoovda.txt');
```

Every HooVDA test attaches:

- stable text and JSON flow transcripts;
- structured event and accessible-document JSON;
- synthesized screenreader WAV;
- container-recorded WebM with screenreader audio;
- runtime provenance;
- requested screenshots.

The page overlay shows current action, speech, and braille evidence in normal
Playwright video. HooVDA also records container A/V, so its WebM contains real
eSpeak audio synchronized to the browser display.

## Element images

Focused controls:

```ts
await screenReader.captureElements([
  { name: 'email', locator: page.getByLabel('Email') },
  { name: 'pay-now', locator: page.getByRole('button', { name: 'Pay now' }) },
]);
```

Automated structural export:

```ts
await screenReader.capturePageElements({ maxPerKind: 100, screenshots: true });
```

This visits headings, landmarks, buttons, form fields, links, lists, tables,
and graphics with screenreader navigation, then exports an image for each
observed output plus a JSON manifest. Each result includes its ordered
`screenshots` paths. `scan()` remains available for custom action loops.

## Options

- `screenReader`: `orca` or `hoovda`; default `orca`
- `profile`: `nvda-web-2026.1.1`
- `locale`: `en-US` or `de-DE`
- `keyboardLayout`: `desktop` or `laptop`
- `runtime`: `auto`, `docker`, `podman`, or `external`
- `image`: OCI image reference
- `recording`: `on` or `off`; default `on`
- `startupTimeoutMs`: default `60000`, maximum `600000`
- `actionTimeoutMs`: default `5000` for Orca and `15000` for HooVDA; maximum `30000`
- `quietMs`: default `300`, maximum `5000`
- `overlay`: default `true`
- `actionScreenshots`: `off` or `on`
- `keepContainer`: retain stopped container for diagnosis
- `viewport`: Xvfb dimensions; default `1280x720`
- `containerEngineArgs`: extra trusted Docker/Podman arguments

Externally managed runtimes require `controlEndpoint`, `cdpEndpoint`, and
`controlToken`.

## Evidence boundary

HooVDA consumes real Chromium AT-SPI objects. It produces structured
presentation, braille translation, and eSpeak PCM from its own Go engine. This
is stronger than asserting against a browser accessibility snapshot. It still
does not certify WCAG conformance, simulate disabled people's lived experience,
or prove NVDA parity until the black-box conformance gate passes.

See [runtime protocol](docs/runtime-protocol.md),
[HooVDA image](images/hoovda/README.md), and
[Orca image](images/orca/README.md).
