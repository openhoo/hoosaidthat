import type { Page } from '@playwright/test';

const OVERLAY_HOST_ID = '__hoosaidthat_screenreader_overlay__';

export async function installOverlay(page: Page): Promise<void> {
  await page.addInitScript(installOverlayInPage);
  await ensureOverlay(page);
}

export async function ensureOverlay(page: Page): Promise<void> {
  await page.evaluate(installOverlayInPage);
}

export async function updateOverlay(
  page: Page,
  action: string,
  speech: string,
): Promise<void> {
  await ensureOverlay(page);
  await page.evaluate(
    ({ hostId, nextAction, nextSpeech }) => {
      const host = document.getElementById(hostId);
      if (!(host instanceof HTMLElement) || !host.shadowRoot) {
        return;
      }
      const actionNode = host.shadowRoot.querySelector('[data-hst-action]');
      const speechNode = host.shadowRoot.querySelector('[data-hst-speech]');
      if (actionNode) actionNode.textContent = nextAction;
      if (speechNode) speechNode.textContent = nextSpeech;
    },
    { hostId: OVERLAY_HOST_ID, nextAction: action, nextSpeech: speech },
  );
}

export async function removeOverlay(page: Page): Promise<void> {
  await page.evaluate((hostId) => document.getElementById(hostId)?.remove(), OVERLAY_HOST_ID);
}

function installOverlayInPage(): void {
  const hostId = '__hoosaidthat_screenreader_overlay__';
  const ensure = (): void => {
    if (document.getElementById(hostId) || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = hostId;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    host.inert = true;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 20px 20px auto auto;
        width: min(720px, calc(100vw - 40px));
        z-index: 2147483647;
        pointer-events: none;
        color-scheme: dark;
      }
      .panel {
        box-sizing: border-box;
        max-height: 34vh;
        overflow: hidden;
        border: 2px solid #8be9fd;
        border-radius: 10px;
        background: rgba(9, 12, 20, 0.94);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
        color: #f8f8f2;
        font: 600 18px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .action {
        padding: 8px 12px;
        border-bottom: 1px solid rgba(139, 233, 253, 0.45);
        color: #8be9fd;
        font-size: 14px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      .speech {
        padding: 12px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    `;
    const panel = document.createElement('div');
    panel.className = 'panel';
    const action = document.createElement('div');
    action.className = 'action';
    action.dataset.hstAction = '';
    action.textContent = 'Screen reader ready';
    const speech = document.createElement('div');
    speech.className = 'speech';
    speech.dataset.hstSpeech = '';
    speech.textContent = 'Waiting for screen-reader output';
    panel.append(action, speech);
    shadow.append(style, panel);
    document.documentElement.append(host);
  };
  ensure();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensure, { once: true });
  }
}
