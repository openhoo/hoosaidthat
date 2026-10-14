import type { ScreenReaderReport } from './report.js';

/** Serialized into the portable report after TypeScript has removed the types. */
function mountReportViewer(): void {
  const report = JSON.parse(document.getElementById('report-data')!.textContent!) as ScreenReaderReport;
  const get = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const player = get<HTMLAudioElement>('player');
  const icons: Record<string, string> = {
    play: '<path d="m9 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
    left: '<path d="m14 6-6 6 6 6"/>',
    right: '<path d="m10 6 6 6-6 6"/>',
    sound: '<path d="M11 5 6 9H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    layers: '<path d="m12 3 10 6-10 6L2 9l10-6ZM3 14l9 5 9-5M3 18l9 5 9-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    expand: '<path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6"/>',
    annotation: '<path d="M20 10V4H4v13h6l4 4v-4h6v-7ZM8 8h8M8 12h5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  const svg = (name: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.play}</svg>`;
  const icon = (name: string): HTMLElement => {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = svg(name);
    return span;
  };
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => { node.innerHTML = svg(node.dataset.icon!); });
  const text = (tag: string, content: string, className = ''): HTMLElement => {
    const node = document.createElement(tag);
    node.textContent = content;
    node.className = className;
    return node;
  };
  const firstHeading = report.snapshots.findIndex(snapshot => snapshot.observation.action === 'nextHeading' && snapshot.annotations.some(annotation => annotation.bounds));
  const firstPageStep = report.snapshots.findIndex(snapshot => snapshot.observation.action !== 'returnToPage');
  function indexFromHash(): number | undefined {
    const value = new URLSearchParams(location.hash.slice(1)).get('step');
    if (value === null || value.trim() === '') return undefined;
    const step = Number(value);
    if (!Number.isSafeInteger(step)) return undefined;
    const matches = report.snapshots.map((snapshot, index) => snapshot.index === step ? index : -1).filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : undefined;
  }
  let current = indexFromHash() ?? Math.max(0, firstHeading >= 0 ? firstHeading : firstPageStep);
  let selected = -1;
  let playback = 0;
  let annotationsVisible = true;
  let zoomed = false;
  const reader = report.runtime.screenReader.name === 'hoovda' ? 'HooVDA' : report.runtime.screenReader.name === 'nvda' ? 'NVDA' : 'Orca';
  get('reader').textContent = reader;
  document.title = `HooSaidThat — ${report.title || 'Screenreader report'}`;
  const mobile = window.matchMedia('(max-width: 700px)');

  function stop(): void {
    playback += 1;
    player.pause();
    document.querySelectorAll('.playing').forEach(node => node.classList.remove('playing'));
  }

  function updatePlayback(): void {
    const playing = !player.paused;
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    document.querySelectorAll<HTMLElement>('[data-utterance]').forEach(node => {
      const index = Number(node.dataset.utterance);
      const active = index === selected;
      node.classList.toggle('playing', playing && active);
      if (node instanceof HTMLButtonElement) {
        const annotation = report.snapshots[current]?.annotations[index];
        node.querySelector<HTMLElement>('.icon')!.innerHTML = svg(playing && active ? 'pause' : 'play');
        node.style.setProperty('--progress', `${duration > 0 && active ? player.currentTime / duration * 100 : 0}%`);
        node.setAttribute('aria-label', `${playing && active ? 'Pause original audio' : annotation?.audio ? 'Play original audio' : 'Audio unavailable'}: ${annotation?.speech.text ?? ''}`);
      }
    });
  }

  async function play(index: number): Promise<void> {
    const annotation = report.snapshots[current]?.annotations[index];
    if (!annotation) return;
    if (selected === index && !player.paused) {
      playback += 1;
      player.pause();
      get('status').textContent = 'Playback paused.';
      return;
    }
    select(index);
    if (!annotation.audio) {
      get('status').textContent = 'No original audio was captured for this utterance.';
      return;
    }
    if (player.ended) player.currentTime = 0;
    const token = playback;
    try {
      await player.play();
      if (token === playback) {
        get('playback-note').textContent = '';
        get('status').textContent = 'Playing original screenreader audio.';
      }
    } catch {
      if (token === playback) {
        get('playback-note').textContent = 'Playback could not start. Click the speech label to try again.';
        get('status').textContent = get('playback-note').textContent;
      }
    }
  }

  function select(index: number): void {
    const annotation = report.snapshots[current]?.annotations[index];
    if (!annotation) return;
    if (selected !== index) {
      stop();
      selected = index;
      if (annotation.audio) {
        player.src = annotation.audio.data;
        player.load();
      } else {
        player.removeAttribute('src');
        player.load();
      }
    }
    document.querySelectorAll<HTMLElement>('[data-utterance]').forEach(node => {
      const active = Number(node.dataset.utterance) === index;
      node.classList.toggle('selected', active);
      if (node.classList.contains('highlight')) node.hidden = !active || !annotationsVisible;
    });
    get('playback-note').textContent = annotation.audio ? '' : 'No original audio was captured for this text.';
    updatePlayback();
  }

  function listSteps(): void {
    const query = get<HTMLInputElement>('search').value.toLocaleLowerCase();
    const host = get('steps');
    const focusedStep = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement.dataset.stepIndex : undefined;
    host.replaceChildren();
    const pageSteps = document.createElement('div');
    pageSteps.className = 'page-steps';
    const setup = document.createElement('details');
    setup.className = 'setup-steps';
    const summary = text('summary', 'Browser setup');
    setup.append(summary);
    const setupBody = document.createElement('div');
    setup.append(setupBody);
    let shown = 0;
    let setupCount = 0;
    report.snapshots.forEach((snapshot, index) => {
      if (!(snapshot.observation.label + ' ' + snapshot.observation.speech).toLocaleLowerCase().includes(query)) return;
      shown += 1;
      const button = document.createElement('button');
      button.className = 'step';
      button.dataset.stepIndex = String(index);
      button.setAttribute('aria-current', String(index === current));
      const number = text('span', String(snapshot.index).padStart(2, '0'), 'step-number');
      const description = document.createElement('span');
      description.className = 'step-description';
      description.append(text('span', snapshot.observation.label, 'step-title'));
      description.append(text('span', snapshot.observation.speech || 'No speech captured', 'step-speech'));
      button.append(number, description);
      button.onclick = () => {
        show(index);
        closeDrawer();
      };
      if (snapshot.observation.action === 'returnToPage') {
        setupCount += 1;
        setupBody.append(button);
        if (index === current || query) setup.open = true;
      } else pageSteps.append(button);
    });
    host.append(pageSteps);
    if (setupCount > 0) {
      summary.append(text('span', String(setupCount), 'setup-count'));
      host.append(setup);
    }
    if (shown === 0) host.append(text('p', 'No matching steps.', 'empty-search'));
    get('count').textContent = `${shown} of ${report.snapshots.length} snapshots`;
    if (focusedStep !== undefined) host.querySelectorAll<HTMLButtonElement>('[data-step-index]').forEach(button => {
      if (button.dataset.stepIndex === focusedStep) button.focus();
    });
  }

  function positionAnnotations(): void {
    const snapshot = report.snapshots[current];
    if (!snapshot?.image || snapshot.width <= 0) return;
    const stage = get('stage');
    if (stage.clientHeight <= 0 || !stage.querySelector<HTMLImageElement>('img')?.complete) return;
    const scale = stage.clientWidth / snapshot.width;
    const placed: { x: number; y: number; width: number; height: number }[] = [];
    stage.querySelectorAll<HTMLElement>('.annotation').forEach(pin => {
      const bounds = snapshot.annotations[Number(pin.dataset.utterance)]?.bounds;
      if (!bounds) return;
      const left = bounds.x * scale;
      const top = bounds.y * scale;
      const right = (bounds.x + bounds.width) * scale;
      const rightSpace = stage.clientWidth - right - 20;
      const leftSpace = left - 20;
      // Prefer the page's free side margin, so the speech label does not cover
      // the target or its neighboring text. Narrow viewports use an above label.
      if (rightSpace >= 160 || leftSpace >= 160) {
        const onRight = rightSpace >= 160;
        pin.style.maxWidth = `${Math.min(340, onRight ? rightSpace : leftSpace)}px`;
        pin.style.left = `${onRight ? right + 10 : left - pin.offsetWidth - 10}px`;
        pin.style.top = `${Math.max(8, Math.min(top + (bounds.height * scale - pin.offsetHeight) / 2, stage.clientHeight - pin.offsetHeight - 8))}px`;
      } else {
        pin.style.maxWidth = '';
        const width = pin.offsetWidth;
        const height = pin.offsetHeight;
        pin.style.left = `${Math.max(8, Math.min(left, stage.clientWidth - width - 8))}px`;
        let y = top - height - 10;
        if (y < 8) y = Math.min(top + bounds.height * scale + 10, stage.clientHeight - height - 8);
        pin.style.top = `${Math.max(8, y)}px`;
      }
      // Several events can originate from the same element. Keep every speech
      // label clickable instead of allowing the last event to cover earlier ones.
      const x = Number.parseFloat(pin.style.left);
      const y = Number.parseFloat(pin.style.top);
      const width = pin.offsetWidth;
      const height = pin.offsetHeight;
      if (width === 0 || height === 0) return;
      const candidates = [y, ...placed.flatMap(rect => [rect.y + rect.height + 8, rect.y - height - 8])].sort((first, second) => Math.abs(first - y) - Math.abs(second - y));
      const available = candidates.find(top => top >= 8 && top + height <= stage.clientHeight - 8 && placed.every(rect =>
        x + width + 4 <= rect.x || rect.x + rect.width + 4 <= x || top + height + 4 <= rect.y || rect.y + rect.height + 4 <= top));
      if (available === undefined) {
        pin.classList.replace('annotation', 'speech-extra');
        pin.style.left = pin.style.top = pin.style.maxWidth = '';
        pin.title = 'Speech label listed below because the snapshot has no free space.';
        get('unlocated').append(pin);
      } else {
        pin.style.top = `${available}px`;
        placed.push({ x, y: available, width, height });
      }
    });
  }

  function show(index: number): void {
    stop();
    selected = -1;
    current = Math.max(0, Math.min(index, report.snapshots.length - 1));
    const snapshot = report.snapshots[current];
    listSteps();
    get<HTMLButtonElement>('prev').disabled = current <= 0;
    get<HTMLButtonElement>('next').disabled = current >= report.snapshots.length - 1;
    get('stage').replaceChildren();
    get('unlocated').replaceChildren();
    get('playback-note').textContent = '';
    get('status').textContent = '';
    if (!snapshot) {
      get('step-position').textContent = '';
      get('capture-state').textContent = '';
      player.removeAttribute('src');
      player.load();
      get<HTMLButtonElement>('prev').disabled = true;
      get<HTMLButtonElement>('next').disabled = true;
      get('heading').textContent = 'No snapshots recorded';
      get('stage').append(text('p', 'Page snapshots will appear here when a run contains recorded observations.', 'missing-snapshot'));
      return;
    }
    get('heading').textContent = snapshot.observation.label;
    get('step-position').textContent = `${String(current + 1).padStart(2, '0')} / ${String(report.snapshots.length).padStart(2, '0')}`;
    get('capture-state').textContent = snapshot.observation.timedOut ? 'Capture timed out' : '';
    get('capture-state').classList.toggle('timed-out', snapshot.observation.timedOut);
    get('stage').style.width = zoomed && snapshot.image ? `${snapshot.width}px` : '';
    if (snapshot.image) {
      const image = document.createElement('img');
      image.src = snapshot.image;
      image.alt = `Website state after ${snapshot.observation.label}`;
      image.width = snapshot.width;
      image.height = snapshot.height;
      image.onload = positionAnnotations;
      get('stage').append(image);
    } else get('stage').append(text('p', snapshot.error || 'No website image was captured for this step.', 'missing-snapshot'));

    snapshot.annotations.forEach((annotation, utteranceIndex) => {
      const label = `${annotation.audio ? 'Play original audio' : 'Audio unavailable'}: ${annotation.speech.text}`;
      if (annotation.bounds && snapshot.image) {
        const bounds = annotation.bounds;
        const highlight = document.createElement('div');
        highlight.className = 'highlight';
        highlight.dataset.utterance = String(utteranceIndex);
        highlight.style.left = `${100 * bounds.x / snapshot.width}%`;
        highlight.style.top = `${100 * bounds.y / snapshot.height}%`;
        highlight.style.width = `${100 * bounds.width / snapshot.width}%`;
        highlight.style.height = `${100 * bounds.height / snapshot.height}%`;
        const pin = document.createElement('button');
        pin.className = 'annotation';
        pin.dataset.utterance = String(utteranceIndex);
        pin.append(icon('play'), text('span', annotation.speech.text, 'annotation-text'));
        pin.title = annotation.speech.text;
        pin.setAttribute('aria-label', label);
        pin.hidden = !annotationsVisible;
        pin.onclick = () => { void play(utteranceIndex); };
        get('stage').append(highlight, pin);
      } else {
        // Preserve playable speech with no visible source without adding a panel.
        const button = document.createElement('button');
        button.className = 'speech-extra';
        button.dataset.utterance = String(utteranceIndex);
        button.append(icon('play'), text('span', annotation.speech.text || '(empty speech event)'));
        button.setAttribute('aria-label', label);
        button.title = 'No element location captured';
        button.onclick = () => { void play(utteranceIndex); };
        get('unlocated').append(button);
      }
    });
    if (snapshot.annotations.length === 0) {
      get('playback-note').textContent = snapshot.observation.timedOut ? 'No speech was captured before the timeout.' : 'No speech at this moment.';
      player.removeAttribute('src');
      player.load();
    } else select(0);
    try { history.replaceState(null, '', `#step=${snapshot.index}`); } catch { /* Some offline viewers disable history. */ }
    requestAnimationFrame(positionAnnotations);
  }

  function updateDrawer(): void {
    const open = mobile.matches && document.body.classList.contains('drawer-open');
    get('sidebar').inert = mobile.matches && !open;
    document.querySelector<HTMLElement>('main')!.inert = open;
    document.querySelector<HTMLElement>('.appbar')!.inert = open;
    if (open) {
      get('sidebar').setAttribute('role', 'dialog');
      get('sidebar').setAttribute('aria-modal', 'true');
      get('sidebar').setAttribute('aria-label', 'Snapshot navigation');
    } else {
      get('sidebar').removeAttribute('role');
      get('sidebar').removeAttribute('aria-modal');
      get('sidebar').removeAttribute('aria-label');
    }
  }
  function closeDrawer(): void {
    const wasOpen = document.body.classList.contains('drawer-open');
    document.body.classList.remove('drawer-open');
    get('toggle-steps').setAttribute('aria-expanded', 'false');
    updateDrawer();
    if (wasOpen && mobile.matches) get('toggle-steps').focus();
  }
  player.addEventListener('timeupdate', updatePlayback);
  player.addEventListener('loadedmetadata', updatePlayback);
  player.addEventListener('play', updatePlayback);
  player.addEventListener('pause', updatePlayback);
  player.addEventListener('error', () => {
    if (!report.snapshots[current]?.annotations[selected]?.audio) return;
    get('playback-note').textContent = 'The original audio clip could not be decoded. Select another speech label or try again.';
    get('status').textContent = get('playback-note').textContent;
    updatePlayback();
  });
  player.addEventListener('ended', () => {
    updatePlayback();
    get('status').textContent = 'Playback finished.';
  });
  get('prev').onclick = () => show(current - 1);
  get('next').onclick = () => show(current + 1);
  get<HTMLInputElement>('search').oninput = listSteps;
  get('toggle-steps').onclick = () => {
    const open = document.body.classList.toggle('drawer-open');
    get('toggle-steps').setAttribute('aria-expanded', String(open));
    updateDrawer();
    if (open) get('search').focus();
  };
  get('close-steps').onclick = closeDrawer;
  get('scrim').onclick = closeDrawer;
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDrawer();
    if (event.key !== 'Tab' || !mobile.matches || !document.body.classList.contains('drawer-open')) return;
    const sidebar = get('sidebar');
    const controls = [...sidebar.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary')].filter(node => node.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
      event.preventDefault();
      first?.focus();
    }
  });
  mobile.addEventListener('change', () => {
    if (!mobile.matches) closeDrawer();
    updateDrawer();
  });
  get('toggle-annotations').onclick = () => {
    annotationsVisible = !annotationsVisible;
    get('toggle-annotations').setAttribute('aria-pressed', String(annotationsVisible));
    get('stage').querySelectorAll<HTMLElement>('.annotation, .highlight').forEach(node => {
      node.hidden = !annotationsVisible || (node.classList.contains('highlight') && Number(node.dataset.utterance) !== selected);
    });
    positionAnnotations();
  };
  get('zoom').onclick = () => {
    zoomed = !zoomed;
    const snapshot = report.snapshots[current];
    get('stage').style.width = zoomed && snapshot?.image ? `${snapshot.width}px` : '';
    get('zoom-label').textContent = zoomed ? '100%' : 'Fit';
    get('zoom').setAttribute('aria-pressed', String(zoomed));
    positionAnnotations();
  };
  window.addEventListener('hashchange', () => {
    const index = indexFromHash();
    if (index !== undefined && index !== current) show(index);
  });
  new ResizeObserver(positionAnnotations).observe(get('stage'));
  updateDrawer();
  show(current);
}

