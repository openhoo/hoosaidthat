# Windows NVDA reference oracle

Dedicated real-NVDA parity oracle. Not npm runtime and not a Windows product
dependency. Normal Orca/HooVDA tests remain Linux containers. This VM provides
the reference traces used to prove the declared `nvda-web-2026.1.1` profile.

## Local Mac with WinHoo

Use a dedicated Windows 11 ARM64 desktop on Apple Silicon. The Windows install,
console login and SSH transport belong to WinHoo. The NVDA test process,
Chrome and Playwright all run inside that guest. Only its authenticated SSH
port is needed; leave the Windows firewall rules for public networks in place.

1. Install WinHoo with `desktop archive --output` and `desktop focus-window --pid … --started-ticks …`. Follow
   its local desktop guide, using `--account HstOracle`. Keep the same private
   VM directory across runs. No container engine or second computer is required.
2. Place the NVDA installer and Chrome archive listed in `runtime-lock.json`
   in a local cache. Provisioning verifies their sizes and SHA-256 hashes and
   reuses matching bytes already in the guest. Set `HST_WINHOO_BIN` to the
   installed CLI path if it is not on PATH.
3. Give every attempt a new evidence directory. First run the core and
   actions-03 diagnostics. For the complete matrix use a clean checkout of the
   signed candidate with the locked build dependencies installed.

```sh
node scripts/nvda-windows.mjs winhoo provision --desktop "$desktop" --cache "$media" --evidence "$evidence/provision-01"
node scripts/nvda-windows.mjs winhoo run --desktop "$desktop" --mode core --cache "$media" --evidence "$evidence/core-01"
node scripts/nvda-windows.mjs winhoo run --desktop "$desktop" --mode actions-08 --locale en-US --layout laptop --cache "$media" --evidence "$evidence/laptop-08-01"
node scripts/nvda-windows.mjs winhoo run --desktop "$desktop" --mode matrix --candidate "$(git rev-parse HEAD)" --cache "$media" --evidence "$evidence/matrix-01"
```

The controller verifies the active guest scripts, builds the parity suite and
ships it with integrity-checked Playwright packages, ARM64 Node and Windows
FFmpeg. Before starting the tests, it finds the browser that owns the live CDP
port on the dedicated console. WinHoo activates that process and records the
Windows foreground PID and method in `browser-focus.json`. Each invocation
owns a unique guest directory. The host retrieves the
guest identity, report JSON and ordered block records over WinHoo. On a failed
block it also downloads the original trace, video and reader events in
`failed-block.zip` before shutdown, with the guest digest in
`failure-archive.json`. If collection fails, that file records the error and
the original results stay on the guest for WinHoo's `collect --from-directory`.
Keep these files private until reviewed. A completed matrix
requires the same source and active guest bytes before and after, 40 passed
blocks with zero test retries, and confirmed guest shutdown. A readiness
probe, a diagnostic shard or two partial matrices cannot satisfy that gate.
Any core, actions-01 through actions-08 or settings block can be replayed
with its original language and keyboard layout. A failed matrix receipt
counts only its report-verified prefix and remains failed.

## Check the engine

`node scripts/nvda-windows.mjs preflight` (installed CLI: `hoosaidthat-nvda-windows preflight`)
prints the exact Podman container ID and state as JSON. It needs no running guest
or Playwright installation. A responsive engine with no oracle returns
`{"id":null,"state":"absent"}`; an unreachable engine or an uncertain result
exits nonzero within a five-second probe. No guest is started or stopped.
`up` reuses a running or booting QEMU and restarts it only after the guest has
recorded a completed shutdown. Parity checks authenticated runtime and browser
readiness after each locale change and uses that same fresh locale status.
The separate managed WinHoo controller is covered in
[the workstation adapter instructions](../../contrib/winhoo/README.md).

## Run and observe a qualification

Prepare the licensed guest once with the low-level commands below. Shut it down
with `control shutdown` and retain the container. Read its full ID with
`preflight`. The qualification controller takes exclusive ownership of a
**stopped** guest, checks its storage and shared mounts, and records the disk
identity. An active guest, different container, changed disk or busy lease
stops the new attempt. Do not run manual guest commands during an attempt.

On Linux with KVM, a clean checkout and installed locked dependencies:

```sh
npm run nvda:windows:qualification -- run --candidate "$(git rev-parse HEAD)" --container "$ORACLE_ID" --attempt release-1
```

For a Windows workstation with a prepared WSL2 Linux distribution, save a
private operator configuration on the controlling machine:

```json
{
  "host": "windows-oracle",
  "distribution": "Oracle",
  "user": "oracle",
  "source": "/srv/oracle/src/release-1",
  "runtime": "/srv/oracle/retained-runtime",
  "node": "/usr/bin/node",
  "candidate": "<full HooSaidThat commit SHA>",
  "container": "<full retained Podman container ID>"
}
```

