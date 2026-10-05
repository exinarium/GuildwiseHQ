import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, PHASER, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// Phases and follow-ups (docs/design/phases.md A13): one user, one runner (mock runtime), project PHS on the toy repo,
// a mock BA (Ben), a builder, a reviewer and a tester. The mock BA proposes the phase in an intake; the mock DevOps
// engineer "deploys"; the mock tester runs the regression card pinned to this workstation. No Claude, GitHub or
// Docker is contacted.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('phases');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let projectId: string;
let repoId: string;
let localTargetId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Someone Else',
      GIT_AUTHOR_EMAIL: 'else@e2e.test',
      GIT_COMMITTER_NAME: 'Someone Else',
      GIT_COMMITTER_EMAIL: 'else@e2e.test',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });

interface PhaseRow {
  id: string;
  ref: string;
  name: string;
  status: string;
  report: string | null;
  report_desk_item_id: string | null;
  results_desk_item_id: string | null;
  proposal_desk_item_id: string | null;
}
const phase = async (ref: string) => (await q<PhaseRow>('SELECT * FROM phases WHERE ref=$1', [ref]))[0];
const phaseWhen = (ref: string, what: string, pred: (p: PhaseRow | undefined) => boolean, ms = 180_000) =>
  waitFor(`${ref} ${what}`, () => phase(ref), pred, ms) as Promise<PhaseRow>;
const followups = (ref: string) =>
  q<{
    position: number;
    kind: string;
    status: string;
    delegate: string | null;
    result_summary: string | null;
    devops_request_ids: string[];
    regression_card_ids: string[];
  }>(
    `SELECT f.* FROM phase_followups f JOIN phases p ON p.id = f.phase_id WHERE p.ref=$1 ORDER BY f.position`,
    [ref],
  );
const card = async (ref: string) => (await q<any>('SELECT * FROM cards WHERE ref=$1', [ref]))[0];

