#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../oracle/android-talkback');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const executable = name => `${name}${process.platform === 'win32' ? '.exe' : ''}`;
const java = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', executable(name)) : executable(name);
async function run(command, args) {
  const { stdout, stderr } = await execute(command, args, { timeout: 120000, maxBuffer: 1024 * 1024 });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}
async function classes(path) {
  const files = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const entry = join(path, item.name);
    if (item.isDirectory()) files.push(...await classes(entry));
    else if (item.name.endsWith('.class')) files.push(entry);
  }
  return files;
}
async function main() {
  if (!sdk) throw new Error('set ANDROID_HOME to an SDK with platforms;android-35 and build-tools;35.0.0');
  const tools = join(sdk, 'build-tools', '35.0.0');
  const android = join(sdk, 'platforms', 'android-35', 'android.jar');
  await stat(android);
  const build = join(root, 'build');
  await mkdir(build, { recursive: true });
  const key = join(build, 'test-only.p12');
  try { await stat(key); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await run(java('keytool'), ['-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android',
      '-alias', 'androiddebugkey', '-dname', 'CN=HooSaidThat Test Only', '-keyalg', 'RSA', '-validity', '3650']);
  }
  for (const [name, source] of [['capture', 'CaptureService.java'], ['probe', 'Probe.java']]) {
    const out = join(build, name);
    await rm(out, { recursive: true, force: true });
    await mkdir(join(out, 'classes'), { recursive: true });
    await mkdir(join(out, 'dex'), { recursive: true });
    await run(java('javac'), ['--release', '8', '-classpath', android, '-d', join(out, 'classes'), join(root, name, source)]);
    await run(java('java'), ['-cp', join(tools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--lib', android, '--min-api', '34',
      '--output', join(out, 'dex'), ...await classes(join(out, 'classes'))]);
    const unsigned = join(out, 'unsigned.apk');
    await run(join(tools, executable('aapt2')), ['link', '-I', android, '--manifest', join(root, name, 'AndroidManifest.xml'), '-o', unsigned]);
    await run(java('jar'), ['uf', unsigned, '-C', join(out, 'dex'), 'classes.dex']);
    const apk = join(build, `hoosaidthat-${name}.apk`);
    await run(join(tools, executable('zipalign')), ['-f', '4', unsigned, apk]);
    await run(java('java'), ['-jar', join(tools, 'lib', 'apksigner.jar'), 'sign', '--ks', key,
      '--ks-pass', 'pass:android', '--key-pass', 'pass:android', apk]);
    await run(java('java'), ['-jar', join(tools, 'lib', 'apksigner.jar'), 'verify', apk]);
    console.log(apk);
  }
}
main().catch(error => { console.error(`TalkBack APK build failed: ${error.message}`); process.exitCode = 1; });
