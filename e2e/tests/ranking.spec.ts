import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DATABASE_URL, paths, RANKER, RANKMEM, ROOT, SMTP_URL } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';
import { killRunner, pairRunner, startRunner } from '../support/runner.ts';
import { makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

// Projects ranked by drag and drop, and "personal" dropped. One Owner, one Member and one
// runner: the Owner orders the projects with the move buttons, the keyboard and a drag, the Member only looks, and the
// one-off migration `no-personal-2026-10` runs through its CLI (dry run first) on a database that still has a personal
// vault, personal projects and a personal interest: the order puts work first, the vault files are merged under
// personal/ by the runner and the Owner gets a note on the desk.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('ranking');
let page: Page;
let api: APIRequestContext;
let orgId: string;
let orgVault: VaultFixture;
let personalVault: VaultFixture;
const ids: Record<string, string> = {};

const env = { ...process.env, DATABASE_URL, AOM_PUBLIC_ORIGIN: BASE_URL, AOM_SMTP_URL: SMTP_URL };
const server = (script: string, ...args: string[]): string =>
  execFileSync('pnpm', ['--filter', '@aom/server', script, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const order = async (p: Page): Promise<string[]> =>
  (await p.getByTestId('project-rank-list').getByRole('listitem').all()).length
    ? p
        .getByTestId('project-rank-list')
        .getByRole('listitem')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')?.replace('rank-row-', '') ?? ''))
    : [];
const dbOrder = async () =>
  (
    await q<{ key: string }>(
      `SELECT key FROM projects WHERE org_id=$1 AND kind='project' AND status='active' ORDER BY rank`,
      [orgId],
    )
  ).map((r) => r.key);

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, RANKER);
  const userId = (await q<{ id: string }>('SELECT id FROM users WHERE email=$1', [RANKER.email]))[0]
    ?.id as string;
  orgId = (
    await q<{ org_id: string }>(`SELECT org_id FROM org_members WHERE user_id=$1 AND status='active'`, [
      userId,
    ])
  )[0]?.org_id as string;
  api = await apiAs(RANKER.email, RANKER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('a new project goes to the bottom; the Owner reorders with the buttons, the keyboard and a drag, and it sticks', async () => {
  // created in this order: BILL (work), CABIN (personal, old tier 2), CHECK (work, tier 1), GARDEN (personal, tier 1)
  for (const [key, name] of [
    ['BILL', 'Billing'],
    ['CABIN', 'Cabin'],
    ['CHECK', 'Checkout'],
    ['GARDEN', 'Garden'],
  ] as const) {
    const r = await api.post('/api/projects', { data: { key, name, workflowKey: 'code' } });
    expect(r.status(), await r.text()).toBe(201);
    ids[key] = (await r.json()).project.id;
  }
  expect(await dbOrder()).toEqual(['BILL', 'CABIN', 'CHECK', 'GARDEN']);
  await page.goto('/projects');
  await expect(page.getByTestId('project-rank-list')).toBeVisible();
  expect(await order(page)).toEqual(['BILL', 'CABIN', 'CHECK', 'GARDEN']);
  await expect(page.getByTestId('rank-number-GARDEN')).toContainText('4');
  await page.screenshot({ path: `${paths.vaults}/projects-ranked.png`, fullPage: true });

  // the buttons: the first cannot go up, the last cannot go down
  await expect(page.getByRole('button', { name: 'Move Billing up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Garden down' })).toBeDisabled();
  await page.getByRole('button', { name: 'Move Garden up' }).click();
  await expect.poll(dbOrder).toEqual(['BILL', 'CABIN', 'GARDEN', 'CHECK']);
  expect(await order(page)).toEqual(['BILL', 'CABIN', 'GARDEN', 'CHECK']);
  await expect(page.getByTestId('rank-announce')).toContainText('Garden moved to position 3 of 4');
  await expect(page.getByRole('button', { name: 'Move Garden up' })).toBeFocused();

  // the keyboard: the grip answers the arrow keys
  await page.getByTestId('rank-grip-CHECK').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(dbOrder).toEqual(['BILL', 'CHECK', 'CABIN', 'GARDEN']);
  await expect(page.getByTestId('rank-grip-CHECK')).toBeFocused();

  // a drag: Billing goes below Cabin (dropped onto it)
  await page.getByTestId('rank-row-BILL').dragTo(page.getByTestId('rank-row-CABIN'));
  await expect.poll(dbOrder).toEqual(['CHECK', 'CABIN', 'BILL', 'GARDEN']);
  expect(await order(page)).toEqual(['CHECK', 'CABIN', 'BILL', 'GARDEN']);

  // it sticks: a reload shows the same order, and every change was one ProjectsRanked event
  await page.reload();
  await expect(page.getByTestId('project-rank-list')).toBeVisible();
  expect(await order(page)).toEqual(['CHECK', 'CABIN', 'BILL', 'GARDEN']);
  expect(
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM events WHERE type='ProjectsRanked' AND org_id=$1`,
        [orgId],
      )
    )[0]?.n,
  ).toBe(4);
  // the sidebar's project picker follows the same order
  await page
    .getByRole('link', { name: /Checkout/ })
    .first()
    .waitFor();
});

test('a Member sees the order and cannot change it; neither can the API', async ({ browser }) => {
  await deleteMailFor(RANKMEM.email);
  await page.goto('/settings/org');
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByTestId('invite-member').click();
  await page.getByRole('dialog').getByLabel('Email').fill(RANKMEM.email);
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
  const mail = await waitForMail(RANKMEM.email);
  const link = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(mail.text)?.[0] as string;
  const ctx = await browser.newContext();
  const mp = await ctx.newPage();
  await mp.goto(link);
  await mp.getByLabel('Your name').fill(RANKMEM.name);
  await mp.getByLabel('Password', { exact: true }).fill(RANKMEM.password);
  await mp.getByLabel('Confirm password').fill(RANKMEM.password);
  await mp.getByRole('button', { name: /join/i }).click();
  await expect(mp.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // a Member only sees the projects they were added to: add them to all four
  for (const k of ['CHECK', 'CABIN', 'BILL', 'GARDEN']) {
    const r = await api.post(`/api/projects/${ids[k]}/members`, { data: { email: RANKMEM.email } });
    expect(r.status(), await r.text()).toBe(201);
  }
  await mp.goto('/projects');
  await expect(mp.getByTestId('project-rank-list')).toBeVisible();
  expect(await order(mp)).toEqual(['CHECK', 'CABIN', 'BILL', 'GARDEN']);
  await expect(mp.getByTestId('rank-number-BILL')).toContainText('3');
  await expect(mp.getByTestId('rank-grip-CHECK')).toHaveCount(0);
  await expect(mp.getByRole('button', { name: /^Move / })).toHaveCount(0);
  const put = await mp.request.put('/api/projects/ranking', {
    data: { projectIds: [ids.GARDEN, ids.BILL, ids.CABIN, ids.CHECK] },
    headers: { Origin: BASE_URL },
  });
  expect(put.status()).toBe(403);
  expect(await dbOrder()).toEqual(['CHECK', 'CABIN', 'BILL', 'GARDEN']);
  await ctx.close();
});

test('setup: a runner with the organization vault, a personal vault with files, and the data of before (personal projects and interest)', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Ranking Box', HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'workstation connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === true,
    30_000,
  );
  orgVault = makeVault('ranking-org', {
    'README.md': '# Organization vault\n',
    'standing-orders.md': '# Standing orders\n- ORG-RULE keep answers short\n',
  });
  const v = await api.post('/api/vaults', {
    data: { kind: 'org', remoteUrl: orgVault.origin, syncIntervalSec: 2 },
  });
  expect(v.status(), await v.text()).toBe(201);
  await waitFor(
    'the runner cloned the organization vault',
    () => q<{ local_path: string | null }>('SELECT local_path FROM workstation_vaults'),
    (r) => !!r[0]?.local_path,
    30_000,
  );

  // an interest that lived in the personal vault
  const i = await api.post('/api/interests', { data: { name: 'AI news', scan: { manual: true } } });
  expect(i.status(), await i.text()).toBe(201);
  const interest = (
    await q<{ project_id: string; slug: string }>(
      `SELECT project_id, slug FROM interests WHERE name='AI news'`,
    )
  )[0];
  expect(interest?.slug).toBe('ai-news');

  // The database as the previous version left it: the personal vault (its row, written by the old code) and the
  // snapshot migration 1322 takes of every project's domain and tier before it drops the columns.
  personalVault = makeVault('ranking-personal', {
    'README.md': '# Personal vault\n',
    'standing-orders.md': '# Standing orders\n- PERSONAL-RULE\n',
    'projects/cabin/PROJECT.md': '# Cabin\n\nPERSONAL-MARK notes about the cabin.\n',
    'projects/garden/PROJECT.md': '# Garden\n\nPERSONAL-MARK notes about the garden.\n',
    'interests/ai-news/INTEREST.md': '# AI news\n\nPERSONAL-MARK old interest document.\n',
    'interests/ai-news/notes/2026-10-01-a-story.md': '# A story\n\nPERSONAL-MARK note from the old scans.\n',
  });
  await q(
    `INSERT INTO vaults (id, org_id, kind, name, remote_url, created_at)
     VALUES (gen_random_uuid(), $1, 'personal', 'Personal vault', $2, now())`,
    [orgId, personalVault.origin],
  );
  const snap = (key: string, domain: string, tier: number) =>
    q(
      `INSERT INTO legacy_project_domains (project_id, org_id, key, kind, domain, priority_tier, created_at, vault_dir, vault_folder)
       SELECT id, org_id, key, kind, $2, $3, created_at, vault_dir, vault_folder FROM projects WHERE key=$1 AND org_id=$4
       ON CONFLICT (project_id) DO UPDATE SET domain=EXCLUDED.domain, priority_tier=EXCLUDED.priority_tier`,
      [key, domain, tier, orgId],
    );
  await snap('BILL', 'work', 2);
  await snap('CHECK', 'work', 1);
  await snap('CABIN', 'personal', 2);
  await snap('GARDEN', 'personal', 1);
  await q(
    `INSERT INTO legacy_project_domains (project_id, org_id, key, kind, domain, priority_tier, created_at, vault_dir)
     SELECT id, org_id, key, kind, 'personal', 2, created_at, vault_dir FROM projects WHERE id=$1`,
    [interest?.project_id],
  );
});

test('dry run: the plan is printed and nothing is written', async () => {
  const before = {
    events: (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM events WHERE type IN ('ProjectsRanked','VaultMerged','ProjectVaultDirSet')`,
      )
    )[0]?.n,
    cmds: (
      await q<{ n: number }>(`SELECT count(*)::int AS n FROM runner_commands WHERE type='vault.merge'`)
    )[0]?.n,
    order: await dbOrder(),
  };
  const text = server('ranking:migrate', '--dry-run');
  // the boot of the e2e server recorded the migration (it had nothing to do then); this organization still has steps
  expect(text).toContain('still have steps left');
  expect(text).toMatch(/1\. CHECK "Checkout" \(work, tier 1\)/);
  expect(text).toMatch(/2\. BILL "Billing" \(work, tier 2\)/);
  expect(text).toMatch(/3\. GARDEN "Garden" \(personal, tier 1\)/);
  expect(text).toMatch(/4\. CABIN "Cabin" \(personal, tier 2\)/);
  expect(text).toContain(
    'personal vault "Personal vault" is merged into the organization vault under personal/',
  );
  expect(text).toContain('interests/ai-news');
  expect(text).toContain('folder projects/cabin -> personal/projects/cabin');
  expect(text).toContain('Dry run: nothing was written.');
  expect(
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM events WHERE type IN ('ProjectsRanked','VaultMerged','ProjectVaultDirSet')`,
      )
    )[0]?.n,
  ).toBe(before.events);
  expect(
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM runner_commands WHERE type='vault.merge'`))[0]?.n,
  ).toBe(before.cmds);
  expect(await dbOrder()).toEqual(before.order);
});

