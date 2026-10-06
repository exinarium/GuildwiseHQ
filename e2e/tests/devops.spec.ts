import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DEVOPS, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { expandWorkstation } from '../support/ui.ts';
import {
  makeVault,
  originFile,
  originHas,
  originLog,
  pushFromOther,
  type VaultFixture,
  writeVaultFile,
} from '../support/vault.ts';

test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('devops');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let devopsAgentId: string;
let projectId: string;
let repoId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, DEVOPS);
  api = await apiAs(DEVOPS.email, DEVOPS.password);
  const ctx = await browser.newContext({ storageState: await api.storageState() });
  page = await ctx.newPage();
});

const requestRow = (summary: string) => page.getByTestId(`devops-request-${summary.slice(0, 40)}`);

async function createCard(
  title: string,
  mock?: Record<string, string[]>,
  project = projectId,
): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId: project,
      title,
      cardType: 'feature',
      ...(project === projectId ? { repoId } : {}),
      completionAction: 'push_branch',
      fields: { ...SPEC, ...(mock ? { mock } : {}) },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}

test('AC1: pairing a workstation auto-hires exactly one DevOps engineer that cannot be fired, only reset', async () => {
  await page.goto('/workstations');
  await page
    .getByRole('button', { name: /pair workstation/i })
    .first()
    .click();
  await page.getByRole('button', { name: 'Generate pairing code' }).click();
  const code = (await page.getByTestId('pairing-code').innerText()).trim();
  pairRunner(BASE_URL, code, 'Dev Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({}, HOME);
  await page.keyboard.press('Escape');
  const card = page.getByTestId('workstation-Dev Box');
  await expect(card.getByTestId('connection-dot')).toHaveAttribute('data-connected', 'true');
  workstationId = (await (await api.get('/api/workstations')).json()).workstations[0].id;

  const agents = (await (await api.get('/api/agents')).json()).agents.filter(
    (a: { isDevops: boolean }) => a.isDevops,
  );
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ roleKey: 'devops', workstationId, status: 'active' });
  devopsAgentId = agents[0].id;
  // CI must never start a real session: the mock-mode runner reports claude-code unavailable on hello, so the
  // server re-points the auto-hired engineer to the mock runtime without any test intervention.
  await waitFor(
    'the DevOps engineer uses the mock runtime',
    async () =>
      (await (await api.get('/api/agents')).json()).agents.find(
        (x: { id: string }) => x.id === devopsAgentId,
      ),
    (a) => a?.runtime === 'mock',
    30_000,
  );
  await page.goto('/agents');
  const tile = page.getByTestId(`agent-${agents[0].name}`);
  await expect(tile).toContainText('DevOps engineer');
  await expect(tile.getByRole('button', { name: `Fire ${agents[0].name}` })).toHaveCount(0);
  await expect(tile.getByRole('button', { name: `Reset ${agents[0].name}` })).toBeVisible();
  // the API refuses to fire it too
  const fired = await api.post(`/api/agents/${devopsAgentId}/fire`, { data: {} });
  expect(fired.status()).toBe(409);
  // one engineer per workstation: the database agrees
  const n = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM agents WHERE is_devops AND status='active' AND workstation_id=$1`,
    [workstationId],
  );
  expect(n[0]?.n).toBe(1);
});

test('setup: project DVO with the toy repo and a builder', async () => {
  const proj = await api.post('/api/projects', { data: { key: 'DVO', name: 'DevOps project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  const hire = await api.post('/api/agents', {
    data: {
      name: 'Dana',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId,
      projectId,
      runtime: 'mock',
    },
  });
  expect(hire.status(), await hire.text()).toBe(201);
  await waitFor(
    'the workstation holds the toy repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
});

test('AC5a: a builder running `aom devops "start the app"` opens a request thread and the DevOps shift completes it', async () => {
  const ref = await createCard('Needs the app running', { build: ['devops'] });
  const req = await waitFor(
    'devops request from the builder',
    () =>
      q<{
        id: string;
        status: string;
        requested_by_kind: string;
        requested_by_name: string;
        summary: string;
        card_id: string;
      }>(
        `SELECT id, status, requested_by_kind, requested_by_name, summary, card_id FROM devops_requests ORDER BY created_at`,
      ),
    (r) => r.length === 1 && r[0]?.status === 'done',
    60_000,
  );
  expect(req[0]).toMatchObject({
    requested_by_kind: 'agent',
    requested_by_name: 'Dana',
    summary: 'start the app',
  });
  const changes = await q<{ summary: string; commands: string[] }>(
    'SELECT summary, commands FROM environment_changes',
  );
  expect(changes).toHaveLength(1);
  expect(changes[0]?.summary).toBe('mock: start the app');
  const thread = await q<{ kind: string }>(
    `SELECT kind FROM threads WHERE id=(SELECT thread_id FROM devops_requests LIMIT 1)`,
  );
  expect(thread[0]?.kind).toBe('devops');
  // the request did not stop the builder: the card moved on to review
  await waitFor(
    'builder handed off',
    () => q<{ stage: string }>('SELECT stage FROM cards WHERE ref=$1', [ref]),
    (r) => r[0]?.stage === 'review',
    60_000,
  );
  // the events are on the thread
  const types = await q<{ type: string }>(
    `SELECT DISTINCT type FROM events WHERE type LIKE 'DevOps%' OR type='EnvironmentChanged'`,
  );
  expect(types.map((t) => t.type)).toEqual(
    expect.arrayContaining([
      'DevOpsRequested',
      'DevOpsShiftDispatched',
      'EnvironmentChanged',
      'DevOpsRequestCompleted',
    ]),
  );

  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Dev Box'));
  const row = requestRow('start the app');
  await expect(row).toHaveAttribute('data-status', 'done');
  await row.getByRole('button').first().click();
  await expect(row.getByTestId('devops-thread')).toContainText('Dana');
  await expect(row.getByTestId('devops-changes')).toContainText('mock: start the app');
  await page.screenshot({ path: join(paths.vaults, 'devops-thread.png') });
});

test('AC5b: a request outside the granted access waits on an approval and resumes after it', async () => {
  const ref = await createCard('Needs docker', { build: ['devops_install'] });
  await waitFor(
    'approval requested',
    () => q<{ status: string }>(`SELECT status FROM devops_requests WHERE summary='install docker'`),
    (r) => r[0]?.status === 'needs_approval',
    60_000,
  );
  const ev = await q(`SELECT payload FROM events WHERE type='DevOpsApprovalNeeded'`);
  expect(ev).toHaveLength(1);
  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Dev Box'));
  const row = requestRow('install docker');
  await expect(row).toHaveAttribute('data-status', 'needs_approval');
  const approval = row.getByTestId('devops-approval');
  await expect(approval).toBeVisible();
  await expect(approval).toContainText('Approval needed: install docker');
  await page.screenshot({ path: join(paths.vaults, 'devops-approval.png') });
  // M2 integration: the same approval is a pinned desk item, and approving it there resumes DevOps.
  const desk = await q<{ kind: string; subkind: string; pinned: boolean; status: string; blocking: boolean }>(
    `SELECT kind, subkind, pinned, status, blocking FROM desk_items WHERE subkind='devops'`,
  );
  expect(desk).toEqual([
    { kind: 'approval', subkind: 'devops', pinned: true, status: 'open', blocking: true },
  ]);
  await page.goto('/desk');
  const item = page.getByRole('article', { name: 'DevOps needs approval: install docker' });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('urgent-badge')).toBeVisible();
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item).toHaveCount(0);
  const closed = await q<{ status: string; answer_option: string }>(
    `SELECT status, answer_option FROM desk_items WHERE subkind='devops'`,
  );
  expect(closed).toEqual([{ status: 'answered', answer_option: 'approved' }]);
  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Dev Box'));
  await expect(row).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  const changes = await q('SELECT 1 FROM environment_changes');
  expect(changes).toHaveLength(2);
  const approved = await q<{ payload: { resolution: string } }>(
    `SELECT payload FROM events WHERE type='DevOpsApprovalResolved'`,
  );
  expect(approved).toHaveLength(1);
  expect(approved[0]?.payload.resolution).toBe('approved');
  await waitFor(
    'second builder handoff',
    () => q<{ stage: string }>('SELECT stage FROM cards WHERE ref=$1', [ref]),
    (r) => r[0]?.stage === 'review',
    60_000,
  );
});

test('AC5c: with the access granted from the workstation page the same request needs no approval', async () => {
  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Dev Box'));
  const panel = page.getByTestId('devops-panel-Dev Box');
  await panel.getByLabel('Install packages and tools').click();
  await panel.getByLabel('Docker', { exact: true }).click();
  await waitFor(
    'access saved',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].devopsAccess,
    (a) => a.allowInstall && a.allowDocker,
  );
  const ask = page.getByRole('form', { name: 'Ask DevOps on Dev Box' });
  await ask.getByLabel('Ask DevOps').fill('install docker compose');
  await ask.getByRole('button', { name: 'Send request' }).click();
  const row = requestRow('install docker compose');
  await expect(row).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  const ap = await q(`SELECT 1 FROM events WHERE type='DevOpsApprovalNeeded'`);
  expect(ap).toHaveLength(1); // still only the earlier one
});

test('reset wipes the DevOps sandbox and keeps the engineer', async () => {
  const sandbox = join(HOME, 'agents', devopsAgentId);
  expect(existsSync(sandbox)).toBe(true);
  await page.goto('/agents');
  const tile = page.locator(`[data-testid^="agent-"]`).filter({ hasText: 'DevOps engineer' });
  await tile.getByRole('button', { name: /^Reset / }).click();
  await waitFor(
    'sandbox wiped',
    async () => existsSync(sandbox),
    (e) => !e,
    30_000,
  );
  const a = (await (await api.get('/api/agents')).json()).agents.find(
    (x: { id: string }) => x.id === devopsAgentId,
  );
  expect(a.status).toBe('active');
  expect(await q(`SELECT 1 FROM events WHERE type='AgentReset'`)).toHaveLength(1);
});

// ------------------------------------------------------------------------------------------- vaults

let WORK: VaultFixture;
let PERSONAL: VaultFixture;
test.beforeAll(() => {
  WORK = makeVault('work', {
    'standing-orders.md': 'WORK-ORDER keep answers short\n',
    'projects/dvo/PROJECT.md': 'WORK-MARK project doc for DVO\n',
  });
  PERSONAL = makeVault('personal', {
    'projects/hob/PROJECT.md': 'PERSONAL-MARK secret hobby notes\n',
  });
});
const workClone = () =>
  q<{ id: string }>(`SELECT id FROM vaults WHERE kind='work'`).then((r) =>
    join(HOME, 'vaults', r[0]?.id ?? 'none'),
  );

test('AC2: vault sync pushes local edits, pulls remote edits and pauses on a conflict until resolved', async () => {
  await page.goto('/settings/vaults');
  for (const [kind, testId, v] of [
    ['Work vault', 'vault-work', WORK],
    ['Personal vault', 'vault-personal', PERSONAL],
  ] as const) {
    await page.getByRole('button', { name: 'Register a vault' }).click();
    const form = page.getByRole('form', { name: 'Register vault' });
    await form.getByLabel('Kind').selectOption({ label: kind });
    await form.getByLabel('Git URL').fill(v.origin);
    await form.getByLabel('Sync interval (seconds)').fill('2');
    await form.getByRole('button', { name: 'Register vault' }).click();
    await expect(page.getByTestId(testId)).toBeVisible(); // the form resets once registered
  }
  const work = page.getByTestId('vault-work');
  await expect(work).toBeVisible();
  await expect(work.getByTestId('vault-ws-Dev Box')).toContainText('synced', { timeout: 30_000 });
  const dir = await workClone();
  expect(existsSync(join(dir, 'standing-orders.md'))).toBe(true);

  // a local edit is committed and pushed within the interval
  writeVaultFile(dir, 'projects/dvo/notes/local.md', 'edited on the workstation\n');
  await waitFor(
    'local edit on origin',
    async () => originHas(WORK, 'projects/dvo/notes/local.md'),
    (b) => b,
    30_000,
  );
  expect(originLog(WORK)[0]).toMatch(/aom sync Dev Box/);
  expect(originLog(WORK)[0]).toMatch(/^[A-Za-z]+ \(aom\)\|/);

  // a remote edit is pulled
  pushFromOther(WORK, 'standing-orders.md', 'WORK-ORDER keep answers short\nWORK-ORDER2 from elsewhere\n');
  await waitFor(
    'remote edit pulled',
    async () => readFileSync(join(dir, 'standing-orders.md'), 'utf8'),
    (t) => t.includes('ORDER2'),
    30_000,
  );

  // a conflicting edit pauses the vault and raises a pinned escalation
  writeVaultFile(dir, 'conflict.md', 'one\nlocal\n');
  await waitFor(
    'local conflict file on origin',
    async () => originHas(WORK, 'conflict.md'),
    (b) => b,
    30_000,
  );
  pushFromOther(WORK, 'conflict.md', 'one\nremote\n');
  writeVaultFile(dir, 'conflict.md', 'one\nlocal again\n');
  await expect(work.getByTestId('vault-ws-Dev Box')).toHaveAttribute('data-paused', 'true', {
    timeout: 30_000,
  });
  await expect(work.getByTestId('vault-ws-Dev Box')).toContainText('Sync paused: conflict');
  await expect(work.getByTestId('vault-ws-Dev Box')).toContainText('conflict.md');
  const ev = await q<{ payload: { files: string[]; deskItemId: string } }>(
    `SELECT payload FROM events WHERE type='VaultSyncConflict'`,
  );
  expect(ev).toHaveLength(1);
  expect(ev[0]?.payload.files).toEqual(['conflict.md']);
  await page.screenshot({ path: join(paths.vaults, 'vault-conflict.png') });
  // syncing really is paused: further local edits are not pushed
  writeVaultFile(dir, 'while-paused.md', 'x\n');
  await new Promise((r) => setTimeout(r, 5000));
  expect(originHas(WORK, 'while-paused.md')).toBe(false);

  // the manager resolves it in the clone (take the remote side) and resumes
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['-C', dir, 'fetch', 'origin'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'reset', '--hard', 'origin/main'], { stdio: 'ignore' });
  // M2 integration: the conflict is a pinned desk escalation; resolving it there resumes sync.
  const deskRows = await q<{ id: string; kind: string; pinned: boolean; status: string }>(
    `SELECT id, kind, pinned, status FROM desk_items WHERE subkind='vault_conflict'`,
  );
  expect(deskRows).toHaveLength(1);
  expect(deskRows[0]).toMatchObject({ kind: 'escalation', pinned: true, status: 'open' });
  expect(deskRows[0]?.id).toBe(ev[0]?.payload.deskItemId);
  await page.goto('/desk');
  const conflictItem = page.getByRole('article', { name: /Vault sync conflict/ });
  await expect(conflictItem).toContainText('conflict.md');
  await conflictItem.getByRole('button', { name: /Conflict resolved/ }).click();
  await expect(conflictItem).toHaveCount(0);
  expect(
    (await q<{ status: string }>(`SELECT status FROM desk_items WHERE subkind='vault_conflict'`))[0]?.status,
  ).toBe('answered');
  await page.goto('/settings/vaults');
  await expect(work.getByTestId('vault-ws-Dev Box')).toHaveAttribute('data-paused', 'false', {
    timeout: 30_000,
  });
  writeVaultFile(dir, 'after-resume.md', 'back\n');
  await waitFor(
    'sync after resume',
    async () => originHas(WORK, 'after-resume.md'),
    (b) => b,
    30_000,
  );
});

test('AC3: answering a question on the desk writes projects/<name>/decisions/<date>-<slug>.md into the domain vault, committed and pushed', async () => {
  // The real M2 path: a builder asks, the manager answers on the desk, the QuestionAnswered hook writes the file.
  const ref = await createCard('Needs a decision for the vault', { build: ['question', 'ok'] });
  await page.goto('/desk');
  const item = page.getByRole('article', { name: `Mock question for ${ref}?` });
  await expect(item).toBeVisible({ timeout: 90_000 });
  await item.getByRole('button', { name: 'Answer' }).click(); // the recommended option is preselected
  await expect(item).toHaveCount(0);

  const entry = await waitFor(
    'ledger entry with a vault path',
    () =>
      q<{ id: string; vault_path: string | null }>(
        `SELECT id, vault_path FROM ledger_entries WHERE source_desk_item_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      ),
    (r) => !!r[0]?.vault_path,
    30_000,
  );
  const path = entry[0]?.vault_path as string;
  expect(path).toMatch(
    new RegExp(
      `^projects/dvo/decisions/\\d{4}-\\d{2}-\\d{2}-mock-question-for-${ref.toLowerCase()}-[0-9a-f]{6}\\.md$`,
    ),
  );
  await waitFor(
    'decision file on origin',
    async () => originHas(WORK, path),
    (b) => b,
    30_000,
  );
  const md = originFile(WORK, path);
  expect(md).toContain(`# Mock question for ${ref}?`);
  expect(md).toContain('Status: accepted');
  expect(md).toContain('yes');
  expect(md).toContain(`on card ${ref}`);
  expect(originLog(WORK).some((l) => l.includes(`aom: decision ${ref} Mock question for ${ref}?`))).toBe(
    true,
  );
  // the personal vault never got it
  expect(originHas(PERSONAL, path)).toBe(false);
  // the unblocked card carries on
  await waitFor(
    'unblocked card reaches review',
    () => q<{ stage: string }>('SELECT stage FROM cards WHERE ref=$1', [ref]),
    (r) => r[0]?.stage === 'review',
    90_000,
  );
});