The SSH alias selects the Windows login and identity. An optional absolute
`sshConfig` selects a dedicated local OpenSSH config. Enroll the Windows host
key first; host verification and noninteractive key authentication are
required. Keep the Windows user signed in. The on-demand task uses that user's
limited interactive token, and the WSL user must own the chosen Podman runtime.
The observer may disconnect or shut down; the Windows host must stay awake.

```sh
npx hoosaidthat-nvda-windows qualification prepare --config runner.json
npx hoosaidthat-nvda-windows qualification start --config runner.json --attempt release-1
npx hoosaidthat-nvda-windows qualification status --config runner.json --attempt release-1
```

`prepare` fetches the exact published Git commit into a fresh directory and
installs the locked dependencies and Playwright ffmpeg. It does not boot
Windows. `start` returns once Windows Task Scheduler has accepted the task.
Repeat `status` from another connection to see the phase, completed block count,
current block, scheduler state, evidence location and independent test and
shutdown results. An attempt ID is write-once; failed attempts retain their
data. `status` without an ID follows the runtime's currently selected attempt.
Use the same commands from source with `node scripts/nvda-windows.mjs`.

```sh
npx hoosaidthat-nvda-windows qualification start --config runner.json --attempt diagnose-1 --replay en-US desktop actions-08
npx hoosaidthat-nvda-windows qualification recover --config runner.json --attempt release-1
```

A replay gets a fresh attempt and does not count toward the forty release
blocks. `recover` is for an **interrupted attempt or unconfirmed shutdown**.
It rechecks the exclusive lease, attempt, container and disk, then asks the
guest to shut down. A disconnected SSH transport can fall back to one ACPI
power-button request; an unknown engine, changed host key or unconfirmed
shutdown is an error. Recovery never promotes partial evidence to a pass.
Use a fresh attempt ID for another full run.

For a prepared KVM guest, the controller also checks the authenticated Windows
session when NVDA or Chrome is unreachable. After 45 seconds of startup it
checks at most once every 30 seconds. Three consecutive reports of the same
locked, unoccupied console with an idle runtime task and neither app running
end the wait with `failureCode: guest-sign-in-required`. The controller then
shuts down its guest. Prepare the HstOracle interactive login before starting
a fresh attempt. Unknown session data or a transient boot screen cannot produce
this diagnosis; a successful login still requires the normal live checks.

Attempts live under `<runtime>/qualification/<attempt>`. `receipt.json` records
the exact HooSaidThat commit and tree, HooVDA pin and upstream tree. Before
boot, the controller compares the pinned engine source to upstream main;
`npm run hoovda:check` performs this check separately. Divergence means reviewing
and qualifying an updated pin. Releases repeat that check. `blocks.jsonl`
records every block and the number of selected and skipped Playwright cases.
`test-results/` holds per-block evidence. Keep the full logs and reports
private. Do not upload the runtime, disk, SSH directory or secrets.

## Start

```bash
npm run nvda:windows:doctor
npm run nvda:windows:up
npm run nvda:windows:wait
```

From an installed npm package, use the same controller without repository
scripts:

```bash
npx hoosaidthat-nvda-windows doctor
npx hoosaidthat-nvda-windows up
npx hoosaidthat-nvda-windows wait
npx hoosaidthat-nvda-windows control status
```

First boot downloads Windows through Dockur, then installs hash-pinned NVDA
2026.1.1 and Chrome for Testing 151.0.7922.47. Persistent VM state and secrets
default to `~/VMs/hoosaidthat-nvda`, outside Git. Ports bind only to loopback:

- viewer: `http://127.0.0.1:8008`
- RDP: `127.0.0.1:3392`
- key-only SSH control: `127.0.0.1:2224`
- authenticated NVDA control: `http://127.0.0.1:3002`
- Chrome CDP: `http://127.0.0.1:9224`

## Machine control

Routine administration uses a generated ed25519 identity and pinned guest host
key. SSH binds only to host loopback. Windows disables password authentication,
TTYs, forwarding, and tunnels; a forced dispatcher accepts eleven operator
commands plus the hash-bound internal payload-update command:

```bash
npm run nvda:windows:wait-ssh
npm run nvda:windows:control -- status
npm run nvda:windows:control -- start
npm run nvda:windows:control -- restart
npm run nvda:windows:control -- logs
npm run nvda:windows:control -- time-sync
npm run nvda:windows:control -- reconfigure-ssh
npm run nvda:windows:control -- locale-en-US
npm run nvda:windows:control -- locale-de-DE
npm run nvda:windows:control -- stop
npm run nvda:windows:control -- reboot
npm run nvda:windows:control -- shutdown
```

Direct SSH works too; forced command remains the same allowlist:

```bash
ssh -p 2224 \
  -i "$HOME/VMs/hoosaidthat-nvda/ssh/id_ed25519" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o "UserKnownHostsFile=$HOME/VMs/hoosaidthat-nvda/ssh/known_hosts" \
  -o StrictHostKeyChecking=yes \
  HstOracle@127.0.0.1 status
```

