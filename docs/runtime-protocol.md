# Screenreader runtime protocols

All control endpoints bind to loopback and require:

```text
Authorization: Bearer <token>
```

The runtime owns graphical Chromium. Playwright connects separately over CDP.
HooSaidThat supports legacy Orca protocol v1 plus protocol v2 implementations
for HooVDA and the real-NVDA Windows oracle.

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
- structured find input with `{"command":"find","argument":"order total"}`
- `GET /v2/sessions/{id}/events?after=12&timeoutMs=15000`
- `GET /v2/sessions/{id}/document`
- `POST /v2/sessions/{id}/finish`
- `GET /v2/sessions/{id}/artifacts/{name}`

Ordinary actions inject complete physical X11 gestures. The AT-SPI global
device listener maps that observed gesture back to the semantic command. Find
is the sole structured-input exception because its query would normally be
typed into an NVDA-owned dialog; the bounded query is delivered directly and
the response declares `"delivery":"structured"`. Other actions declare
`"delivery":"physical"`. Find-next and find-previous remain physical.

Ordered event kinds:

- `commandStarted`, `commandSettled`
- `speech` with structured speech commands
- `braille` with logical NVDA-style buffer text plus translated cells and cursor
- `focus`, `mode`, `liveRegion`
- `audio` with monotonic offset and duration

`sequence` is process-global and monotonic. Clients reject truncated history,
backward cursors, malformed UTF-8, oversized JSON, duplicate artifact names,
and artifact byte-count or SHA-256 mismatches. `monotonicNs` shares the clock used
to place synthesized PCM into the recorded timeline. An action response includes
all causally observed events after its pre-injection cursor and waits for a
bounded quiet interval.

State also exposes HooVDA browse/focus mode and `cursorInDocument`. The optional
`browse` object identifies the current virtual-buffer object and includes exact
`quickNavigationTargets` matched by HooVDA. Link objects include `visited`.
Protected object names are withheld and marked `redacted`. Document objects can
include `documentUrlSha256`, the lowercase SHA-256 digest of the exact URL
reported by AT-SPI; the raw URL is never returned. These fields let page element
export include an element already selected by `documentStart`, without guessing
from localized speech. Page-focus verification requires a runtime-native
web-content focus signal. HooSaidThat additionally matches `documentUrlSha256`
against the active Playwright page when available; a Chromium tab wrapper or an
active CDP document alone is insufficient.

Finish closes the test recording and returns SHA-256-bound artifacts:

- `screenreader-events`
- `screenreader-document`
- `screenreader-audio`
- `screenreader-video` when recording was enabled

Clients must verify byte length and SHA-256 after download. HooSaidThat does.
Successful finish calls are idempotent while their artifacts remain retained,
so a client can safely retry after a lost HTTP response. HooVDA bounds retained
finished sessions to 32 and removes expired session directories.

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

## Real NVDA protocol v2

The Windows oracle implements the same health, action catalog, exclusive
session, state, action, event, finish, and `screenreader-events` artifact
contracts used by the v2 client. It deliberately does not claim HooVDA's
accessible-document, synthesized-audio, or container-video artifacts.

Ordinary commands call `inputCore.manager.emulateGesture` on NVDA's main
thread and declare `"delivery":"emulated"`. Structured find is the sole
exception and declares `"delivery":"structured"`. Speech comes from
`speech.extensions.pre_speechQueued`; braille comes from
`braille.pre_writeCells` plus display dimensions. These are presentation-hook
observations, not physical-keyboard or acoustic evidence. Consecutive
byte-identical idle braille refresh writes are coalesced. NVDA's blinking
cursor overlay is normalized into stable translated cells plus the separate
cursor index. Command-caused writes and identical frames separated by any
other event remain observable.
The NVDA oracle likewise makes successful finish calls idempotent and retains
the eight most recent event artifacts.

Locale is a process boundary. The SSH controller atomically selects `en-US` or
`de-DE`, restarts the owned runtime, and starts NVDA with its official `--lang`
override. Runtime status attests that locale. Session creation fails closed when
the requested locale does not match the running process; changing gettext state
inside an already-imported NVDA process is not accepted as localization proof.

Every declared action has a semantic speech or braille oracle. Chrome for
Testing 151 exposes no visited-link target and reports spelling quick navigation
as unsupported through its NVDA accessibility backend in this isolated profile.
The four commands remain exercised, but the gate asserts their exact localized
boundary presentation instead of claiming successful traversal.

Chrome listens on guest loopback. The NVDA plugin exposes a byte-for-byte CDP
proxy to the QEMU user-network boundary. Both host mappings remain loopback
only. A separate key-only, host-key-pinned SSH control plane manages the VM;
its forced dispatcher is not part of the browser/runtime HTTP protocol.

## Security and platform rules

- Orca and HooVDA containers are Linux/amd64; real NVDA is Windows 11 on KVM.
- Loopback control and CDP endpoints.
- Random bearer token per worker.
- One active protocol-v2 session per runtime.
- Strict JSON decoding and bounded request bodies/timeouts.
- Plain HTTP external endpoints are accepted only on host loopback; remote
  endpoints require HTTPS or a secure local tunnel.
- Normal container runtime needs no Windows, KVM, QEMU, Wine, or NVDA binary.
- The optional Windows oracle installs a hash-pinned official NVDA binary at runtime; repository and npm package contain no NVDA binary or source.
- Unknown commands and artifact names fail closed.
