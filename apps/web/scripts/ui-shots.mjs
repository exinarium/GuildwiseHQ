// Screenshot harness for the Guildwise redesign.
//   node apps/web/scripts/ui-shots.mjs [outDir] [--only=board,desk] [--sizes=d,m] [--themes=light,dark]
// Needs a server with a populated demo world (see e2e/tests/guide-screenshots.spec.ts: AOM_E2E_GUIDE=1 AOM_GUIDE_KEEP=1
// AOM_E2E_DB=aom_e2e_b AOM_E2E_PORT=4611 AOM_E2E_DIR=/tmp/aom-e2e-b playwright test --project=guide --grep seed:)
// serving apps/web/dist. Env: BASE (default http://localhost:4611), EMAIL, PASSWORD.
import { mkdirSync } from 'node:fs';
import {
  chromium,
  request,
} from '/path/to/guildwise/e2e/node_modules/@playwright/test/index.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const out = args.find((a) => !a.startsWith('--')) ?? 'docs/design/ui/after';
const only = flag('only', '')?.split(',').filter(Boolean);
const sizesWanted = flag('sizes', 'd,m').split(',');
const themes = flag('themes', 'light,dark').split(',');
const base = process.env.BASE ?? 'http://127.0.0.1:5199';
const email = process.env.EMAIL ?? 'pieter@demo.local';
const password = process.env.PASSWORD ?? 'pieter-demo-pass-2026';
mkdirSync(out, { recursive: true });

const api = await request.newContext({
  baseURL: base,
  extraHTTPHeaders: { Origin: process.env.ORIGIN ?? 'http://localhost:4611' },
});
const login = await api.post('/api/auth/login', { data: { email, password } });
if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
const storageState = await api.storageState();
const j = async (p) => (await api.get(`/api${p}`)).json();

const { projects } = await j('/projects');
const web = projects.find((p) => p.key === 'WEB') ?? projects.find((p) => p.workflowKey === 'code');
const feed = projects.find((p) => p.workflowKey === 'feed');
const research = projects.find((p) => p.workflowKey === 'research');
const board = await j(`/board?projectId=${web.id}`);
const cards = board.columns.flatMap((c) => c.cards);
const pick = (col) => board.columns.find((c) => c.name === col)?.cards[0];
const detailCard = pick('Blocked') ?? pick('Review') ?? cards[0];
const intakes = (await j('/intakes')).intakes ?? [];
let phase = null;
try {
  const ph = (await j(`/projects/${web.id}/phases`)).phases ?? [];
  phase = ph[0] ?? null;
} catch {}

const routes = {
  projects: '/projects',
  board: `/p/${web.key}/board`,
  desk: '/desk',
  'card-new': `/cards/new?project=${web.key}`,
  'card-detail': `/cards/${detailCard.ref}`,
  agents: '/agents',
  workstations: '/workstations',
  ledger: '/ledger',
  vaults: '/settings/vaults',
  org: '/org',
  'org-workflows': '/org?tab=workflows',
  schedules: '/schedules',
  metrics: '/metrics',
  admin: '/admin',
  intake: '/intake',
  settings: '/settings',
  interests: '/interests',
  'project-settings': `/projects/${web.id}/settings`,
  ...(feed ? { feed: `/p/${feed.key}/feed`, 'board-feed': `/p/${feed.key}/board` } : {}),
  ...(research
    ? {
        'board-research': `/p/${research.key}/board`,
        'project-settings-research': `/projects/${research.id}/settings`,
      }
    : {}),
  ...(intakes[0] ? { 'intake-view': `/intake/${intakes[0].id}` } : {}),
  ...(phase ? { phase: `/p/${web.key}/phases/${phase.number}` } : {}),
};
const sizes = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844 } };
const tall = new Set(['board']); // viewport only for the board (it scrolls inside)

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const shot = async (p, file, full) => {
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(350);
  const vp = p.viewportSize();
  if (full) {
    // Resize the viewport to the content (capped) so the sticky 100dvh sidebar fills the shot like it does in use.
    const h = await p.evaluate(() => document.documentElement.scrollHeight);
    const max = vp.width < 600 ? 2000 : 1700; // keep the committed PNGs small and legible
    const target = Math.max(vp.height, Math.min(h, max));
    if (target !== vp.height) {
      await p.setViewportSize({ width: vp.width, height: target });
      await p.waitForTimeout(250);
    }
    await p.screenshot({ path: file, animations: 'disabled' });
    if (target !== vp.height) await p.setViewportSize(vp);
  } else await p.screenshot({ path: file, animations: 'disabled' });
};
for (const sk of sizesWanted)
  for (const scheme of themes) {
    const vp = sizes[sk];
    const mobile = sk === 'm';
    // signed-out shots first
    const anon = await browser.newContext({
      viewport: vp,
      colorScheme: scheme,
      reducedMotion: 'reduce',
      deviceScaleFactor: 1,
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    await anon.addInitScript((s) => localStorage.setItem('guildwise-theme', s), scheme);
    const ap = await anon.newPage();
    const want = (n) => !only.length || only.includes(n);
    if (want('login')) {
      await ap.goto(`${base}/login`);
      await shot(ap, `${out}/login-${sk}-${scheme}.png`, true);
      await ap.getByLabel('Email').fill(email);
      await ap.getByLabel('Password').fill('wrong-password-xx');
      await ap.getByRole('button', { name: 'Sign in' }).click();
      await ap.getByRole('alert').first().waitFor();
      await shot(ap, `${out}/login-error-${sk}-${scheme}.png`, true);
    }
    if (want('invite')) {
      await ap.goto(`${base}/invite/not-a-real-token`);
      await shot(ap, `${out}/invite-invalid-${sk}-${scheme}.png`, true);
    }
    await anon.close();

    const ctx = await browser.newContext({
      viewport: vp,
      colorScheme: scheme,
      reducedMotion: 'reduce',
      storageState,
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    await ctx.addInitScript((s) => localStorage.setItem('guildwise-theme', s), scheme);
    const p = await ctx.newPage();
    for (const [name, path] of Object.entries(routes)) {
      if (!want(name)) continue;
      try {
        await p.goto(base + path);
        await shot(p, `${out}/${name}-${sk}-${scheme}.png`, !tall.has(name));
      } catch (e) {
        console.error(`FAILED ${name} ${sk} ${scheme}: ${e.message}`);
      }
    }
    if (mobile && want('drawer')) {
      await p.goto(`${base}/p/${web.key}/board`);
      await p.getByRole('button', { name: 'Open menu' }).click();
      await p.waitForTimeout(400);
      await shot(p, `${out}/drawer-m-${scheme}.png`, false);
    }
    await ctx.close();
  }
await browser.close();
await api.dispose();
console.log('done');