`status` also reports the owners, executable paths and Windows session IDs of
the runtime supervisor, NVDA and Chrome browser processes. Session diagnostics
include WTS connection state, account, protocol and lock state; unavailable
queries remain explicitly unknown. For RDP recovery, require an active,
unlocked HstOracle session containing the supervised NVDA and Chrome processes
before running parity, and keep that session connected throughout the gate.
The SSH observer's session is labeled separately. It does not attest the
runtime's input desktop, and these diagnostics do not replace live runtime,
CDP or parity evidence.

Update the installed control/plugin payload without RDP:

```bash
npm run nvda:windows:sync
npm run nvda:windows:control -- restart
```

`sync` stages exactly seven allowlisted files. Guest verifies exact names, byte
counts, individual SHA-256 hashes, and a content-derived generation before
atomic per-file replacement. It then validates the staged `sshd_config`,
restarts OpenSSH out of band, and waits for key-only control to recover. Restart
the screenreader runtime after plugin or runtime-script changes.

Locale commands atomically select the process locale, restart the owned
NVDA/Chrome task, and publish the active locale in runtime status. NVDA starts
with its official `--lang` override; session creation rejects a requested locale
that does not match the running NVDA process. `nvda:windows:parity` performs this
switch and attestation for every matrix cell automatically.

Client key, pinned `known_hosts`, VM disk, and Windows password stay outside the
repository under `~/VMs/hoosaidthat-nvda`. A changed guest host key fails closed;
verify VM identity before deliberately removing the old pin. RDP remains a
loopback-only recovery console, not the normal control path.

The operator remains responsible for Windows licensing. Repository contains no
Windows media, product key, NVDA binary, or browser binary.

## Playwright

Read the token without printing it, then pass endpoints through environment:

```bash
export SCREEN_READER=nvda
export SCREEN_READER_RUNTIME=external
export HOOSAIDTHAT_NVDA_CONTROL_ENDPOINT=http://127.0.0.1:3002
export HOOSAIDTHAT_NVDA_CDP_ENDPOINT=http://127.0.0.1:9224
export HOOSAIDTHAT_NVDA_CONTROL_TOKEN="$(<~/VMs/hoosaidthat-nvda/shared/secrets/control-token)"
npx playwright test
```

Capture boundary: NVDA processed speech queue and braille display writes. This
is real NVDA presentation evidence, not acoustic output or lived-experience
proof. Gesture delivery uses NVDA's official system-test emulation path and is
reported as `emulated`, never mislabeled as a physical keyboard event.

Windows can open consecutive Chrome test windows progressively farther down
the screen. HooSaidThat fits a normal NVDA test window inside its monitor's
work area before the test starts, preserving its size whenever it fits. This
keeps visible page controls reachable by NVDA's mouse commands. The native
core test starts with a displaced window and checks that NVDA actually clicks
the fixture button.

Live-region semantics use the object handler or the exact native IA2 report
callback's queued presentation call. The latter retains reported politeness and
processed speech across queue delay, without matching unrelated earlier speech.
It carries no source object, geometry, atomicity, relevance, or busy-state
metadata. Protection comes from the observed focus and any known object-handler
context; retained protected braille messages stay scrubbed on later redraws.

The matrix prints the locale, keyboard layout and block as each block starts.
To repeat a failed block on the running VM, copy the replay command from the
failure, or use the source checkout:

```sh
npm run nvda:windows:parity-shard -- en-US desktop actions-01
```

The command verifies the requested NVDA process locale and runs just `core`,
`actions-01` through `actions-08`, or `settings`. Each replay writes to a new
`test-results/nvda-replay-*` directory. The qualification controller runs all forty blocks for a release.

For a focused developer probe, first select the matching process locale, then
limit the semantic action loop. The release-grade matrix always clears this
subset variable:

```bash
npm run nvda:windows:control -- locale-en-US
npm run nvda:windows:wait
export HOOSAIDTHAT_NVDA_CONTROL_TOKEN="$(<~/VMs/hoosaidthat-nvda/shared/secrets/control-token)"
SCREEN_READER_LOCALE=en-US SCREEN_READER_KEYBOARD_LAYOUT=desktop \
  HOOSAIDTHAT_NVDA_PARITY_ACTIONS=nextHeading,nextAnnotation \
  npx playwright test --config oracle/parity/playwright.config.ts \
    --grep 'every declared'
```

Chrome 151 exposes exact backend boundaries for visited-link navigation and
spelling-error navigation in this isolated profile. Those four commands remain
in the catalog and are regression-tested against real NVDA's English/German
boundary presentation; they are not reported as successful element traversal.

Use `npm run nvda:windows:control -- shutdown` for guest-clean shutdown; the
wrapper then stops the idle container. `npm run nvda:windows:down` also removes
the container. Persistent state remains for later boots.
