# Screenreader runtime protocols

All control endpoints bind to loopback and require:

```text
Authorization: Bearer <token>
```

The runtime owns graphical Chromium. Playwright connects separately over CDP.
HooSaidThat supports legacy Orca protocol v1 and HooVDA protocol v2.

## HooVDA protocol v2

`GET /v2/health` and `GET /v2/actions` expose immutable profile identity and
the supported semantic command catalog.

Each Playwright test owns one exclusive runtime session:

```http
POST /v2/sessions
Content-Type: application/json

{"testId":"checkout","recording":true}
```

Session endpoints:

- `GET /v2/sessions/{id}/state`
- `POST /v2/sessions/{id}/actions` with `{"command":"nextHeading"}`
- `GET /v2/sessions/{id}/events?after=12&timeoutMs=15000`
- `GET /v2/sessions/{id}/document`
- `POST /v2/sessions/{id}/finish`
- `GET /v2/sessions/{id}/artifacts/{name}`

Actions inject complete physical X11 gestures. The AT-SPI global device
listener maps that observed gesture back to the semantic command. Direct engine
method calls are not used by production actions.

Ordered event kinds:

- `commandStarted`, `commandSettled`
- `speech` with structured speech commands
- `braille` with translated cells and cursor
- `focus`, `mode`, `liveRegion`
- `audio` with monotonic offset and duration

`sequence` is process-global and monotonic. `monotonicNs` shares the clock used
to place synthesized PCM into the recorded timeline. An action response includes
all causally observed events after its pre-injection cursor and waits for a
bounded quiet interval.

Finish closes the test recording and returns SHA-256-bound artifacts:

- `screenreader-events`
- `screenreader-document`
- `screenreader-audio`
- `screenreader-video` when recording was enabled

Clients must verify byte length and SHA-256 after download. HooSaidThat does.

## Orca protocol v1

Legacy endpoints remain:

- `GET /v1/health`
- `GET /v1/state`
- `GET /v1/actions`
- `POST /v1/actions`
- `GET /v1/events`

Orca events contain captured Speech Dispatcher presentation text. Protocol v1
has no per-test runtime A/V artifact lifecycle; Playwright video plus the page
overlay remains its recording path.

## Security and platform rules

- Linux/amd64 only.
- Loopback control and CDP endpoints.
- Random bearer token per worker.
- One active HooVDA session per runtime.
- Strict JSON decoding and bounded request bodies/timeouts.
- No Windows guest, KVM, QEMU, Wine, NVDA executable, or NVDA source.
- Unknown commands and artifact names fail closed.