test('AC3b: standing orders added to the ledger are appended to the vault standing-orders.md (project and global)', async () => {
  const project = await api.post('/api/ledger', {
    data: {
      scope: 'standing_order',
      projectId,
      title: 'DVO order: tests first',
      body: 'Write the test before the code.',
    },
  });
  expect(project.status(), await project.text()).toBe(201);
  const global = await api.post('/api/ledger', {
    data: { scope: 'standing_order', title: 'GLOBAL order: be brief', body: 'Keep every answer short.' },
  });
  expect(global.status(), await global.text()).toBe(201);
  await waitFor(
    'project standing order on origin',
    async () =>
      originHas(WORK, 'projects/dvo/standing-orders.md') &&
      originFile(WORK, 'projects/dvo/standing-orders.md'),
    (t) => !!t && t.includes('DVO order: tests first'),
    30_000,
  );
  expect(originFile(WORK, 'projects/dvo/standing-orders.md')).toContain('Write the test before the code.');
  await waitFor(
    'global standing order on origin',
    async () => originFile(WORK, 'standing-orders.md'),
    (t) => t.includes('GLOBAL order: be brief') && t.includes('WORK-ORDER2'),
    30_000,
  );
  const paths = await q<{ vault_path: string | null }>(
    `SELECT vault_path FROM ledger_entries WHERE scope='standing_order' AND vault_path IS NOT NULL ORDER BY created_at`,
  );
  expect(paths.map((p) => p.vault_path)).toEqual(['projects/dvo/standing-orders.md', 'standing-orders.md']);
});

