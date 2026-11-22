// Screenshots of the REAL approvals page for the user guide (docs/guide/assets/approvals-*.jpg). Starts the page from
// source with fixture state in a temp folder (two offered organizations, one repository, one held deploy), drives it
// with the e2e workspace's Playwright (light theme, 1200 px wide), and pairs the browser in-process through the same
// code path `guildwise-runner approvals pair` uses. Re-run from apps/runner:
//   npx tsx scripts/approvals-screenshots.ts            (instance uat; also a prod-style header shot)
//   SHOTS_THEME=dark SHOTS_OUT=/tmp/x npx tsx scripts/approvals-screenshots.ts   (a dark-theme check elsewhere)
// Needs: pnpm install, and chromium for the e2e workspace (pnpm --filter @aom/e2e exec playwright install chromium).
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nullLogger } from '../src/log.ts';
import { HeldStore } from '../src/policy/held.ts';
import { PasskeyStore } from '../src/policy/passkey-store.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { approvalsPair } from '../src/window/cli.ts';
import { startApprovalsWindow } from '../src/window/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const out = process.env.SHOTS_OUT || join(repo, 'docs', 'guide', 'assets');
const theme = process.env.SHOTS_THEME === 'dark' ? 'dark' : 'light';
const { chromium } = createRequire(join(repo, 'e2e', 'package.json'))('@playwright/test');

const ORG_LAW = '0190a000-0000-7000-8000-00000000000a';
const ORG_ACC = '0190a000-0000-7000-8000-00000000000b';
const AGENT_DANA = '0190a000-0000-7000-8000-0000000000aa';
const AGENT_SAM = '0190a000-0000-7000-8000-0000000000bb';

/** A port the OS says is free on 127.0.0.1 (never the range a live runner uses). */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ host: '127.0.0.1', port: 0 }, () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });

async function startFixture(instance: 'uat' | 'prod') {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), `aom-window-shots-${instance}-`));
  const policy = new PolicyStore(dir);
  const user = `guildwise-runner-${instance}`;
  policy.write({
    ...policy.get(),
    setupDone: true,
    docker: 'rootless',
    runnerUser: { mode: 'dedicated', name: user },
    devops: { agents: { [ORG_LAW]: AGENT_DANA } },
  });
  const held = new HeldStore(dir);
  const now = Date.now();
  held.put({
    id: 'k3m9q2x7aa',
    kind: 'deploy.exec',
    pairing: join(dir, 'pairing'),
    summary: 'Publish "Client portal" (acme-website) to clients.acmelaw.example',
    detail: [
      'Publish an app',
      'project: Client portal',
      'repository: github.com/acme/website',
      'branch: main (commit 4f2a9c1)',
      'target: clients.acmelaw.example (docker compose)',
      'requested by: Sam (DevOps helper), card "Add the appointment form"',
    ].join('\n'),
    commandHash: 'c'.repeat(64),
    createdAt: new Date(now - 12 * 60_000).toISOString(),
    expiresAt: new Date(now + 24 * 3_600_000 - 12 * 60_000).toISOString(),
    replay: { type: 'command', body: {} },
    pin: { base: 'a'.repeat(64), bound: 'b'.repeat(64) },
    state: 'held',
  });
  const server = instance === 'uat' ? 'https://uat.guildwise.example' : 'https://hq.guildwise.example';
  const win = await startApprovalsWindow({
    instance,
    serverOrigins: [server],
    version: '1.10.0',
    status: () => ({
      connected: { [server]: true },
      shifts: [{ title: 'Builder on "Add the appointment form" (Client portal)' }],
      runnerUser: user,
      docker: 'running',
    }),
    held,
    policy,
    passkeys: new PasskeyStore(dir),
    offers: () => ({
      orgs: [
        {
          orgId: ORG_LAW,
          orgName: 'Acme Law',
          role: 'Owner',
          devopsAgentId: AGENT_DANA,
          devopsAgentName: 'Dana',
        },
        {
          orgId: ORG_ACC,
          orgName: 'Smith & Co Accountants',
          role: 'Member',
          devopsAgentId: AGENT_SAM,
          devopsAgentName: 'Sam',
        },
      ],
      repos: [{ url: 'https://github.com/acme/website', name: 'acme-website' }],
    }),
    log: nullLogger,
    decide: (id, state, extra) => held.decide(id, state, 'local', extra),
    dir,
    cli: `sudo -u ${user} -H /home/${user}/.local/bin/guildwise-runner`,
    portRange: [port, port],
  });
  if (win.windowError) throw new Error(win.windowError);
  return { dir, win, instance };
}

