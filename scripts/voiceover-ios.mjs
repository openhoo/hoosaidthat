#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRecording, recordingTools } from './native/ios-recording.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../oracle/ios-voiceover/HooSaidThat.xcodeproj', import.meta.url));
const help = `Usage: hoosaidthat-voiceover-ios doctor [--udid UUID]
       hoosaidthat-voiceover-ios run [--udid UUID] [--scenario FILE] [--results DIRECTORY]
       hoosaidthat-voiceover-ios record [--udid UUID] [--scenario FILE] [--results DIRECTORY] [--audio-device NAME] [--dedicated-mac-output]

Requires Xcode 27+ and an available iPhone Simulator with iOS 27+.
doctor lists eligible devices. Select one with --udid if several are available.
run and record open Mobile Safari or the installed app specified by bundleId.
record saves recording.mp4 with simulator pixels and a dedicated virtual audio loopback. Without --scenario it serves a local
heading and button and checks VoiceOver navigation in both directions.
Results: a new run directory under test-results/ios-voiceover (or --results).`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function check(condition, message) { if (!condition) throw new Error(message); }
function onlyKeys(value, keys) { return record(value) && Object.keys(value).every(key => keys.includes(key)); }

export function validateScenario(input) {
  check(onlyKeys(input, ['url', 'bundleId', 'readyText', 'steps']) && (('url' in input) !== ('bundleId' in input)), 'Scenario needs one of url or bundleId, and steps.');
  if ('readyText' in input) check(typeof input.readyText === 'string' && input.readyText.trim(), 'readyText must be a nonempty accessibility label.');
  if ('url' in input) {
    check(typeof input.url === 'string', 'The scenario URL must be a string.');
    const url = new URL(input.url);
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Use an HTTP(S) URL without embedded credentials.');
  } else check(typeof input.bundleId === 'string' && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(input.bundleId), 'Supply the bundleId of an installed app.');
  check(Array.isArray(input.steps) && input.steps.length >= 1 && input.steps.length <= 100, 'Expected 1 to 100 steps.');
  check(Buffer.byteLength(JSON.stringify(input)) <= 32_768, 'Scenario exceeds 32 KiB.');
  input.steps.forEach((step, i) => {
    const msg = `Invalid scenario step ${i + 1}`;
    check(onlyKeys(step, ['action', 'expect', 'until', 'maxMoves', 'text']) && ['current', 'forward', 'backward', 'in', 'out', 'activate', 'type'].includes(step.action), msg + ': unknown action or field.');
    if (step.action === 'type') check(typeof step.text === 'string' && step.text.length > 0 && step.text.length <= 2000, msg + ': type requires text (1..2000 characters).');
    else check(!('text' in step), msg + ': only type accepts text.');
    for (const key of ['expect', 'until']) {
      if (key in step) check(typeof step[key] === 'string' && step[key].trim().length, msg + ': expected a nonempty substring.');
    }
    if ('until' in step) {
      check(!('expect' in step) && !['current', 'activate', 'type'].includes(step.action) && Number.isInteger(step.maxMoves) && step.maxMoves >= 1 && step.maxMoves <= 50,
        msg + ': until requires a movement, maxMoves (1..50) and no expect.');
    } else check(!('maxMoves' in step), msg + ': maxMoves requires until.');
  });
  return input;
}

