import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readRuntimeFile } from './runtime-file.mjs';

const files = ['winhoo_desktop.py', 'desktop/runtime.json', 'desktop/owner-watchdog.sh'];
const bundlePath = '/usr/share/winhoo/controller';

function validateBundle(root, version, privateCopy = false) {
  const hashes = {};
  let manifest;
  for (const name of files) {
    const path = join(root, name);
    const bytes = readRuntimeFile(path, 1024 * 1024, { privateCopy });
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
    if (name === 'desktop/runtime.json') manifest = JSON.parse(bytes.toString('utf8'));
  }
  if (
    manifest.schema !== 'winhoo.desktop-runtime/1' ||
    manifest.version !== version ||
    manifest.kind !== 'windows-desktop-vm' ||
    manifest.configurationSchema !== 'winhoo.desktop/1' ||
    manifest.controller !== 'winhoo_desktop.py' ||
    manifest.controllerBundle !== bundlePath ||
    !Array.isArray(manifest.applications) ||
    manifest.applications.length !== 0
  ) {
    throw new Error(
      `Unsupported WinHoo desktop contract; expected general Windows desktop runtime ${version}.`,
    );
  }
  if (
    manifest.guestTools?.hiddenLauncher !==
    String.raw`C:\ProgramData\WinHoo\tools\WinHoo.RunHidden.exe`
  ) {
    throw new Error(
      'WinHoo desktop image is missing the hidden launcher contract; load the current desktop image before starting Windows.',
    );
  }
  return hashes;
}

/** Obtain the general WinHoo controller from the same immutable image we run. */
export function resolveWinhooRuntime({
  runtimeRoot,
  engine,
  architecture,
  version,
  image = `winhoo-desktop:${version}-${architecture}`,
  run = spawnSync,
  progress = () => {},
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/u.test(image))
    throw new Error('Invalid HST_WINHOO_DOCKER_IMAGE reference.');
  const invoke = (args, timeout = 30_000) => {
    const result = run(engine, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0)
      throw new Error(
        `WinHoo image ${args[0]} failed: ${(result.stderr || result.error?.message || 'engine command failed').trim().slice(0, 1000)}`,
      );
    return result.stdout.trim();
  };
  let record;
  try {
    record = JSON.parse(invoke(['image', 'inspect', image]))[0];
  } catch (error) {
    throw new Error(
      `WinHoo image ${image} is unavailable. Load the WinHoo desktop image with \`${engine} load --input <winhoo-image.tar>\`. ${error.message}`,
    );
  }
  const id = record?.Id ?? record?.ID;
  const labels = record?.Config?.Labels ?? {};
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(id ?? '') ||
    record.Os !== 'linux' ||
    record.Architecture !== architecture ||
    labels['io.openhoo.winhoo.desktop.runtime'] !== 'winhoo.desktop-runtime/1' ||
    labels['io.openhoo.winhoo.desktop.version'] !== version ||
    labels['io.openhoo.winhoo.desktop.applications'] !== 'none'
  ) {
    throw new Error(
      `WinHoo image must be the general Linux ${architecture} desktop runtime ${version}.`,
    );
  }
  const cacheRoot = join(runtimeRoot, 'winhoo-controller');
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700);
  const root = join(cacheRoot, id.slice(7));
  const cached = () => {
    const hashes = validateBundle(root, version);
    const marker = JSON.parse(readRuntimeFile(join(root, 'image.json'), 4096).toString('utf8'));
    if (marker.image !== id || JSON.stringify(marker.hashes) !== JSON.stringify(hashes)) {
      throw new Error(`WinHoo controller cache is damaged: ${root}`);
    }
    return { root, controller: join(root, 'winhoo_desktop.py'), buildImage: false, image: id };
  };
  if (existsSync(root)) return cached();
  progress(`Preparing WinHoo desktop ${version} controller from the installed image`);
  const temporary = mkdtempSync(join(cacheRoot, '.extract-'));
  const name = `hst-winhoo-controller-${randomBytes(12).toString('hex')}`;
  let created = false;
  try {
    // This container never boots Windows, publishes ports or mounts runtime data.
    invoke(['create', '--name', name, '--network', 'none', '--entrypoint', '/bin/true', id]);
    created = true;
    mkdirSync(join(temporary, 'desktop'), { mode: 0o700 });
    for (const file of files) {
      invoke(['cp', `${name}:${bundlePath}/${file}`, join(temporary, file)]);
    }
    const hashes = validateBundle(temporary, version, true);
    writeFileSync(join(temporary, 'image.json'), `${JSON.stringify({ image: id, hashes })}\n`, {
      mode: 0o600,
    });
    try {
      renameSync(temporary, root);
    } catch (error) {
      if (!existsSync(root)) throw error;
    }
    return cached();
  } finally {
    try {
      if (created) invoke(['rm', '--volumes', name]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
