import type { BrowserContext, Locator, Page } from '@playwright/test';

/**
 * On-screen helpers for a recorded walk-through: a caption bar at the bottom, a visible mouse pointer (a headless
 * browser draws none) and slow, human-paced clicks and typing. Both overlays are installed in every page of the
 * context, and the caption survives navigations (it is kept in sessionStorage).
 */
const INIT = `
(() => {
  const KEY = '__gw_caption';
  const mount = () => {
    if (document.getElementById('gw-caption')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #gw-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:min(920px,88vw);
        display:none;align-items:center;gap:14px;padding:14px 22px;border-radius:14px;background:rgba(15,23,42,.92);color:#fff;
        font:600 22px/1.3 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none}
      #gw-caption .n{flex:none;min-width:34px;height:34px;border-radius:17px;background:#6366f1;display:flex;align-items:center;justify-content:center;font-size:18px}
      #gw-cursor{position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;z-index:2147483646;
        background:rgba(99,102,241,.35);border:2px solid #4f46e5;pointer-events:none;transition:transform .08s}
      #gw-cursor.down{transform:scale(.7);background:rgba(99,102,241,.7)}\`;
    document.documentElement.append(style);
    const cap = document.createElement('div');
    cap.id = 'gw-caption';
    cap.setAttribute('aria-hidden', 'true');
    cap.innerHTML = '<span class="n"></span><span class="t"></span>';
    document.documentElement.append(cap);
    const cur = document.createElement('div');
    cur.id = 'gw-cursor';
    document.documentElement.append(cur);
    const last = sessionStorage.getItem('__gw_mouse');
    if (last) { const [x, y] = last.split(','); cur.style.left = x + 'px'; cur.style.top = y + 'px'; }
    window.addEventListener('mousemove', (e) => {
      cur.style.left = e.clientX + 'px';
      cur.style.top = e.clientY + 'px';
      sessionStorage.setItem('__gw_mouse', e.clientX + ',' + e.clientY);
    }, true);
    window.addEventListener('mousedown', () => cur.classList.add('down'), true);
    window.addEventListener('mouseup', () => cur.classList.remove('down'), true);
    const saved = sessionStorage.getItem(KEY);
    if (saved) window.__gwCaption(JSON.parse(saved));
  };
  window.__gwCaption = (c) => {
    const el = document.getElementById('gw-caption');
    if (!el) return;
    if (!c) { el.style.display = 'none'; return; }
    el.querySelector('.n').textContent = c.step ? String(c.step) : '';
    el.querySelector('.n').style.display = c.step ? 'flex' : 'none';
    el.querySelector('.t').textContent = c.text;
    el.style.display = 'flex';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
`;

export async function installOverlays(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(INIT);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shows (or, with null, hides) the caption; `step` is the chapter number shown in the badge. */
export async function caption(page: Page, text: string | null, step?: number): Promise<void> {
  const value = text ? { text, step } : null;
  // runs in the page (the e2e project has no DOM types)
  await page.evaluate(`(() => {
    const v = ${JSON.stringify(value)};
    if (v) sessionStorage.setItem('__gw_caption', JSON.stringify(v));
    else sessionStorage.removeItem('__gw_caption');
    window.__gwCaption && window.__gwCaption(v);
  })()`);
}

/** Moves the visible pointer to the element in a smooth path, then clicks it. */
export async function click(page: Page, target: Locator, pauseMs = 500): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await sleep(250);
  await target.click();
  await sleep(pauseMs);
}

/** Types like a person (about 14 characters a second). */
export async function type(page: Page, target: Locator, text: string, pauseMs = 400): Promise<void> {
  await click(page, target, 150);
  await target.pressSequentially(text, { delay: 70 });
  await sleep(pauseMs);
}