test('migrate: work first, personal below in tier order; the Owner finds a note on the desk; the vault page has no personal vault', async () => {
  const text = server('ranking:migrate');
  expect(text).toContain('4 project(s) ranked (2 personal), vault: merged');
  expect(await dbOrder()).toEqual(['CHECK', 'BILL', 'GARDEN', 'CABIN']);
  await page.goto('/projects');
  await expect(page.getByTestId('project-rank-list')).toBeVisible();
  expect(await order(page)).toEqual(['CHECK', 'BILL', 'GARDEN', 'CABIN']);
  await page.screenshot({ path: `${paths.vaults}/projects-ranked-migrated.png`, fullPage: true });
  // the hidden project of the interest is not in the ranking
  await expect(page.getByTestId('rank-row-AINEWS')).toHaveCount(0);
  await expect(page.getByText('AI news')).toHaveCount(0);

  await page.goto('/desk');
  const note = page.getByRole('article', { name: 'Projects are ranked now, and personal is gone' });
  await expect(note).toBeVisible();
  await expect(note).toContainText('GARDEN, CABIN');

  await page.goto('/settings/vaults');
  await expect(page.getByTestId('vault-org')).toBeVisible();
  await expect(page.getByTestId('vault-personal')).toHaveCount(0);
  await expect(page.getByTestId('vaults')).not.toContainText('Personal vault');
  await page.screenshot({ path: `${paths.vaults}/vaults-after-merge.png`, fullPage: true });
});

