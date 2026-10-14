# Annotated website reports

Enable a report in the normal Playwright configuration:

```ts
import { defineConfig } from '@openhoo/hoosaidthat';

export default defineConfig({
  use: {
    screenReaderOptions: {
      screenReader: 'hoovda',
      image: 'hoosaidthat-hoovda:dev',
      webReport: 'on',
      recording: 'on',
    },
  },
});
```

Run your usual tests. At fixture teardown each test attaches
`screen-reader-report.html` and writes it under that test's
`test-results/.../screenreader/` directory. Open the HTML directly in a browser,
send the file to someone, or serve it from any static website host. Images and
utterance audio are embedded; it needs no application server, external assets,
or internet connection. Hosting or sending a report is a separate user action.

## What the report shows

- One frozen viewport screenshot per observed action, captured after the
  action's bounded settlement interval. Opening a dialog or changing page
  content produces a new snapshot in the flow.
- The actual ordered speech events captured by the adapter, including localized
  text and the reader's roles, states, and other announcements. Annotation text
  is not inferred from DOM labels.
- Speech annotations on their source elements. HooVDA uses exact AT-SPI object
  identity and the accessible document's screen coordinates to locate elements.
  Explicit `focus(locator)` captures can also mark a verified focus-related
  utterance at the locator. No text matching guesses are used.
- Repeated or crowded source labels are listed below the snapshot so each
  utterance remains reachable without hiding another label.
- Clicking a text annotation, or its entry below the snapshot, plays a WAV clip
  cut from the original runtime WAV. Each clip uses the recorder's exact sample
  range, including its session origin, rounding, and serialized overlaps. The
  viewer does not synthesize replacement speech.

- Step navigation, searchable speech and audio playback directly from text
  labels. Clicking a playing label pauses it; switching snapshots stops audio.
  Braille and raw event provenance remain in the embedded report data.
  Keyboard users can activate the same annotations as mouse users. The layout adapts to small screens.
- A minimal snapshot workspace with speech labels on the website, optional
  annotations and an actual-size view. Browser focus setup is folded away;
  mobile navigation opens only when requested. A `#step=` URL preserves the
  selected moment using its stored snapshot ID, including nonconsecutive IDs.
  The website uses the full content width, without a separate
  speech or audio sidebar.

Snapshots represent the page at action settlement, not a video frame for every
individual speech event inside a long action. Offscreen or removed elements,
navigation boundaries, browser chrome, and adapters without native source
geometry remain in the transcript with an explicit unavailable position.
Closed or unshootable pages retain their speech with a missing-snapshot notice.
An optional native geometry failure preserves the screenshot and captured
speech with unavailable positions. A recording download failure preserves the
portable report and transcript; original audio is unavailable when its WAV or
sample index could not be downloaded. Other successfully verified artifacts
are retained even when one download fails; the test still reports the failure.

## Audio availability

Playback requires a HooVDA engine that exports `audioTimeline` in its
`screenreader-events` artifact. Rebuild the HooVDA engine and HooSaidThat image
from the companion source change before using this feature. Existing published
images may not include the index. The exact contract is described in
[runtime-protocol.md](runtime-protocol.md).

Orca protocol v1 and the real NVDA presentation-hook adapter currently provide
no original WAV or sample index. Their reports preserve captured speech and
snapshots and explicitly show audio as unavailable. A missing, cancelled, or
invalid audio segment is never replaced with a generated voice.

`webReport` defaults to `off` because storing a screenshot after every action
adds capture time and increases report size. Recording with `recording: 'off'`
disables HooVDA's video capture; the engine still exports its synthesized WAV.
Password inputs are masked in report screenshots. Other visible page content
and captured speech are included, so share reports with the same care as test
screenshots and transcripts.

For consumers with their own capture pipeline, `renderScreenReaderReport()` and
the `ScreenReaderReport`, `ReportSnapshot`, and `ReportAnnotation` types are
exported from the package.

## Verify a report locally

In a source checkout, the dedicated test records a checkout flow and an opened
dialog:

```bash
SCREEN_READER_IMAGE=hoosaidthat-hoovda:report npm run test:e2e:report
```

Use your rebuilt image name in `SCREEN_READER_IMAGE`. The regular example
suite leaves report capture off; this command enables it explicitly.

The browser verification script checks an exported file's desktop/mobile
layout, annotation clicks, original audio duration, keyboard playback, stopped
audio on state changes, search, and absence of network requests:

```bash
npm run test:report-viewer -- /absolute/path/to/screen-reader-report.html
```

The verifier is also shipped in the npm package. From a consumer project with
the package and its supported Playwright peer installed, install Playwright's
matching Chromium once and invoke the verifier directly:

```bash
npx playwright install chromium
node node_modules/@openhoo/hoosaidthat/scripts/verify-web-report.mjs \
  /absolute/path/to/screen-reader-report.html /absolute/path/to/screenshots
```

This verifier expects a HooVDA report with at least two captured states and an
utterance that has both original audio and native geometry. It fails if those
required forms of evidence are absent. The synthetic edge-case and browser
session checks are development commands available in a source checkout:

```bash
npm run test:report-edges -- /absolute/path/to/edge-case-evidence
npm run test:session-browser
```

Release qualification runs all three browser checks and records a fresh report
against the candidate runtime image before publication.