async function createCard(
  title: string,
  extra: Record<string, unknown> = {},
  fields: Record<string, unknown> = {},
) {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'merge',
      fields: { ...SPEC, ...fields },
      specify: true,
      ...extra,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card as { id: string; ref: string };
}
async function newPhase(name: string, followupList: unknown[], description = '') {
  const res = await api.post(`/api/projects/${projectId}/phases`, {
    data: { name, description, followups: followupList },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; ref: string };
}
const put = async (cardId: string, phaseId: string) => {
  const res = await api.put(`/api/cards/${cardId}/phase`, { data: { phaseId } });
  expect(res.status(), await res.text()).toBe(200);
};
const approveViaDesk = async (itemId: string, resolution = 'approved') => {
  const res = await api.post(`/api/desk/${itemId}/resolve`, { data: { resolution } });
  expect(res.status(), await res.text()).toBe(200);
};

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, PHASER);
  api = await apiAs(PHASER.email, PHASER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner, project PHS on the toy repo, a BA, a builder, a reviewer and a tester', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Phase Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200', AOM_MOCK_CHAT_TOKEN_MS: '20' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'PHS', name: 'Phases project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  await waitFor(
    'the workstation holds the toy repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
  for (const [name, roleKey, seniority] of [
    ['Ben', 'ba', 'senior'],
    ['Bo', 'builder', 'junior'],
    ['Rae', 'reviewer', 'senior'],
    ['Tess', 'tester', 'junior'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, projectId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
  await waitFor(
    'DevOps engineer uses the mock runtime',
    async () => (await (await api.get('/api/agents')).json()).agents as any[],
    (a) => a.some((x) => x.isDevops && x.runtime === 'mock'),
    30_000,
  );
});

test('AC1: the local deploy target is added on the project settings page; the default follow-ups are deploy and regression', async () => {
  await page.goto(`/projects/${projectId}/settings`);
  const form = page.getByRole('form', { name: 'Add deploy target' });
  await form.getByLabel('Name').fill('local');
  await form.getByLabel('App URL (optional)').fill('http://localhost:4601');
  await form.getByLabel('How to deploy (notes)').fill('docker compose up -d in the toy repository');
  await form.getByRole('button', { name: 'Add deploy target' }).click();
  await expect(page.getByTestId('deploy-target-list')).toContainText('local');
  const t = await q<{ id: string; kind: string; workstation_id: string | null }>(
    `SELECT * FROM deploy_targets WHERE name='local'`,
  );
  expect(t[0]).toMatchObject({ kind: 'local_docker', workstation_id: null });
  localTargetId = t[0]!.id;

  const res = await api.put(`/api/projects/${projectId}/followup-defaults`, {
    data: {
      followups: [
        { kind: 'deploy', targetId: localTargetId },
        { kind: 'regression', platform: 'web', targetId: localTargetId },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  await page.reload();
  await expect(page.getByTestId('followup-defaults')).toContainText('Deploy');
  await page.screenshot({ path: join(paths.vaults, 'phases-settings.png'), fullPage: true });
});

test('AC2: the BA proposes a phase with two cards in an intake; the manager confirms it on the desk', async () => {
  const dir = join(HOME, 'mock-sources');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'PHS-1.json'),
    JSON.stringify({
      title: 'Autosave',
      body: 'Save drafts as the user types.',
      phase: {
        name: 'Phase 1: autosave',
        description: 'Autosave for drafts',
        followups: [
          { kind: 'deploy', target: 'local' },
          { kind: 'regression', platform: 'web', target: 'local' },
        ],
      },
      cards: [
        { title: 'Autosave drafts', completionAction: 'merge', phase: true },
        { title: 'Autosave indicator', completionAction: 'merge', phase: true },
      ],
    }),
  );
  await page.goto('/intake');
  await page.getByLabel('Ticket or need').fill('PHS-1');
  await page.getByRole('button', { name: 'Start intake' }).click();
  await expect(page.getByTestId('chat-panel')).toContainText('Proposed phase PHS-P1', { timeout: 60_000 });
  await expect(page.getByTestId('chat-panel')).toContainText('confirm PHS-P1 on the desk', {
    timeout: 60_000,
  });

  const p = await phaseWhen(
    'PHS-P1',
    'proposed with its submission',
    (x) => !!x?.proposal_desk_item_id && x.status === 'proposed',
    60_000,
  );
  expect(p.name).toBe('Phase 1: autosave');
  expect((await followups('PHS-P1')).map((f) => f.kind)).toEqual(['deploy', 'regression']);
  const cards = await q<{ ref: string; phase_assignment: string }>(
    `SELECT ref, phase_assignment FROM cards WHERE phase_id=$1 ORDER BY number`,
    [p.id],
  );
  expect(cards).toHaveLength(2);
  expect(cards.every((c) => c.phase_assignment === 'proposed')).toBe(true);

  await page.goto('/desk');
  const item = page.getByRole('article', { name: /Confirm phase PHS-P1/ });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('desk-kind')).toHaveText('Phase proposal');
  await expect(item.getByTestId('phase-cards')).toContainText('Autosave drafts');
  await page.screenshot({ path: join(paths.vaults, 'phases-proposal.png'), fullPage: true });
  await item.getByTestId('phase-confirm').click();
  await expect(item).toHaveCount(0);
  await phaseWhen('PHS-P1', 'open', (x) => x?.status === 'open', 30_000);
  expect(
    (await q(`SELECT 1 FROM cards WHERE phase_id=$1 AND phase_assignment='confirmed'`, [p.id])).length,
  ).toBe(2);

  // the board shows the phase chip and the filter
  await page.goto('/p/PHS/board');
  await expect(page.getByTestId('phase-chip').first()).toContainText('PHS-P1');
  await page.getByTestId('phase-filter').selectOption({ label: 'PHS-P1 Phase 1: autosave' });
  await expect(page.getByTestId('phase-chip')).toHaveCount(2, { timeout: 15_000 });
});

test('AC3: both cards finish; the BA reports the phase on the desk with the merge commits; the manager adds a custom item and approves', async () => {
  // PHS-1 and PHS-2 are built, reviewed, tested and merged by the mock agents
  await phaseWhen('PHS-P1', 'waiting for approval', (x) => x?.status === 'awaiting_approval', 240_000);
  const merges = await q<{ ref: string; commit: string }>(
    `SELECT c.ref, c.finalize_result->>'mergeCommit' AS commit FROM cards c JOIN phases p ON p.id = c.phase_id WHERE p.ref='PHS-P1' ORDER BY c.number`,
  );
  expect(merges).toHaveLength(2);
  for (const m of merges) expect(m.commit).toMatch(/^[0-9a-f]{40}$/);

  await page.goto('/desk');
  const item = page.getByRole('article', {
    name: /PHS-P1 Phase 1: autosave is done: approve 2 follow-ups\?/,
  });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('desk-kind')).toHaveText('Phase done');
  for (const m of merges) await expect(item.getByTestId('phase-cards')).toContainText(`${m.ref}`);
  for (const m of merges) await expect(item.getByTestId('phase-cards')).toContainText(m.commit.slice(0, 10));
  await expect(item.getByTestId('followup-1')).toContainText('Deploy to local');
  await expect(item.getByTestId('followup-2')).toContainText('regression run');
  await page.screenshot({ path: join(paths.vaults, 'phases-done.png'), fullPage: true });

  // edit while deciding: add a custom item the BA does itself
  await item.getByTestId('phase-edit-followups').click();
  const dialog = page.getByTestId('edit-followups-dialog');
  await dialog.getByTestId('add-custom').click();
  await dialog.getByLabel('Instruction').fill('[ba] Write the release notes');
  await dialog.getByTestId('save-followups').click();
  await expect(dialog).toHaveCount(0);
  await expect(item.getByTestId('followup-3')).toContainText('[ba] Write the release notes');
  await item.getByTestId('phase-approve').click();
  await expect(item).toHaveCount(0);
  expect((await phase('PHS-P1'))!.status).toBe('running_followups');
});

test('AC4: the deploy goes to DevOps, the regression card is claimed on this workstation and passes, the BA does the custom item; 3 succeeded', async () => {
  await phaseWhen(
    'PHS-P1',
    'reporting the results',
    (x) => x?.status === 'reporting_results' || x?.status === 'done',
    240_000,
  );
  const done = await phaseWhen(
    'PHS-P1',
    'done',
    (x) => x?.status === 'done' && !!x.results_desk_item_id,
    120_000,
  );
  const f = await followups('PHS-P1');
  expect(f.map((x) => [x.kind, x.status, x.delegate])).toEqual([
    ['deploy', 'succeeded', 'devops'],
    ['regression', 'succeeded', 'tester'],
    ['custom', 'succeeded', 'ba'],
  ]);
  // exactly one DevOps request (one workstation), sent by the phase, carrying the target
  const req = await q<{ workstation_id: string; summary: string; requested_by_name: string; status: string }>(
    `SELECT * FROM devops_requests WHERE requested_by_name LIKE 'Phase PHS-P1%'`,
  );
  expect(req).toHaveLength(1);
  expect(req[0]).toMatchObject({ workstation_id: workstationId, status: 'done' });
  expect(req[0]?.summary).toContain('deploy local');
  // the regression card ran here, against the deployed URL, and is not a phase member
  const rc = (await q<any>(`SELECT * FROM cards WHERE id = ANY($1::uuid[])`, [f[1]?.regression_card_ids]))[0];
  expect(rc).toMatchObject({
    card_type: 'regression',
    origin: 'regression',
    home_workstation_id: workstationId,
    phase_id: null,
    status: 'done',
  });
  expect(rc.fields).toMatchObject({ targetUrl: 'http://localhost:4601', deployTarget: 'local' });
  expect(
    (await q(`SELECT result FROM test_runs WHERE card_id=$1`, [rc.id])).map((r: any) => r.result),
  ).toEqual(['passed']);

  await page.goto('/desk');
  const item = page.getByRole('article', { name: /PHS-P1 follow-ups finished: 3 succeeded/ });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('desk-kind')).toHaveText('Phase results');
  await page.screenshot({ path: join(paths.vaults, 'phases-results.png'), fullPage: true });
  await item.getByTestId('phase-ack').click();
  await expect(item).toHaveCount(0);

  // the phase page tells the story
  await page.goto('/p/PHS/phases/1');
  await expect(page.getByTestId('phase-status')).toContainText('Done');
  await expect(page.getByTestId('followup-status-1')).toHaveText('succeeded');
  await expect(page.getByTestId('followup-status-3')).toHaveText('succeeded');
  await expect(page.getByTestId('phase-thread')).toContainText('Follow-up 1 of 3');
  await page.screenshot({ path: join(paths.vaults, 'phases-page.png'), fullPage: true });
  expect(done.report).toContain('PHS-P1');
});

test('AC5: a deploy that fails stops the rest: the regression is skipped and the results notice is pinned', async () => {
  const p = await newPhase('Phase 2: failing deploy', [
    { kind: 'deploy', targetId: localTargetId, note: '[no_report]' },
    { kind: 'regression', platform: 'web', targetId: localTargetId },
  ]);
  const c = await createCard('Failing deploy card');
  await put(c.id, p.id);
  const row = await phaseWhen(
    p.ref,
    'waiting for approval',
    (x) => x?.status === 'awaiting_approval',
    240_000,
  );
  await approveViaDesk(row.report_desk_item_id as string);
  await phaseWhen(
    p.ref,
    'done with failures',
    (x) => x?.status === 'done_with_failures' && !!x.results_desk_item_id,
    240_000,
  );
  const f = await followups(p.ref);
  expect(f.map((x) => x.status)).toEqual(['failed', 'skipped']);
  expect(f[1]?.result_summary).toContain('follow-up 1 failed');
  expect(f[1]?.regression_card_ids).toEqual([]);
  const results = (await phase(p.ref))!;
  const item = (
    await q<any>('SELECT pinned, title FROM desk_items WHERE id=$1', [results.results_desk_item_id])
  )[0];
  expect(item.pinned).toBe(true);
  expect(item.title).toContain('1 failed');
  await page.goto('/desk');
  const art = page.getByRole('article', { name: /1 failed/ });
  await expect(art).toBeVisible();
  await expect(art.getByTestId('urgent-badge')).toBeVisible();
  await art.getByTestId('phase-ack').click();
  await expect(art).toHaveCount(0);
});

test('AC6: rejecting the follow-ups asks DevOps for nothing', async () => {
  const p = await newPhase('Phase 3: rejected', [
    { kind: 'deploy', targetId: localTargetId },
    { kind: 'regression', platform: 'web' },
  ]);
  const c = await createCard('Rejected phase card');
  await put(c.id, p.id);
  const row = await phaseWhen(
    p.ref,
    'waiting for approval',
    (x) => x?.status === 'awaiting_approval',
    240_000,
  );
  await page.goto('/desk');
  const item = page.getByRole('article', { name: new RegExp(`${p.ref} Phase 3: rejected is done`) });
  await expect(item).toBeVisible();
  await item.getByTestId('phase-reject').click();
  await expect(item).toHaveCount(0);
  await phaseWhen(p.ref, 'followups_rejected', (x) => x?.status === 'followups_rejected', 30_000);
  expect((await followups(p.ref)).map((x) => x.status)).toEqual(['cancelled', 'cancelled']);
  await new Promise((r) => setTimeout(r, 12_000));
  expect(
    (await q(`SELECT 1 FROM devops_requests WHERE requested_by_name LIKE $1`, [`Phase ${p.ref}%`])).length,
  ).toBe(0);
  const list = await (await api.get('/api/devops/requests')).json();
  expect(JSON.stringify(list)).not.toContain(p.ref);
  expect(row.report_desk_item_id).toBeTruthy();
});

test('AC7: a pushed branch counts once it is merged into the working branch; the runner then deletes it, locally and on the remote', async () => {
  const p = await newPhase('Phase 4: pushed branch', []);
  const c = await createCard('Pushed branch card', { completionAction: 'push_branch' });
  await put(c.id, p.id);
  const done = await waitFor(
    'the card pushed its branch',
    () => card(c.ref),
    (x) => x?.status === 'done' && !!x.finalize_result,
    240_000,
  );
  const branch = done.branch_name as string;
  expect(git(paths.origin, 'branch', '--list', branch).trim()).toContain(branch);

  // finalized, but not merged: the phase waits, and says so
  await new Promise((r) => setTimeout(r, 15_000));
  expect((await phase(p.ref))!.status).toBe('open');
  await page.goto('/p/PHS/phases/4');
  await expect(page.getByTestId(`member-${c.ref}`)).toContainText('waiting to be merged');

  // somebody merges it into main (as a reviewed pull request would)
  const clone = join(paths.vaults, 'phase-merge-clone');
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(paths.vaults, { recursive: true });
  git(paths.vaults, 'clone', paths.origin, clone);
  git(clone, 'merge', '--no-ff', '-m', 'Merge the pushed branch', `origin/${branch}`);
  git(clone, 'push', 'origin', 'main');

  await phaseWhen(
    p.ref,
    'complete',
    (x) => x?.status === 'reporting' || x?.status === 'awaiting_approval',
    120_000,
  );
  const merged = await waitFor(
    'merge verified',
    () => card(c.ref),
    (x) => !!x?.merged_into_working_at,
    60_000,
  );
  expect(merged.merged_into_working_at).not.toBeNull();
  expect(git(paths.toyClone, 'branch', '--list', branch).trim()).toBe('');
  expect(git(paths.origin, 'branch', '--list', branch).trim()).toBe('');
});
