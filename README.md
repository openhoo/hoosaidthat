# HooSaidThat for Playwright

Normal Playwright tests with real screenreader actions and evidence. Supported
adapters: Orca protocol v1, independent Go HooVDA protocol v2, and real NVDA
2026.1.1 through an externally managed Windows reference oracle.
HooVDA targets the immutable `nvda-web-2026.1.1` web profile through pinned
public behavior assertions and native-Linux observations; it contains no NVDA
code or binary.

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

The declared `nvda-web-2026.1.1` browser profile contains 190 unique actions.
HooVDA and real NVDA run the same command-specific semantic oracle, core web
behavior corpus, presentation-settings/reset contract, privacy checks, and
event-provenance assertions. Release qualification executes every action in all
four `en-US`/`de-DE` and desktop/laptop cells. Command shards keep each browser
session bounded without weakening total coverage.

Chrome 151's visited-link and spelling-error quick-navigation boundaries are
asserted as exact real-NVDA English/German output, not mislabeled as successful
element traversal. These gates prove the declared browser-testing profile, not
unrestricted NVDA desktop, add-on, touch, or application-specific parity.

Publishing remains an explicit tagged release operation. No unversioned npm
package or OCI image is published from normal CI.
Normal push and pull-request CI runs package checks and the small Orca image
smoke/E2E gate only. The complete HooVDA parity matrix stays local and in the
explicitly dispatched release workflow so ordinary commits do not spend hours
of hosted-runner time.
The hosted release workflow and required credentials are documented in
[`docs/releasing.md`](docs/releasing.md). It requalifies npm, HooVDA, and Orca
before publishing version-only artifacts with SBOM and provenance attestations.
Real-NVDA qualification runs separately on a trusted self-hosted KVM runner or
an operator workstation because GitHub-hosted Linux runners do not provide this
persistent licensed Windows oracle.

## Local build

HooVDA engine and Playwright runtime use separate public repositories:

```bash
git clone git@github.com:openhoo/hoovda.git ../hoovda
npm ci
npx playwright install ffmpeg
npm run image:build:hoovda
npm run image:smoke:hoovda
```

Orca remains available:

```bash
npm run image:build:orca
npm run image:smoke:orca
```

Both container paths are Linux/amd64. Normal runtime and CI require no Windows,
VM, KVM, Wine, NVDA executable, or NVDA fork. Optional real-NVDA qualification
uses the repository's Windows 11 KVM oracle:

```bash
npm run nvda:windows:doctor
npm run nvda:windows:up
npm run nvda:windows:wait
npm run nvda:windows:parity
```

Windows state, generated SSH identity, pinned host key, password, and bearer
token stay outside Git under `~/VMs/hoosaidthat-nvda`. See the
[Windows NVDA oracle guide](oracle/windows-nvda/README.md).

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

Real NVDA uses the same fixtures against external endpoints:

```ts
export default defineConfig({
  use: {
    screenReaderOptions: {
      screenReader: 'nvda',
      runtime: 'external',
      profile: 'nvda-web-2026.1.1',
      locale: 'en-US',
      keyboardLayout: 'desktop',
      controlEndpoint: 'http://127.0.0.1:3002',
      cdpEndpoint: 'http://127.0.0.1:9224',
      controlToken: process.env.HOOSAIDTHAT_NVDA_CONTROL_TOKEN,
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

For Linux runtimes, ordinary actions become complete physical X11 gestures and
pass through the AT-SPI device listener. Real NVDA delivers gestures through
NVDA's official system-test emulation boundary:

```ts
await screenReader.act('nextLandmark');
await screenReader.act('nextHeading2');
await screenReader.act('nextFormField');
await screenReader.act('activate');
await screenReader.reportDetails();
await screenReader.elementsList();
```

Find needs a query. `findText()` sends that bounded string through the v2
structured control API; subsequent `findNext` and `findPrevious` actions use
the runtime's normal gesture path:

```ts
await screenReader.findText('order total');
await screenReader.act('findNext');
await screenReader.act('findPrevious');
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
await expect(screenReader.regressionTranscript()).toMatchSnapshot('checkout.hoovda.txt');
```

`regressionTranscript()` removes internal page-focus setup and keeps output
correlated with each recorded action. `transcript()` remains the complete raw
flow, including browser focus transitions.

Every HooVDA test attaches:

- stable text and JSON flow transcripts;
- structured event and accessible-document JSON;
- synthesized screenreader WAV;
- container-recorded WebM with screenreader audio;
- runtime provenance;
- requested screenshots.

The page overlay shows current action, speech, and braille evidence in normal
Playwright video. HooVDA also records container A/V, so its WebM contains real
eSpeak audio synchronized to the browser display. Real NVDA uses Playwright's
browser video with the same synchronized overlay; its capture boundary is
structured presentation hooks, not acoustic Windows audio.

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

This visits every exported structural group: headings, landmarks, buttons,
form fields and their subtypes, links, lists and list items, tables,
graphics, text paragraphs, frames, separators, block quotes, embedded objects,
annotations, spelling or grammar errors, and non-link text. It exports an image
for each observed output plus a JSON manifest. Each result includes its ordered
`screenshots` paths. `scan()` remains available for custom action loops.

## Options

- `screenReader`: `orca`, `hoovda`, or `nvda`; default `orca`
- `profile`: `nvda-web-2026.1.1`
- `locale`: `en-US` or `de-DE`
- `keyboardLayout`: `desktop` or `laptop`
- `runtime`: `auto`, `docker`, `podman`, or `external`
- `image`: OCI image reference
- `recording`: `on` or `off`; default `on`
- `startupTimeoutMs`: default `60000`, maximum `600000`
- `actionTimeoutMs`: default `5000` for Orca and `15000` for HooVDA/NVDA; maximum `30000`
- `quietMs`: default `300`, maximum `5000`
- `overlay`: default `true`
- `actionScreenshots`: `off` or `on`
- `keepContainer`: retain stopped container for diagnosis
- `viewport`: Xvfb dimensions; default `1280x720`
- `containerEngineArgs`: extra trusted Docker/Podman arguments; rejected for external NVDA

Externally managed runtimes require `controlEndpoint`, `cdpEndpoint`, and
`controlToken`. Plain HTTP endpoints must target host loopback; use HTTPS for
non-loopback endpoints, normally behind an SSH tunnel or equivalent secure
transport.

## Evidence boundary

HooVDA consumes real Chromium AT-SPI objects. It produces structured
presentation, braille translation, and eSpeak PCM from its own Go engine. This
is stronger than asserting against a browser accessibility snapshot. It still
does not certify WCAG conformance, simulate disabled people's lived experience,
or prove unrestricted NVDA parity. The passing provenance-pinned gate proves
only its declared browser-profile cases.

Real NVDA evidence is captured at `speech.extensions.pre_speechQueued` and
`braille.pre_writeCells`. It proves NVDA presentation requests and braille
display writes, not acoustic output or user perception. Windows is a reference
oracle; no Windows or NVDA image is published as an OCI container.

See [runtime protocol](docs/runtime-protocol.md),
[HooVDA image](images/hoovda/README.md), and
[Orca image](images/orca/README.md), and the
[Windows NVDA oracle](oracle/windows-nvda/README.md).