test('AC4: a work-domain card shift sees only the work vault; a personal card only the personal vault', async () => {
  const personal = await api.post('/api/projects', {
    data: { key: 'HOB', name: 'Hobby', domain: 'personal', vaultFolder: 'projects/hob' },
  });
  expect(personal.status()).toBe(201);
  const hobId = (await personal.json()).project.id;
  const add = await api.post(`/api/projects/${hobId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  // both vaults are cloned on the workstation by now
  await waitFor(
    'both vaults cloned',
    async () =>
      existsSync(join(HOME, 'vaults')) &&
      (
        await q<{ n: number }>(
          'SELECT count(*)::int AS n FROM workstation_vaults WHERE local_path IS NOT NULL',
        )
      )[0]?.n,
    (n) => n === 2,
    30_000,
  );
  await waitFor(
    'the hobby project repo is on the workstation',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 2,
    30_000,
  );
  const hobRepo = (await (await api.get(`/api/projects/${hobId}`)).json()).repos[0].id;
  const mk = async (project: string, repo: string, title: string) => {
    const r = await api.post('/api/cards', {
      data: {
        projectId: project,
        title,
        cardType: 'feature',
        repoId: repo,
        completionAction: 'push_branch',
        fields: SPEC,
        specify: true,
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).card.ref as string;
  };
  // Dana is scoped to DVO (work); Hal to HOB (personal). Each regenerates its own instructions file per shift.
  const hal = await api.post('/api/agents', {
    data: {
      name: 'Hal',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId,
      projectId: hobId,
      runtime: 'mock',
    },
  });
  expect(hal.status(), await hal.text()).toBe(201);
  const halId = (await hal.json()).id as string;
  const dana = (await (await api.get('/api/agents')).json()).agents.find(
    (a: { name: string }) => a.name === 'Dana',
  );
  const instructions = (agent: string) =>
    readFileSync(join(HOME, 'agents', agent, 'claude', 'CLAUDE.md'), 'utf8');
  const handedOff = (ref: string) =>
    waitFor(
      `${ref} handed off to review`,
      () => q<{ stage: string }>('SELECT stage FROM cards WHERE ref=$1', [ref]),
      (r) => r[0]?.stage === 'review',
      90_000,
    );

  const workRef = await mk(projectId, repoId, 'Work card with vault');
  const hobRef = await mk(hobId, hobRepo, 'Hobby card with vault');
  await handedOff(workRef);
  await handedOff(hobRef);

  const w = instructions(dana.id);
  expect(w).toContain('- Key: DVO');
  expect(w).toContain('WORK-MARK project doc for DVO');
  expect(w).toContain('WORK-ORDER');
  expect(w).not.toContain('PERSONAL-MARK');
  const h = instructions(halId);
  expect(h).toContain('- Key: HOB');
  expect(h).toContain('PERSONAL-MARK secret hobby notes');
  expect(h).not.toContain('WORK-MARK');
  expect(h).not.toContain('WORK-ORDER');
});
