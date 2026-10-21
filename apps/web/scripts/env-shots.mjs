// Screenshots of the Environments and Releases pages through the mocked server (VITE_MSW=1).
//   AOM_WEB_PORT=5188 VITE_MSW=1 vite   then   node apps/web/scripts/env-shots.mjs [outDir] [--only=a,b]
// Every journey is a function of (page, shot) in `journeys`; shots are taken at 390 and 1440 (light; dark where asked).
import { mkdirSync } from 'node:fs';
import { chromium } from '/path/to/guildwise/e2e/node_modules/@playwright/test/index.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5188';
const args = process.argv.slice(2);
const out =
  args.find((a) => !a.startsWith('--')) ??
  '/path/to/guildwise/.claude/worktrees/screens/environments';
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const sizes = { m: { width: 390, height: 844 }, d: { width: 1440, height: 900 } };
mkdirSync(out, { recursive: true });

export async function newPage(browser, { size, scheme, scenario, extra = {} }) {
  const vp = sizes[size];
  const ctx = await browser.newContext({
    viewport: vp,
    colorScheme: scheme,
    reducedMotion: 'reduce',
    ...(size === 'm' ? { isMobile: true, hasTouch: true } : {}),
  });
  await ctx.addInitScript(
    ([s, sc, ex]) => {
      localStorage.setItem('guildwise-theme', s);
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('aom-mock-org-role', sc === 'member' ? 'member' : 'owner');
        localStorage.setItem('aom-mock-deploy', sc);
        localStorage.removeItem('aom-mock-env');
        localStorage.setItem(
          'aom-mock-run',
          sc === 'proposal' ? 'proposal' : sc === 'empty' ? 'empty' : 'ready',
        );
        for (const [k, v] of Object.entries(ex)) localStorage.setItem(k, v);
      }
    },
    [scheme, scenario, extra],
  );
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await p.goto(`${BASE}/login`);
  await p.getByLabel('Email').fill('admin@example.com');
  await p.getByLabel('Password').fill('password123456');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  return { p, ctx };
}

export async function shot(p, name, { full = true } = {}) {
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(400);
  const vp = p.viewportSize();
  if (full) {
    const h = await p.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.querySelector('main')?.scrollHeight ?? 0),
    );
    const target = Math.max(vp.height, Math.min(h + 40, vp.width < 600 ? 3400 : 2600));
    await p.setViewportSize({ width: vp.width, height: target });
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' });
    await p.setViewportSize(vp);
  } else await p.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' });
  console.log('shot', name);
}

const { journeys } = await import('./env-journeys.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
for (const j of journeys) {
  if (only.length && !only.includes(j.id)) continue;
  for (const size of j.sizes ?? ['m', 'd']) {
    for (const scheme of j.dark && size === 'd' ? ['light', 'dark'] : ['light']) {
      const { p, ctx } = await newPage(browser, { size, scheme, scenario: j.scenario, extra: j.extra });
      try {
        await j.run({
          p,
          size,
          name: (step) => `${j.id}-${step}-${size === 'm' ? 390 : 1440}${scheme === 'dark' ? '-dark' : ''}`,
          shot: (n, o) => shot(p, n, o),
        });
      } catch (e) {
        console.error(`FAILED ${j.id} ${size} ${scheme}: ${e.message.split('\n').slice(0, 4).join(' | ')}`);
        await p.screenshot({ path: `${out}/FAILED-${j.id}-${size}-${scheme}.png` }).catch(() => undefined);
      }
      await ctx.close();
    }
  }
}
await browser.close();