export function reportWebsite(report: ScreenReaderReport): string {
  const data = JSON.stringify(report).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light"><title>HooSaidThat — Screenreader report</title>
<style>
:root{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#41443f;background:#fafbf8;--ink:#41443f;--muted:#66715e;--line:#e9ece5;--accent:#768b71;--soft:#edf1e9}
*{box-sizing:border-box}body{margin:0}button,input{font:inherit;color:inherit}button{border:0;background:transparent;cursor:pointer;touch-action:manipulation}button:disabled{opacity:.3;cursor:default}[hidden]{display:none!important}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #687d60;outline-offset:4px}.icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none}.icon svg{display:block;width:100%;height:100%}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.appbar{height:64px;padding:0 32px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:16px}.brand{display:flex;gap:20px;align-items:center}.brand-name{font-size:16px;font-weight:590;letter-spacing:-.45px}.report-label{font-size:11px;color:var(--muted)}.reader{font-size:10px;color:var(--muted)}.shell{display:grid;grid-template-columns:214px minmax(0,1fr);min-height:calc(100dvh - 64px)}
.sidebar{padding:33px 13px 25px;border-right:1px solid var(--line);background:#fafbf8;min-width:0}.sidebar-heading{display:flex;justify-content:space-between;align-items:center;padding:0 12px}.sidebar-heading h2{font-size:11px;font-weight:500;color:var(--muted);margin:0}.search-field{display:flex;align-items:center;gap:8px;margin:22px 12px 28px;color:var(--muted)}.search-field .icon{width:13px;height:13px}.search-field input{width:100%;min-width:0;padding:4px 0;border:0;border-bottom:1px solid transparent;background:transparent;outline:none;font-size:11px}.search-field input::placeholder{color:var(--muted)}.search-field:focus-within input{border-bottom-color:#b4c0ab}.page-steps{display:grid;grid-template-columns:minmax(0,1fr);gap:7px}.step{display:flex;gap:12px;align-items:flex-start;padding:11px 12px;width:100%;min-width:0;overflow:hidden;text-align:left;border-radius:3px}.step:hover{background:#f1f3ed}.step[aria-current=true]{background:#eaf0e4}.step-number{width:17px;flex:none;font-size:10px;color:var(--muted);margin-top:2px;font-variant-numeric:tabular-nums}.step[aria-current=true] .step-number{color:#5b6c50}.step-description{min-width:0;flex:1}.step-title{display:block;font-size:11px;font-weight:430;line-height:1.5}.step-speech{display:none;font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:5px}.step[aria-current=true] .step-speech{display:block}.setup-steps{margin:28px 12px 0}.setup-steps summary{font-size:10px;cursor:pointer;color:var(--muted)}.setup-count{margin-left:8px;color:var(--muted)}.setup-steps .step{padding-left:0;font-size:10px}.sidebar-footer{margin:34px 12px 0;color:var(--muted);font-size:9px}.sidebar-footer p{margin:0}.empty-search{font-size:11px;color:var(--muted);padding:12px}
.content{min-width:0}.review-header{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:38px 48px 26px}.step-position{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;letter-spacing:.3px}.review-header h1{font-size:21px;font-weight:440;letter-spacing:-.5px;margin:8px 0 0;line-height:1.4}.header-navigation{display:flex;gap:13px;flex:none}.icon-button{display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:var(--muted);border-radius:3px}.icon-button:hover{color:#5f7057;background:#edf1e8}.review{min-height:calc(100dvh - 180px)}.canvas{padding:0 48px 56px;min-width:0}.canvas-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:19px;min-height:25px}.capture-state{font-size:10px;color:#7a6749}.canvas-tools{display:flex;gap:18px}.tool-button{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--muted);padding:3px 0}.tool-button .icon{width:12px;height:12px}.tool-button:hover{color:#5d7054}.tool-button[aria-pressed=true]{color:#5e724f}.snapshot-window{background:#fff;border:1px solid #e6eae0;border-radius:4px;overflow:hidden}.viewport{max-width:100%;overflow:auto}.stage{position:relative;width:100%;min-width:0;background:#fff}.stage img{display:block;width:100%;height:auto}.highlight{position:absolute;border:1px solid #99ab8b;border-radius:1px;pointer-events:none;background:#83987605}.annotation{position:absolute;display:flex;align-items:center;gap:8px;min-height:33px;max-width:min(340px,calc(100% - 16px));padding:7px 10px;border:1px solid #dbe3d1;border-radius:3px;background:#fffffefa;font-size:11px;line-height:1.4;text-align:left;color:#67725c;z-index:2;overflow:hidden}.annotation .icon,.speech-extra .icon{width:15px;height:15px;color:#6d805d}.annotation-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.annotation:hover{border-color:#aabb98;color:#47543c}.annotation.playing{background:#f7f9f2;border-color:#a6b791}.annotation.playing:after,.speech-extra.playing:after{content:"";position:absolute;bottom:0;left:0;height:1px;width:var(--progress,0%);background:#91a77a}.unlocated{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.unlocated:empty{display:none}.speech-extra{display:inline-flex;align-items:center;gap:8px;position:relative;padding:7px 10px;border:1px solid #e4e9dd;border-radius:3px;font-size:11px;color:#5e6f54;text-align:left;max-width:100%;overflow-wrap:anywhere}.speech-extra:hover{border-color:#b3c0a4}.playback-note{font-size:10px;color:var(--muted);margin-top:15px}.playback-note:empty{display:none}.missing-snapshot{margin:0;padding:90px 30px;text-align:center;font-size:12px;color:var(--muted)}.mobile-steps,.drawer-close,.scrim{display:none}
@media(min-width:1700px){.review-header{padding-left:72px;padding-right:72px}.canvas{padding-left:72px;padding-right:72px}}
@media(max-width:1000px){.shell{grid-template-columns:188px minmax(0,1fr)}.review-header{padding:32px 30px 24px}.canvas{padding:0 30px 42px}.brand-name{font-size:15px}}
@media(max-width:700px){.appbar{height:55px;padding:0 20px}.brand-name{font-size:15px}.report-label{display:none}.reader{font-size:9px}.shell{display:block;min-height:calc(100dvh - 55px)}.sidebar{position:fixed;z-index:12;top:55px;bottom:0;left:0;width:250px;overflow:auto;transform:translateX(-100%);background:#fafbf8;transition:transform .18s ease}.drawer-open .sidebar{transform:translateX(0)}.drawer-open .scrim{display:block;position:fixed;z-index:11;inset:55px 0 0;background:#333b2b1c}.drawer-close{display:flex;width:25px;height:25px}.mobile-steps{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted);padding:0;margin-bottom:18px}.mobile-steps .icon{width:12px;height:12px}.review-header{padding:25px 20px 23px;gap:12px}.review-header h1{font-size:19px;margin-top:7px}.step-position{font-size:9px}.header-navigation{gap:8px}.icon-button{width:26px;height:26px}.canvas{padding:0 18px 36px}.canvas-toolbar{margin-bottom:13px}.canvas-tools{gap:16px}.tool-button{font-size:9px}.annotation{min-height:28px;font-size:10px;padding:5px 8px;gap:5px;max-width:min(260px,calc(100% - 16px))}.annotation .icon{width:13px;height:13px}.speech-extra{font-size:10px}.highlight{border-color:#a6b898}.sidebar-heading h2{font-size:11px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<header class="appbar"><div class="brand"><span class="brand-name">hoo said that.</span><span class="report-label">Screenreader report</span></div><span id="reader" class="reader"></span></header>
<button id="scrim" class="scrim" aria-label="Close snapshot navigation"></button>
<div class="shell"><aside id="sidebar" class="sidebar"><div class="sidebar-heading"><h2>Moments</h2><button id="close-steps" class="icon-button drawer-close" aria-label="Close navigation"><span class="icon" data-icon="close"></span></button></div><label class="search-field"><span class="icon" data-icon="search"></span><span class="sr-only">Search captured speech</span><input id="search" type="search" placeholder="Search…"></label><nav id="steps" aria-label="Recorded snapshots"></nav><footer class="sidebar-footer"><p id="count"></p></footer></aside>
<main class="content"><header class="review-header"><div><button id="toggle-steps" class="mobile-steps" aria-expanded="false" aria-controls="sidebar"><span class="icon" data-icon="layers"></span>Moments</button><div id="step-position" class="step-position"></div><h1 id="heading"></h1></div><div class="header-navigation"><button id="prev" class="icon-button" aria-label="Previous snapshot"><span class="icon" data-icon="left"></span></button><button id="next" class="icon-button" aria-label="Next snapshot"><span class="icon" data-icon="right"></span></button></div></header>
<div class="review"><section class="canvas" aria-label="Captured website"><div class="canvas-toolbar"><span id="capture-state" class="capture-state"></span><div class="canvas-tools"><button id="toggle-annotations" class="tool-button" aria-pressed="true"><span class="icon" data-icon="annotation"></span>Labels</button><button id="zoom" class="tool-button" aria-label="Toggle actual size" aria-pressed="false"><span class="icon" data-icon="expand"></span><span id="zoom-label">Fit</span></button></div></div><div class="snapshot-window"><div class="viewport"><div id="stage" class="stage"></div></div></div><div id="unlocated" class="unlocated" aria-label="Speech listed below the snapshot"></div><p id="playback-note" class="playback-note"></p></section></div>
<audio id="player" preload="metadata" hidden></audio><p id="status" class="sr-only" role="status" aria-live="polite"></p></main></div>
<script id="report-data" type="application/json">${data}</script><script>(${mountReportViewer.toString()})();</script></body></html>`;
}
