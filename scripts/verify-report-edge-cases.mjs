import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { captureReportSnapshot, renderScreenReaderReport } from '../dist/report.js';

// Synthetic edge fixtures complement the runtime-produced report smoke test.
// Run after npm run build; this script needs the matching Playwright Chromium.
const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'hoosaidthat-report-edges-'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const speech = { kind: 'speech', sequence: 1, monotonicNs: 1, text: '</script><script>window.pwned=true</script>', provenance: 'screenReaderOutput' };
  const observation = (label, events = [speech]) => ({ action: 'nextHeading', label, speech: events.map(event => event.text).join('\n'), braille: '', speechEvents: events, brailleEvents: [], events, timedOut: false });
  const runtime = { protocolVersion: 2, status: 'ready', screenReader: { name: 'hoovda', version: 'edge-fixture', capture: 'hoovda-structured-presentation' }, platform: 'linux' };
  await page.setContent(`<body style="margin:0;background:white"><input style="position:absolute;left:10px;top:10px;width:200px;height:40px;background:yellow" type="text" autocomplete="section-login current-password" value="PRIVATE-SENTINEL"><iframe style="position:absolute;left:10px;top:70px;width:220px;height:60px;border:0" srcdoc='<input style="width:180px;height:30px;background:yellow" autocomplete="section-profile new-password" value="PRIVATE-FRAME-SENTINEL">'></iframe><div id="__hoosaidthat_screenreader_overlay__" style="position:absolute;left:10px;top:160px;width:200px;height:40px;background:red">Evidence overlay</div></body>`);
  const password = await page.locator('input').boundingBox();
  const framePassword = await page.frameLocator('iframe').locator('input').boundingBox();
  assert.ok(password && framePassword);
  const captured = await captureReportSnapshot(page, observation('Protected capture'), 9, undefined);
  const pixels = await page.evaluate(async ({ image, boxes }) => {
    const img = new Image();
    img.src = image;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);
    return boxes.map(box => [...context.getImageData(Math.floor(box.x + box.width / 2), Math.floor(box.y + box.height / 2), 1, 1).data]);
  }, { image: captured.image, boxes: [password, framePassword, { x: 10, y: 160, width: 200, height: 40 }] });
  assert.deepEqual(pixels, [[255, 0, 255, 255], [255, 0, 255, 255], [255, 255, 255, 255]], 'Section-prefixed password fields in all frames are masked and the evidence overlay is hidden');

  const sampleRate = 8000;
  const sampleCount = 16000;
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) wav.writeInt16LE(Math.round(Math.sin(index / sampleRate * 440 * 2 * Math.PI) * 2000), 44 + index * 2);
  const audio = { data: `data:audio/wav;base64,${wav.toString('base64')}`, startSample: 0, sampleCount, sampleRate };
  const bounds = { x: 50, y: 210, width: 150, height: 40 };
  const snapshots = [
    { ...captured, observation: observation('Moment 9'), annotations: [{ speech, bounds, audio }, { speech: { ...speech, text: 'Second announcement at the same element' }, bounds }, { speech: { ...speech, text: 'Speech without an element' } }] },
    { index: 11, width: 0, height: 0, annotations: [], observation: observation('Missing snapshot', []), error: 'Page already closed' },
    { ...captured, index: 25, observation: observation('Undecodable audio'), annotations: [{ speech: { ...speech, text: 'Invalid audio fixture' }, bounds, audio: { ...audio, data: 'data:audio/wav;base64,YQ==' } }] },
    { ...captured, index: 28, observation: observation('Crowded source'), annotations: Array.from({ length: 60 }, (_, index) => ({ speech: { ...speech, text: `Crowded announcement ${index + 1}` }, bounds })) },
  ];
  const title = 'Report & <untrusted title>';
  const reportPath = join(output, 'edge-report.html');
  const emptyPath = join(output, 'empty-report.html');
  await writeFile(reportPath, renderScreenReaderReport({ title, runtime, snapshots }));
  await writeFile(emptyPath, renderScreenReaderReport({ title: 'Empty report', runtime, snapshots: [] }));
  const url = pathToFileURL(reportPath).href;
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${url}#step=9.5`);
  assert.equal(await page.locator('#heading').textContent(), 'Moment 9', 'Fractional hashes fall back to a recorded snapshot');
  assert.equal(await page.locator('#step-position').textContent(), '01 / 04', 'Snapshot progress uses its position, independent of its source ID');
  assert.equal(await page.title(), `HooSaidThat — ${title}`, 'Test identity is present in the browser title');
  assert.equal(await page.evaluate(() => window.pwned), undefined, 'Captured script-like speech remains text');
  assert.equal(await page.locator('script').count(), 2);
  assert.ok((await page.locator('#stage').textContent()).includes(speech.text));
  await page.locator('#steps button[data-step-index="1"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.stepIndex), '1', 'Keyboard snapshot selection preserves focus');
  assert.equal(await page.locator('#heading').textContent(), 'Missing snapshot');
  assert.equal(await page.locator('#player').getAttribute('src'), null);
  await page.reload();
  assert.equal(await page.locator('#heading').textContent(), 'Missing snapshot', 'Nonconsecutive snapshot IDs survive reload');
  assert.equal(await page.locator('#step-position').textContent(), '02 / 04');
  await page.evaluate(() => { location.hash = '#step=9'; });
  await page.waitForFunction(() => document.getElementById('heading').textContent === 'Moment 9');
  const first = page.locator('.annotation[data-utterance="0"]');
  await first.click();
  await page.waitForFunction(() => !document.getElementById('player').paused && document.getElementById('player').currentTime > 0);
  assert.equal(await page.locator('#player').evaluate(player => player.duration), sampleCount / sampleRate);
  await first.click();
  assert.equal(await page.locator('#player').evaluate(player => player.paused), true);
  assert.equal(await page.locator('#status').textContent(), 'Playback paused.');
  await first.click();
  await page.waitForFunction(() => !document.getElementById('player').paused);
  await page.locator('.annotation[data-utterance="1"]').click();
  assert.equal(await page.locator('#player').evaluate(player => player.paused), true, 'Both labels on the same source are independently clickable');
  assert.match(await page.locator('#playback-note').textContent(), /No original audio/);
  await page.locator('#toggle-annotations').click();
  assert.equal(await first.isVisible(), false);
  await page.locator('#toggle-annotations').click();
  assert.equal(await first.isVisible(), true);

  const contrast = await page.locator('.reader, .report-label, .step-title, .step-number, .tool-button, .step-position').evaluateAll(nodes => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = values => values.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    return nodes.filter(node => node.getClientRects().length > 0 && getComputedStyle(node).display !== 'none').map(node => {
      let ancestor = node;
      while (ancestor.parentElement && getComputedStyle(ancestor).backgroundColor === 'rgba(0, 0, 0, 0)') ancestor = ancestor.parentElement;
      const foreground = luminance(rgb(getComputedStyle(node).color));
      const background = luminance(rgb(getComputedStyle(ancestor).backgroundColor));
      return { text: node.textContent.trim(), ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
    });
  });
  assert.deepEqual(contrast.filter(value => value.ratio < 4.5), [], 'Small navigation text has readable contrast');
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true, animations: 'disabled' });
  await page.locator('#steps button[data-step-index="2"]').click();
  await page.locator('.annotation').click();
  await page.waitForFunction(() => /could not/.test(document.getElementById('playback-note').textContent));
  assert.ok(await page.locator('#playback-note').isVisible(), 'Audio decoding errors are visible');
  await page.locator('#steps button[data-step-index="3"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#unlocated button').length > 0);
  assert.equal(await page.locator('#stage button, #unlocated button').count(), 60, 'Crowded sources retain every announcement');
  await page.locator('button[data-utterance="0"]').click();
  await page.locator('button[data-utterance="59"]').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.getElementById('sidebar').inert);
  assert.equal(await page.locator('#sidebar').evaluate(sidebar => sidebar.inert), true, 'Closed mobile navigation leaves the tab order and accessibility tree');
  await page.locator('#toggle-steps').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement)), false);
  await page.locator('#toggle-steps').click();
  assert.equal(await page.locator('#sidebar').getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('main').evaluate(main => main.inert), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
  await page.locator('#steps button').last().focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'close-steps', 'Tab wraps within mobile navigation');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.stepIndex), '3');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle-steps');
  assert.equal(await page.locator('#sidebar').evaluate(sidebar => sidebar.inert), true);
  assert.equal(await page.locator('main').evaluate(main => main.inert), false);
  await page.locator('#toggle-steps').click();
  await page.locator('#steps button[data-step-index="0"]').click();
  await page.locator('#zoom').click();
  assert.equal(await page.locator('#stage').evaluate(stage => stage.clientWidth), 800);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Actual-size images scroll inside the mobile viewport');
  await page.locator('#zoom').click();
  await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true, animations: 'disabled' });
  await page.locator('#toggle-steps').click();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForFunction(() => !document.querySelector('main').inert && document.getElementById('toggle-steps').getAttribute('aria-expanded') === 'false');
  assert.equal(await page.locator('#sidebar').evaluate(sidebar => sidebar.inert), false);
  assert.equal(await page.locator('main').evaluate(main => main.inert), false);
  assert.equal(await page.locator('#toggle-steps').getAttribute('aria-expanded'), 'false');
  await page.goto(pathToFileURL(emptyPath).href);
  assert.equal(await page.locator('#heading').textContent(), 'No snapshots recorded');
  assert.equal(await page.locator('#prev').isDisabled(), true);
  assert.equal(await page.locator('#next').isDisabled(), true);
  assert.deepEqual(errors, [], 'No viewer script errors');
  assert.deepEqual(requests, [], 'All edge reports remain offline');
  console.log(JSON.stringify({ protectedCapture: 'passed', untrustedText: 'passed', deepLinks: 'passed', keyboardAndMobile: 'passed', overlappingSpeech: 'passed', audioErrorAndEmptyStates: 'passed', minimumTextContrast: Math.min(...contrast.map(value => value.ratio)), networkRequests: requests.length, output }, null, 2));
} finally {
  await browser.close();
}