function eligible(devices, runtimes) {
  return runtimes.filter(r => r.isAvailable && r.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-') && parseInt(r.version, 10) >= 27)
    .flatMap(r => (devices[r.identifier] ?? [])
      .filter(d => d.isAvailable && /^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone(?:-|$)/.test(d.deviceTypeIdentifier))
      .map(d => ({ udid: d.udid, name: d.name, state: d.state, runtime: r.version, build: r.buildversion })));
}

export function selectDevice(devices, runtimes, udid) {
  const options = eligible(devices, runtimes);
  const matches = udid ? options.filter(d => d.udid.toLowerCase() === udid.toLowerCase()) : options;
  check(matches.length > 0, 'No matching available iPhone simulator with iOS 27+. Install an iOS 27+ runtime in Xcode and create an iPhone in Simulator.');
  check(matches.length === 1, 'Multiple iPhone simulators match. Select one with --udid:\n' + options.map(d => `${d.udid}  ${d.name} (iOS ${d.runtime})`).join('\n'));
  return matches[0];
}

export function validateTranscript(scenario, transcript) {
  check(transcript?.version === 1 && transcript.completed === true && transcript.url === scenario.url && transcript.bundleId === scenario.bundleId && Array.isArray(transcript.events), 'Incomplete or unrelated XCTest VoiceOver transcript.');
  let offset = 0;
  for (const [index, step] of scenario.steps.entries()) {
    const wanted = step.expect ?? step.until;
    let matched = false;
    for (let move = 0; move < (step.maxMoves ?? 1); move++) {
      const e = transcript.events[offset++];
      check(e?.step === index && e.action === step.action && typeof e.utterance === 'string' && e.utterance.trim().length, `Missing VoiceOver speech for step ${index + 1}.`);
      if (!wanted || e.utterance.includes(wanted)) { matched = true; break; }
    }
    check(matched, `VoiceOver did not speak the expected text at step ${index + 1}.`);
  }
  check(offset === transcript.events.length, 'Unexpected extra VoiceOver events.');
}

async function xcrun(args, timeout = 90_000) {
  return (await exec('/usr/bin/xcrun', args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

async function inventory() {
  check(process.platform === 'darwin', 'The iPhone simulator needs macOS and Xcode 27+.');
  const [xcode, sdk, list] = await Promise.all([xcrun(['xcodebuild', '-version']), xcrun(['--sdk', 'iphonesimulator', '--show-sdk-version']), xcrun(['simctl', 'list', '-j'])]);
  const { devices, runtimes } = JSON.parse(list);
  check(Number(/^Xcode (\d+)/m.exec(xcode)?.[1]) >= 27 && parseInt(sdk, 10) >= 27,
    `Xcode 27+ and iOS Simulator SDK 27+ required. Selected ${xcode.trim().replace(/\n/g, ', ')}, SDK ${sdk.trim()}. Select a newer installation with DEVELOPER_DIR.`);
  return { xcode: xcode.trim(), sdk: sdk.trim(), devices, runtimes };
}

async function smokeFixture(recording = false) {
  const id = randomUUID().slice(0, 8);
  const heading = 'Order summary ' + id;
  const button = 'Confirm order ' + id;
  const receipt = 'Receipt ready ' + id;
  const path = '/' + id;
  const server = createServer((req, res) => {
    if (req.url !== path) { res.writeHead(404).end(); return; }
    console.log('Mobile Safari requested the smoke page.');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>VoiceOver test</title><main><h1>${heading}</h1><button onclick="this.textContent='${receipt}'">${button}</button></main></html>`);
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return { server, scenario: { url: `http://127.0.0.1:${server.address().port}${path}`, readyText: button, steps: [
    { action: 'forward', until: button, maxMoves: 40 }, { action: 'backward', expect: heading }, { action: 'forward', expect: button },
    ...(recording ? [{ action: 'activate', expect: receipt }] : []),
  ] } };
}

async function extract(result, dir, device) {
  const path = join(dir, 'attachments');
  await mkdir(path, { recursive: true });
  await xcrun(['xcresulttool', 'export', 'attachments', '--test-id', 'VoiceOverTests/testScenario()', '--path', result, '--output-path', path], 180_000);
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  const matches = manifest.filter(m => /(?:^|\/)VoiceOverTests\/testScenario(?:\(\))?$/.test(m.testIdentifier))
    .flatMap(m => m.attachments).filter(a => a.deviceId.toLowerCase() === device.udid.toLowerCase()
      && /^hoosaidthat-voiceover-transcript(?:[_.-]|$)/.test(a.suggestedHumanReadableName));
  check(matches.length === 1, 'Expected one VoiceOver test attachment for the selected iPhone; see the .xcresult bundle.');
  const file = matches[0].exportedFileName;
  check(basename(file) === file, 'Invalid attachment filename.');
  return JSON.parse(await readFile(join(path, file), 'utf8'));
}

async function runOnDevice(device, environment, input, parent, audioDevice, dedicatedMac) {
  check(device.state === 'Booted' || device.state === 'Shutdown', `Simulator is ${device.state}; wait until it is ready.`);
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, 'run-'));
  console.log('VoiceOver results: ' + output);
  const result = join(output, 'VoiceOver.xcresult');
  const derived = await mkdtemp(join(tmpdir(), 'hst-ios-build-'));
  let fixture, recording, bootedHere = false;
  try {
    if (!input) fixture = await smokeFixture(!!audioDevice);
    const scenario = input ?? fixture.scenario;
    if (device.state === 'Shutdown') {
      await xcrun(['simctl', 'boot', device.udid]);
      bootedHere = true;
    }
    await xcrun(['simctl', 'bootstatus', device.udid], 5 * 60_000);
    if (audioDevice) recording = await createRecording(output, device.udid, audioDevice, dedicatedMac);
    const args = ['xcodebuild', 'test', '-project', project, '-scheme', 'HooSaidThat', '-destination', 'platform=iOS Simulator,id=' + device.udid,
      '-derivedDataPath', derived, '-resultBundlePath', result, '-parallel-testing-enabled', 'NO', '-test-timeouts-enabled', 'YES',
      '-default-test-execution-time-allowance', '480', '-maximum-test-execution-time-allowance', '480', '-only-testing:HooSaidThatUITests/VoiceOverTests/testScenario'];
    // xcodebuild strips TEST_RUNNER_ before forwarding the value into XCTest.
    let failure;
    try {
      const { stdout, stderr } = await exec('/usr/bin/xcrun', args, { env: { ...process.env, TEST_RUNNER_HST_IOS_SCENARIO_JSON: JSON.stringify(scenario), ...(recording ? { TEST_RUNNER_HST_RECORDING_ENDPOINT: recording.endpoint } : {}) },
        maxBuffer: 32 * 1024 * 1024, timeout: 22 * 60_000 });
      await writeFile(join(output, 'xcodebuild.log'), stdout + stderr);
    } catch (error) {
      await writeFile(join(output, 'xcodebuild.log'), (error.stdout ?? '') + (error.stderr ?? ''));
      failure = new Error('XCTest did not pass; see xcodebuild.log and VoiceOver.xcresult in ' + output);
    }
    let transcript;
    try {
      transcript = await extract(result, output, device);
      await writeFile(join(output, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
    } catch (err) {
      if (!failure) throw err;
      console.error('Could not export the XCTest transcript: ' + err.message);
    }
    let summary;
    try { summary = JSON.parse(await xcrun(['xcresulttool', 'get', 'test-results', 'summary', '--path', result])); }
    catch (err) { throw failure ?? err; }
    if (failure) {
      const detail = summary.testFailures?.[0]?.failureText;
      throw new Error(failure.message + (detail ? '\n' + detail : ''));
    }
    validateTranscript(scenario, transcript);
    check(summary.result === 'Passed' && summary.totalTestCount === 1 && summary.passedTests === 1 && summary.skippedTests === 0, 'Expected exactly one passing native XCTest.');
    const report = {
      screenReader: 'VoiceOver', ...(scenario.url ? { browser: 'Mobile Safari' } : { bundleId: scenario.bundleId }), captureBoundary: 'XCUIVoiceOverService.Output.utterance',
      xcode: environment.xcode, sdk: environment.sdk, device, scenario, transcript,
      ...(recording ? { recording: await recording.finalize() } : {}),
    };
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`iPhone VoiceOver passed: ${transcript.events.length} native observations (${device.name}, iOS ${device.runtime}).`);
    return { outputDirectory: output, report };
  } finally {
    await recording?.close();
    fixture?.server.close();
    try { if (bootedHere) await xcrun(['simctl', 'shutdown', device.udid]); }
    finally { await rm(derived, { recursive: true, force: true }); }
  }
}

async function run(device, environment, input, parent, audioDevice, dedicatedMac = false) {
  const lock = join(tmpdir(), 'hoosaidthat-voiceover-' + device.udid + '.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (err) {
    if (err.code === 'EEXIST') throw new Error('This simulator is in use. After an interrupted run, confirm no test is running before removing ' + lock);
    throw err;
  }
  try { return await runOnDevice(device, environment, input, parent, audioDevice, dedicatedMac); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function runIPhoneVoiceOver(scenario, { udid, resultsDirectory } = {}) {
  const input = validateScenario(scenario);
  const env = await inventory();
  return run(selectDevice(env.devices, env.runtimes, udid), env, input, resolve(resultsDirectory ?? 'test-results/ios-voiceover'));
}

export async function recordIPhoneVoiceOver(scenario, { udid, resultsDirectory, audioDevice, dedicatedMacOutput = false } = {}) {
  const input = validateScenario(scenario);
  const env = await inventory();
  const device = selectDevice(env.devices, env.runtimes, udid);
  return run(device, env, input, resolve(resultsDirectory ?? 'test-results/ios-voiceover'), await recordingTools(audioDevice, dedicatedMacOutput), dedicatedMacOutput);
}

async function main(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const [command, ...rest] = args;
  check(['doctor', 'run', 'record'].includes(command), help);
  const options = {};
  for (let i = 0; i < rest.length;) {
    if (command === 'record' && rest[i] === '--dedicated-mac-output') {
      check(!options['--dedicated-mac-output'], help);
      options['--dedicated-mac-output'] = true; i++; continue;
    }
    const key = rest[i], value = rest[i + 1];
    check((command === 'record' ? ['--scenario', '--udid', '--results', '--audio-device'] : command === 'run' ? ['--scenario', '--udid', '--results'] : ['--udid']).includes(key) && value && !value.startsWith('--') && !(key in options), help);
    options[key] = value; i += 2;
  }
  const input = options['--scenario'] ? validateScenario(JSON.parse(await readFile(options['--scenario'], 'utf8'))) : undefined;
  const env = await inventory();
  if (command === 'doctor' && !options['--udid']) {
    const devices = eligible(env.devices, env.runtimes);
    if (!devices.length) selectDevice(env.devices, env.runtimes);
    console.log(env.xcode + '\n' + devices.map(d => `${d.udid}  ${d.name} (iOS ${d.runtime}, ${d.state})`).join('\n'));
    return;
  }
  const device = selectDevice(env.devices, env.runtimes, options['--udid']);
  if (command === 'doctor') { console.log(env.xcode + '\n' + JSON.stringify(device)); return; }
  const audioDevice = command === 'record' ? await recordingTools(options['--audio-device'], options['--dedicated-mac-output']) : undefined;
  await run(device, env, input, resolve(options['--results'] ?? 'test-results/ios-voiceover'), audioDevice, options['--dedicated-mac-output']);
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