async function pairPage(page: import('playwright-core').Page, f: { dir: string; instance: string }) {
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  const cmd = await page.locator('.cmd code').first().textContent();
  const code = cmd?.split(' ').pop() ?? '';
  await approvalsPair({ dir: f.dir, instance: f.instance, out: () => {}, ask: async () => 'yes' }, code);
  await page.getByRole('heading', { name: 'This computer', exact: true }).waitFor({ timeout: 15_000 });
}

const jpg = (name: string) => ({ path: join(out, name), type: 'jpeg' as const, quality: 85 });

const browser = await chromium.launch();
const fixtures: Array<Awaited<ReturnType<typeof startFixture>>> = [];
try {
  const uat = await startFixture('uat');
  fixtures.push(uat);
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 760 }, colorScheme: theme });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(String(e)));
  page.on('console', (m: { type(): string; text(): string }) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${uat.win.port}/`);
  await page.getByRole('button', { name: 'Pair this browser' }).waitFor();
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.locator('.cmd code').first().waitFor();
  await page.screenshot(jpg('approvals-signin.jpg'));
  const code = ((await page.locator('.cmd code').first().textContent()) ?? '').split(' ').pop() ?? '';
  await approvalsPair({ dir: uat.dir, instance: 'uat', out: () => {}, ask: async () => 'yes' }, code);
  await page.getByRole('heading', { name: 'This computer', exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);

  const statusBox = await page.locator('section.panel').nth(0).boundingBox();
  if (!statusBox) throw new Error('no status panel');
  await page.screenshot({
    ...jpg('approvals-status.jpg'),
    clip: { x: 0, y: 0, width: 1200, height: statusBox.y + statusBox.height + 16 },
    fullPage: true,
  });
  const allowsBox = await page.locator('section.panel').nth(2).boundingBox();
  if (!allowsBox) throw new Error('no allows panel');
  await page.screenshot({
    ...jpg('approvals-allows.jpg'),
    clip: { x: 0, y: allowsBox.y - 16, width: 1200, height: allowsBox.height + 32 },
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Look and approve' }).click();
  await page.locator('dialog .detail').waitFor();
  await page.screenshot(jpg('approvals-waiting.jpg'));
  await page.getByRole('button', { name: 'Cancel' }).click();

  // self-check of the real flow (not saved): a grant through its confirm dialog, then the held deploy approved
  await page.getByText('Smith & Co Accountants: let DevOps helper').click();
  await page.getByRole('button', { name: 'Yes, allow' }).click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  const granted = new PolicyStore(uat.dir).get().devops.agents;
  if (granted[ORG_ACC] !== AGENT_SAM) throw new Error('the grant from the page did not reach policy.json');
  await page.getByRole('button', { name: 'Look and approve' }).click();
  await page.getByRole('button', { name: 'Yes, approve' }).click();
  await page.getByText('Nothing is waiting for your yes.').waitFor({ timeout: 10_000 });

  // a prod-style instance: same page, no warning band
  const prod = await startFixture('prod');
  fixtures.push(prod);
  const page2 = await ctx.newPage();
  await page2.goto(`http://127.0.0.1:${prod.win.port}/`);
  await pairPage(page2, prod);
  await page2.screenshot({ ...jpg('approvals-prod.jpg'), clip: { x: 0, y: 0, width: 1200, height: 260 } });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(`saved approvals-{signin,status,allows,waiting,prod}.jpg to ${out}`);
} finally {
  await browser.close();
  for (const f of fixtures) {
    await f.win.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
}