test('the runner merges the personal vault: files under personal/, the interest folder lifted, the old repository untouched', async () => {
  // the command was queued by the CLI (another process): a reconnect hands it to the runner
  killRunner('SIGTERM', HOME);
  await waitFor(
    'workstation offline',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === false,
    30_000,
  );
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'the merge reached the organization vault',
    async () => originHas(orgVault, 'personal/projects/cabin/PROJECT.md'),
    (b) => b === true,
    60_000,
  );
  expect(originFile(orgVault, 'personal/projects/garden/PROJECT.md')).toContain('PERSONAL-MARK');
  expect(originFile(orgVault, 'personal/standing-orders.md')).toContain('PERSONAL-RULE');
  // the organization's own files are untouched
  expect(originFile(orgVault, 'standing-orders.md')).toContain('ORG-RULE');
  // the personal interest lives where every interest lives, not under personal/
  expect(originFile(orgVault, 'interests/ai-news/notes/2026-10-01-a-story.md')).toContain('PERSONAL-MARK');
  expect(originHas(orgVault, 'personal/interests/ai-news/notes/2026-10-01-a-story.md')).toBe(false);
  // the file the server wrote for the interest since is never overwritten by the old one
  expect(originFile(orgVault, 'interests/ai-news/INTEREST.md')).not.toContain('PERSONAL-MARK');
  // the old repository is a backup: unchanged
  expect(originFile(personalVault, 'projects/cabin/PROJECT.md')).toContain('PERSONAL-MARK');
  const cmd = await q<{ status: string }>(`SELECT status FROM runner_commands WHERE type='vault.merge'`);
  expect(cmd).toHaveLength(1);
  await waitFor(
    'the merge command completed',
    async () =>
      (await q<{ status: string }>(`SELECT status FROM runner_commands WHERE type='vault.merge'`))[0]?.status,
    (s) => s === 'done',
    30_000,
  );
});

test('running the migration again changes nothing, and a ranking the Owner made since is kept', async () => {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Move Cabin up' }).click();
  await expect.poll(dbOrder).toEqual(['CHECK', 'BILL', 'CABIN', 'GARDEN']);
  const counts = async () =>
    (
      await q<{ n: number }>(
        `SELECT (SELECT count(*) FROM events WHERE type='VaultMerged') + (SELECT count(*) FROM runner_commands WHERE type='vault.merge') + (SELECT count(*) FROM desk_items WHERE subkind='no_personal_migrated')  AS n`,
      )
    )[0]?.n;
  const before = await counts();
  const text = server('ranking:migrate');
  expect(text).toContain('has already run');
  expect(await counts()).toBe(before);
  expect(await dbOrder()).toEqual(['CHECK', 'BILL', 'CABIN', 'GARDEN']);
  const dry = server('ranking:migrate', '--dry-run');
  expect(dry).toContain('has already run');
  expect(dry).toContain('No organization has projects to rank or a personal vault to merge.');
});
