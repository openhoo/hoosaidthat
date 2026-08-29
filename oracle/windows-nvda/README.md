# Windows NVDA reference oracle

Dedicated real-NVDA parity oracle. Not npm runtime and not a Windows product
dependency. Normal Orca/HooVDA tests remain Linux containers. This VM provides
the reference traces used to prove the declared `nvda-web-2026.1.1` profile.

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
