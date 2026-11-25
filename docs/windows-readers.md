# NVDA and JAWS in Docker with WinHoo

Run the controller inside x64 Linux or a WSL2 distribution with a local Linux Docker daemon, Docker Compose, Node, npm, Python 3 and accessible `/dev/kvm` and `/dev/net/tun`. Each reader has its own Windows desktop, disk and credentials. Tests can connect from the same Linux distribution; the reader and Chrome run together inside Windows. The Windows workstation's own screen reader and Docker Desktop do not need to be running.

## Run a speech check

1. From the WinHoo source checkout, build its general desktop image:

   ```sh
   docker build --platform linux/amd64 -f desktop/Dockerfile.amd64 -t winhoo-desktop:0.4.0-amd64 .
   ```

2. From the HooSaidThat checkout, install the locked dependencies and build the Playwright fixtures:

   ```sh
   npm ci
   npm run build
   ```

3. Start a reader and run the packaged check in one command. For NVDA, set `reader=nvda`; for JAWS, use `reader=jaws`:

   ```sh
   reader=jaws
   node scripts/windows-reader-docker.mjs "$reader" doctor
   node scripts/windows-reader-docker.mjs "$reader" run -- \
     ./node_modules/.bin/playwright test --config oracle/native-check/playwright.config.mjs
   ```

   The first boot installs Windows and the reader. Later runs reuse the disk. The check navigates by heading, focuses a button and waits for an asynchronous status announcement. JAWS also reads table cells and announces a checkbox's state after activation. Each assertion uses captured reader output. The wrapper waits for the reader and browser and supplies the matching endpoints and control token to the test process. Use one Playwright worker per desktop.

For a manual investigation, run `up`, `status`, and `wait` separately. `up` means that the VM started; `wait` checks the reader. A manual `up` leaves the guest available across test runs; finish with `down` to stop it and retain its disk. Private state defaults to `~/VMs/hoosaidthat-<reader>-docker`. Choose a different location with `HST_NVDA_RUNTIME_ROOT` or `HST_JAWS_RUNTIME_ROOT` before initialization. Keep it outside the repository.

To test an updated package on an already provisioned guest, rebuild HooSaidThat and run:

```sh
npm run build
node scripts/windows-reader-docker.mjs "$reader" sync
```

NVDA updates its authenticated control plugin. JAWS verifies the staged tarball and scripts, installs them into a fresh application directory and restarts its dedicated bridge task. Both wait for real reader and browser readiness. A new JAWS, Chrome or Node pin requires a newly provisioned guest.

From an installed npm package, use `hoosaidthat-windows-reader --help` and the same subcommands. For the packaged check use Playwright with `--config node_modules/@openhoo/hoosaidthat/oracle/native-check/playwright.config.mjs`.

## Run your own tests

Use the same Playwright project for either reader. The wrapper sets `SCREEN_READER` and the endpoint and token variables that the fixtures read:

```ts
import { defineConfig } from '@openhoo/hoosaidthat';

const reader = process.env.SCREEN_READER;
if (reader !== 'jaws' && reader !== 'nvda') throw new Error('Start this suite with the Windows reader runner');

export default defineConfig({
  workers: 1,
  use: { screenReaderOptions: { screenReader: reader, webReport: 'on' } },
});
```

Run `hoosaidthat-windows-reader jaws run -- npx playwright test` from your project. Chrome opens URLs inside Windows: an application URL must be reachable from that guest. A server bound to the controller's `127.0.0.1` is a different machine. The packaged checks use self-contained pages so they need no separate web server.

For a longer JAWS navigation check, use `oracle/native-check/jaws-navigation.config.mjs` instead of `playwright.config.mjs` in the speech-check command above. This checks forward and backward movement across heading levels, controls, graphics, list items and unvisited links. It compares the *name of the next target* with what JAWS actually said.

To exercise NVDA's English and German profiles with both keyboard layouts, run the full matrix or replay one block through the same Docker desktop:

```sh
node scripts/windows-reader-docker.mjs nvda run -- node scripts/nvda-windows.mjs parity
node scripts/windows-reader-docker.mjs nvda run -- node scripts/nvda-windows.mjs parity-shard en-US desktop actions-03
```

## Guest storage and capture

For a new private runtime on a WinHoo image supporting sparse backups, `HST_WINHOO_DOCKER_SPARSE_BACKUP=1` opts into a full sparse backup on filesystems without reflinks. The policy and image ID are saved on initialization. To use a separately copied, stopped NVDA guest, set `HST_WINHOO_DOCKER_CLONED_DISK=1` at initialization and keep its `state/`, `shared/`, `ssh/` and private `.env` together. Leave the original guest disk untouched.

| Reader | Viewer on the Docker host | Control | Chrome CDP | Output |
| --- | --- | --- | --- | --- |
| NVDA 2026.1.1 | 127.0.0.1:8008 | 3002 | 9224 | Queued speech, braille cells and cursor |
| JAWS 2027 | 127.0.0.1:8009 | 3004 | 9226 | Speech from JAWS Remote Command Server |

The JAWS guest installs the vendor's Remote Command Server component. The `jaws-web` profile supports US English and the desktop keyboard layout. A valid JAWS license or an available vendor demonstration session is required. The bridge checks the running reader and captures a real bootstrap announcement before reporting readiness. Inspect the guest's `C:\HooSaidThat-JAWS\runtime.log` and the private `shared/bootstrap/status.json` if it does not start. A new guest can reuse checksum-verified installers in `shared/cache`: `jaws-installer.exe`, `node.zip` and `chrome.zip`; the expected hashes are in the JAWS runtime lock.

JAWS speech events are text, not recorded audio or braille. Its advertised keyboard actions are a subset of the NVDA matrix. For NVDA's separate 40-block release qualification, see the [Windows NVDA oracle](../oracle/windows-nvda/README.md). A smoke-check result is not that qualification.
