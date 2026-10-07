// Screenshots of the first-login tour, the Help centre, "What's on this page" and a ? hint.
//   node apps/web/scripts/ui-tour-shots.mjs [outDir] [--sizes=d,m] [--themes=light,dark]
// Same setup as ui-shots.mjs (a populated demo world behind the Vite dev server). The tour is replayed from Help, so the
// demo user's saved tour state does not matter (the script leaves it completed).
import { mkdirSync } from 'node:fs';
import { chromium } from '/path/to/guildwise/e2e/node_modules/@playwright/test/index.mjs';
import { base, connect } from './ui-routes.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const out = args.find((a) => !a.startsWith('--')) ?? 'docs/design/ui/after';
const sizesWanted = flag('sizes', 'd,m').split(',');
const themes = flag('themes', 'light,dark').split(',');
mkdirSync(out, { recursive: true });

const { storageState, routes } = await connect();
const sizes = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844 } };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

const settle = async (p) => {
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(450);
};

// the tour steps worth looking at, by title (each is shot on desktop and on a phone)
const STEPS = {
  d: [
    'Welcome to Guildwise HQ',
    'Board',
    'Desk',
    'Projects and phases',
    'Workstations',
    'Costs',
    'Search and jump anywhere',
    'What is on this page?',
    'Help centre',
    'You are set',
  ],
  m: [
    'Welcome to Guildwise HQ',
    'Board',
    'Workstations',
    'Settings',
    'Search and jump anywhere',
    'You are set',
  ],
};
const slug = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

for (const sk of sizesWanted)
  for (const scheme of themes) {
    const mobile = sk === 'm';
    const ctx = await browser.newContext({
      viewport: sizes[sk],
      colorScheme: scheme,
      reducedMotion: 'reduce',
      storageState,
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    await ctx.addInitScript((s) => localStorage.setItem('guildwise-theme', s), scheme);
    const p = await ctx.newPage();

    // Help centre: home, search, article, glossary
    await p.goto(`${base}/help`);
    await settle(p);
    await p.screenshot({ path: `${out}/help-home-${sk}-${scheme}.png`, fullPage: !mobile ? false : true });
    await p.getByTestId('help-search').fill('allow-list');
    await settle(p);
    await p.screenshot({ path: `${out}/help-search-${sk}-${scheme}.png` });
    await p.goto(`${base}/help/agents#allow-lists`);
    await settle(p);
    await p.screenshot({ path: `${out}/help-article-${sk}-${scheme}.png` });
    await p.goto(`${base}/help/glossary`);
    await settle(p);
    await p.screenshot({ path: `${out}/help-glossary-${sk}-${scheme}.png` });

    // What's on this page, and a ? hint
    await p.goto(base + routes.desk);
    await settle(p);
    await p.getByTestId('page-help-button').click();
    await p.getByTestId('page-help').waitFor();
    await settle(p);
    await p.screenshot({ path: `${out}/page-help-${sk}-${scheme}.png` });
    await p.keyboard.press('Escape');
    await p.goto(`${base}/settings/org`);
    await settle(p);
    const hint = p.getByRole('button', { name: 'About requiring two-factor login' });
    if (await hint.count()) {
      await hint.click();
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${out}/help-hint-${sk}-${scheme}.png` });
      await p.keyboard.press('Escape');
    }

    // the tour, replayed from Help; walk it and shoot the steps listed above
    await p.goto(`${base}/help`);
    await settle(p);
    await p.getByTestId('help-replay-tour').click();
    await p.getByTestId('tour').waitFor();
    const want = new Set(STEPS[sk]);
    for (let i = 0; i < 40; i++) {
      await settle(p);
      const title = (await p.getByTestId('tour-title').textContent()) ?? '';
      if (want.has(title))
        await p.screenshot({
          path: `${out}/tour-${String(i + 1).padStart(2, '0')}-${slug(title)}-${sk}-${scheme}.png`,
        });
      if (title === 'You are set') break;
      await p.getByTestId('tour-next').click();
    }
    await p
      .getByTestId('tour-skip')
      .click()
      .catch(() => undefined);
    await ctx.close();
  }
await browser.close();
