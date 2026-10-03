import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, TESTER } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// M4: tester and bug loop (docs/PLAN.md M4 AC). One user, one runner (mock runtime), project TST on the toy repo.
// Refs are deterministic because the cards are created in order: see the comments at each test.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('testloop');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let projectId: string;
let repoId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the E2E tests',
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
const originLog = () => git(paths.origin, 'log', 'main', '--format=%s');
const originMain = () => git(paths.origin, 'rev-parse', 'main').trim();

interface CardRow {
  id: string;
  ref: string;
  stage: string;
  status: string;
  card_type: string;
  origin: string;
  rework_round: number;
  parent_card_id: string | null;
  worktree_card_id: string | null;
  original_builder_agent_id: string | null;
  risk_tier: string | null;
  claimed_by_agent_id: string | null;
  park_problem: string | null;
  env_parks: number;
  finalize_state: string | null;
  fields: Record<string, unknown>;
}
const card = async (ref: string) => (await q<CardRow>('SELECT * FROM cards WHERE ref=$1', [ref]))[0];
const waitCard = async (ref: string, what: string, pred: (c: CardRow | undefined) => boolean, ms = 90_000) =>
  (await waitFor(`${ref} ${what}`, () => card(ref), pred, ms)) as CardRow;
const atFinalize = (ref: string) =>
  waitCard(ref, 'at finalize', (c) => c?.stage === 'finalize' && c.status === 'queued');

async function createCard(
  title: string,
  opts: { mock?: Record<string, string[]>; fields?: Record<string, unknown>; completionAction?: string } = {},
): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: opts.completionAction ?? 'merge',
      fields: { ...SPEC, ...(opts.mock ? { mock: opts.mock } : {}), ...(opts.fields ?? {}) },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}

const deskItems = (subkind: string) =>
  q<{
    id: string;
    status: string;
    title: string;
    pinned: boolean;
    blocking: boolean;
    kind: string;
    card_id: string | null;
  }>(
    `SELECT id, status, title, pinned, blocking, kind, card_id FROM desk_items WHERE subkind=$1 ORDER BY created_at`,
    [subkind],
  );

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, TESTER);
  api = await apiAs(TESTER.email, TESTER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner, project TST on the toy repo, a builder, a senior reviewer and a tester', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Test Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({}, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'TST', name: 'Test loop project' } });
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

// TST-1 (holds the tester), TST-2 (feature, merge, small), TST-3 (its bug child), TST-4 (full-suite card), TST-5 (bug in Spec).
test('AC bottleneck: E2E work waits 5 min while every tester is busy -> one pinned desk alert; Hire tester opens a pre-filled form', async () => {
  const hold = await createCard('Holds the tester', { mock: { test: ['hang'] } });
  expect(hold).toBe('TST-1');
  await waitCard(
    hold,
    'claimed by the tester',
    (c) => c?.stage === 'test' && c.status === 'claimed',
    120_000,
  );
  const ref = await createCard('Add the thing', { mock: { test: ['fail', 'ok'], suite: ['fail'] } });
  expect(ref).toBe('TST-2');
  await waitCard(ref, 'waiting in test', (c) => c?.stage === 'test' && c.status === 'queued', 120_000);
  expect(await deskItems('tester_bottleneck')).toHaveLength(0);
  await q(`UPDATE cards SET queued_at = now() - interval '6 minutes' WHERE ref=$1`, [ref]);

  const alerts = await waitFor(
    'bottleneck alert',
    () => deskItems('tester_bottleneck'),
    (r) => r.length > 0,
    60_000,
  );
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ kind: 'alert', pinned: true, blocking: false, status: 'open' });
  // another pass does not add a second one
  await new Promise((r) => setTimeout(r, 12_000));
  expect(await deskItems('tester_bottleneck')).toHaveLength(1);

  await page.goto('/desk');
  const item = page.getByRole('article', { name: /waiting for a tester/ });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('urgent-badge')).toBeVisible();
  await page.screenshot({ path: join(paths.vaults, 'test-loop-bottleneck.png') });
  await item.getByTestId('hire-tester').click();
  await expect(page).toHaveURL(/\/agents\?hire=tester&projectId=/);
  // the first-run hire cap (one tester) refuses the hire itself; the form opens pre-filled
  const form = page.getByRole('form', { name: 'Hire agent' });
  await expect(form.getByLabel('Role', { exact: true })).toHaveValue('tester');
  await expect(form.getByLabel('Seniority')).toHaveValue('junior');
  await page.screenshot({ path: join(paths.vaults, 'test-loop-hire-form.png') });
  await page.keyboard.press('Escape');

  // free the tester: the held card is cancelled, the waiting one is claimed and the alert resolves itself
  const cancelled = await api.post(`/api/cards/${hold}/cancel`, { data: { reason: 'e2e: fixture done' } });
  expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
  await waitFor(
    'alert resolved',
    () => deskItems('tester_bottleneck'),
    (r) => r[0]?.status !== 'open',
    60_000,
  );
});

test('AC bug loop: tester fail -> linked bug card on the same branch for the original builder; parent waits, then re-enters Test and passes with evidence', async () => {
  const parent = await waitCard('TST-2', 'waiting on its bug card', (c) => c?.status === 'waiting');
  const child = (await card('TST-3'))!;
  expect(child).toMatchObject({
    card_type: 'bug',
    origin: 'test_failure',
    parent_card_id: parent.id,
    worktree_card_id: parent.id,
    original_builder_agent_id: parent.original_builder_agent_id,
  });
  const builder = await q<{ name: string }>('SELECT name FROM agents WHERE id=$1', [
    child.original_builder_agent_id,
  ]);
  expect(builder[0]?.name).toBe('Bo');

  // the bottleneck alert resolved itself once the tester took the work
  await waitFor(
    'alert resolved',
    () => deskItems('tester_bottleneck'),
    (r) => r[0]?.status !== 'open',
    60_000,
  );

  // the board shows Test (waiting on bug) with a link to the child
  await page.goto('/p/TST/board');
  const tile = page.getByTestId('card-tile-TST-2');
  await expect(tile.getByTestId('waiting-badge')).toBeVisible();
  await expect(page.getByTestId('waiting-on-link-TST-3')).toBeVisible();
  await page.screenshot({ path: join(paths.vaults, 'test-loop-waiting.png') });

  // after the bug card passes review the parent is back in the Test queue and passes
  await waitCard('TST-3', 'done', (c) => c?.status === 'done', 120_000);
  await atFinalize('TST-2');
  const resolved = await q(`SELECT 1 FROM events WHERE type='ChildCardResolved' AND payload->>'cardId'=$1`, [
    parent.id,
  ]);
  expect(resolved).toHaveLength(1);
  const runs = await q<{ result: string; kind: string }>(
    'SELECT result, kind FROM test_runs WHERE card_id=$1 ORDER BY created_at',
    [parent.id],
  );
  expect(runs).toEqual([
    { result: 'failed', kind: 'feature' },
    { result: 'passed', kind: 'feature' },
  ]);

  await page.goto('/cards/TST-2');
  const evidence = page.getByTestId('evidence-panel');
  await expect(evidence).toBeVisible();
  await expect(evidence.getByTestId('test-run')).toHaveCount(2);
  await expect(evidence.getByTestId('test-run').first()).toHaveAttribute('data-result', 'failed');
  await expect(evidence.getByTestId('test-run').last()).toHaveAttribute('data-result', 'passed');
  await expect(page.getByTestId('child-card-link-TST-3')).toBeVisible();
  await page.screenshot({ path: join(paths.vaults, 'test-loop-evidence.png') });
});

test('AC finalize merge (small): the runner merges to the working branch without the manager, the worktree goes, a full-suite card runs; its failure files a bug in Spec and a desk notice', async () => {
  const before = originMain();
  await page.goto('/cards/TST-2');
  const panel = page.getByTestId('finalize-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('finalize-approval-note')).toHaveCount(0);
  await expect(panel.getByTestId('finalize-action')).toHaveValue('merge');
  await panel.getByTestId('finalize-button').click();

  await waitCard('TST-2', 'done', (c) => c?.status === 'done');
  expect(originMain()).not.toBe(before);
  expect(originLog().split('\n')[0]).toMatch(/^Merge aom\/tst-2/);
  expect(git(paths.origin, 'show', 'main:aom-mock/TST-2.txt')).toContain('Add the thing');
  const fin = await q<{ payload: { action: string; resultRef: { mergeCommit: string } } }>(
    `SELECT payload FROM events WHERE type='CardFinalized' AND payload->>'cardId'=$1`,
    [(await card('TST-2'))!.id],
  );
  expect(fin[0]?.payload.resultRef.mergeCommit).toBe(originMain());

  // the worktree is removed afterwards (and the merged branch)
  const wt = join(HOME, 'worktrees', 'TST', 'TST-2');
  await waitFor(
    'worktree removed',
    async () => existsSync(wt),
    (e) => !e,
    30_000,
  );
  expect(git(paths.toyClone, 'branch', '--list', 'aom/tst-2*').trim()).toBe('');

  // a full-suite card was spawned for a tester; its (scripted) failure creates a bug card in Spec
  const suite = (await card('TST-4'))!;
  expect(suite).toMatchObject({ card_type: 'regression', origin: 'full_suite' });
  expect(suite.parent_card_id).toBe((await card('TST-2'))!.id);
  expect(suite.fields.suiteBranch).toBe('main');
  await waitCard('TST-4', 'done', (c) => c?.status === 'done');
  const bug = (await card('TST-5'))!;
  expect(bug).toMatchObject({ card_type: 'bug', stage: 'spec', status: 'draft', origin: 'full_suite' });
  const notices = await deskItems('bug_reported');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ kind: 'alert', blocking: false, status: 'open', card_id: bug.id });
  const blocked = await q(`SELECT ref FROM cards WHERE status IN ('blocked','waiting')`);
  expect(blocked).toEqual([]);
  expect((await card('TST-2'))!.status).toBe('done');
  const runs = await q<{ kind: string; result: string }>(
    'SELECT kind, result FROM test_runs WHERE card_id=$1',
    [suite.id],
  );
  expect(runs).toEqual([{ kind: 'full_suite', result: 'failed' }]);

  await page.goto('/desk');
  const item = page.getByRole('article', { name: /Full-suite failure/ });
  await expect(item).toBeVisible();
  await page.screenshot({ path: join(paths.vaults, 'test-loop-suite-notice.png') });
  await item.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(item).toHaveCount(0);
});

// TST-6 (large merge), TST-7 (its suite card)
test('AC finalize merge (large): waits for the manager on the desk; approving merges; the suite card runs green', async () => {
  const ref = await createCard('A large change');
  await atFinalize(ref);
  // the risk tier of a finished card is the manager's call (the builder diff of the mock is always small)
  const patched = await api.patch(`/api/cards/${ref}`, { data: { riskTier: 'large' } });
  expect(patched.ok(), await patched.text()).toBeTruthy();

  const before = originMain();
  await page.goto(`/cards/${ref}`);
  const panel = page.getByTestId('finalize-panel');
  await expect(panel.getByTestId('finalize-approval-note')).toBeVisible();
  await panel.getByTestId('finalize-button').click();
  await waitCard(ref, 'awaiting approval', (c) => c?.finalize_state === 'awaiting_approval');
  expect(originMain()).toBe(before);
  const approvals = await deskItems('large_merge');
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({ kind: 'approval', pinned: true, status: 'open' });
  await expect(panel).toHaveAttribute('data-state', 'awaiting_approval');

  await page.goto('/desk');
  const item = page.getByRole('article', { name: /Approve merge of TST-6/ });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Approve merge' }).click();
  await waitCard(ref, 'done', (c) => c?.status === 'done');
  expect(originMain()).not.toBe(before);
  expect(originLog().split('\n')[0]).toMatch(/^Merge aom\/tst-6/);
  const suite = await waitCard('TST-7', 'done', (c) => c?.status === 'done');
  expect(suite?.origin).toBe('full_suite');
  const runs = await q<{ result: string }>('SELECT result FROM test_runs WHERE card_id=$1', [suite!.id]);
  expect(runs).toEqual([{ result: 'passed' }]);
});

// TST-7
test('AC tester guard: a tester that edits a file outside the E2E globs gets its report rejected', async () => {
  const ref = await createCard('Tester misbehaves', { mock: { test: ['edit_outside_scope', 'ok'] } });
  const c = (await waitCard(ref, 'first tester shift ended with a violation', (x) => x?.stage === 'test'))!;
  const ended = await waitFor(
    'a tester shift with a guard violation',
    () =>
      q<{ payload: { guardViolations: Array<{ rule: string; detail: string }>; outcome: string } }>(
        `SELECT payload FROM events WHERE type='ShiftEnded' AND payload->>'cardId'=$1 AND jsonb_array_length(payload->'guardViolations') > 0`,
        [c.id],
      ),
    (r) => r.length > 0,
    90_000,
  );
  expect(ended[0]?.payload.guardViolations[0]?.rule).toBe('tester_edited_non_e2e');
  expect(ended[0]?.payload.guardViolations[0]?.detail).toContain('outside-scope.txt');
  // the rejected report never moved the card: the first test report is the passing retry
  const runs = await q('SELECT 1 FROM test_runs WHERE card_id=$1', [c.id]);
  const after = await atFinalize(ref);
  expect(after?.stage).toBe('finalize');
  expect(runs.length).toBeLessThanOrEqual(1);
});

// TST-8 (hangs in test), TST-9 (waits, then conflicts)
test('AC rebase conflict: changing the working branch so the card conflicts -> RebaseConflict, card in Rework, conflicted files listed, no agent resolves it', async () => {
  const hanging = await createCard('Holds the tester', { mock: { test: ['hang', 'ok'] } });
  await waitCard(
    hanging,
    'claimed by the tester',
    (c) => c?.stage === 'test' && c.status === 'claimed',
    120_000,
  );
  const ref = await createCard('Conflicts with main');
  await waitCard(
    ref,
    'queued for the busy tester',
    (c) => c?.stage === 'test' && c.status === 'queued',
    120_000,
  );

  // someone changes the working branch in the meantime
  const other = join(paths.vaults, 'conflict-clone');
  rmSync(other, { recursive: true, force: true });
  mkdirSync(paths.vaults, { recursive: true });
  git(paths.vaults, 'clone', paths.origin, other);
  writeFileSync(join(other, 'aom-mock', `${ref}.txt`), 'someone else wrote this first\n', { flag: 'w' });
  git(other, 'add', '-A');
  git(other, 'commit', '-m', `conflicting change for ${ref}`);
  git(other, 'push', 'origin', 'main');

  // free the tester: the conflicted card is next in the queue
  const rel = await api.post(`/api/cards/${hanging}/release`, { data: { reason: 'e2e: free the tester' } });
  expect(rel.ok(), await rel.text()).toBeTruthy();
  const c = (await card(ref))!;
  const ev = await waitFor(
    'RebaseConflict event',
    () =>
      q<{ payload: { stage: string; conflictedFiles: string[] } }>(
        `SELECT payload FROM events WHERE type='RebaseConflict' AND payload->>'cardId'=$1`,
        [c.id],
      ),
    (r) => r.length > 0,
    120_000,
  );
  expect(ev[0]?.payload.stage).toBe('test');
  expect(ev[0]?.payload.conflictedFiles).toEqual([`aom-mock/${ref}.txt`]);
  const t = await q<{ to_stage: string; to_status: string }>(
    `SELECT to_stage, to_status FROM card_transitions WHERE card_id=$1 AND reason='RebaseConflict'`,
    [c.id],
  );
  expect(t).toEqual([{ to_stage: 'build', to_status: 'queued' }]);
  expect((await card(ref))!.rework_round).toBeGreaterThanOrEqual(1);
  const thread = await (await api.get(`/api/cards/${ref}`)).json();
  const msg = thread.thread.find((m: { body: string }) => /Rebase onto/.test(m.body));
  expect(msg.body).toContain(`aom-mock/${ref}.txt`);
  // nothing resolved it silently: the working branch is exactly what the other person pushed
  expect(git(paths.origin, 'show', `main:aom-mock/${ref}.txt`)).toBe('someone else wrote this first\n');
  // stop the build -> review -> conflict loop of this fixture
  await api.post(`/api/cards/${ref}/cancel`, { data: { reason: 'e2e: fixture done' } });
  await api.post(`/api/cards/${hanging}/cancel`, { data: { reason: 'e2e: fixture done' } });
});

// TST-20 (app not deployed), TST-21 (docker missing)
test('AC test environment: app not deployed -> an aom devops request for the card and the card parks until it is done', async () => {
  const ref = await createCard('Needs the app', { fields: { mockEnv: 'app_not_deployed' } });
  const c = await waitCard(
    ref,
    'parked on a DevOps request',
    (x) => (x?.env_parks ?? 0) >= 1 || x?.stage === 'finalize',
  );
  const req = await waitFor(
    'devops request for the card',
    () =>
      q<{ status: string; requested_by_kind: string; summary: string }>(
        'SELECT status, requested_by_kind, summary FROM devops_requests WHERE card_id=$1',
        [c.id],
      ),
    (r) => r.length === 1 && r[0]?.status === 'done',
    90_000,
  );
  expect(req[0]?.requested_by_kind).toBe('system');
  expect(req[0]?.summary).toMatch(/start the app/i);
  const parked = await q(
    `SELECT 1 FROM events WHERE type='TestEnvironmentParked' AND payload->>'cardId'=$1`,
    [c.id],
  );
  expect(parked).toHaveLength(1);
  await atFinalize(ref);
});

test('AC test environment: Docker missing and not installable -> a hard stop on the desk as a blocker', async () => {
  const ref = await createCard('Needs docker', { fields: { mockEnv: 'docker_missing' } });
  const c = (await waitCard(ref, 'blocked', (x) => x?.status === 'blocked', 120_000))!;
  expect(await q('SELECT 1 FROM devops_requests WHERE card_id=$1', [c.id])).toHaveLength(0);
  const items = (await deskItems('test_environment')).filter((i) => i.card_id === c.id);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'escalation', blocking: true, pinned: true, status: 'open' });
  await page.goto('/desk');
  await expect(page.getByRole('article', { name: /cannot be tested: docker/i })).toBeVisible();
  await page.screenshot({ path: join(paths.vaults, 'test-loop-docker-blocker.png') });

  // the manager installs Docker by hand and resolves the blocker: the card returns to the Test queue
  mkdirSync(join(HOME, 'mock-state'), { recursive: true });
  writeFileSync(join(HOME, 'mock-state', 'env-ok-docker_missing'), 'ok\n');
  const res = await api.post(`/api/desk/${items[0]?.id}/resolve`, { data: { resolution: 'acknowledged' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await atFinalize(ref);
});

test('AC regression: the manager starts a web regression run from the board; a tester runs it', async () => {
  await page.goto('/p/TST/board');
  await page.getByTestId('regression-open').click();
  await page.getByTestId('regression-platform').selectOption('web');
  await page.getByTestId('regression-run').click();
  const created = page.getByTestId('regression-created');
  await expect(created).toBeVisible();
  const ref = ((await created.innerText()).match(/TST-\d+/) ?? [])[0] as string;
  expect(ref).toBeTruthy();
  const c = (await card(ref))!;
  expect(c).toMatchObject({ card_type: 'regression', origin: 'regression' });
  expect(c.fields.platform).toBe('web');
  await waitCard(ref, 'done', (x) => x?.status === 'done', 120_000);
  const runs = await q<{ kind: string; platform: string; result: string }>(
    'SELECT kind, platform, result FROM test_runs WHERE card_id=$1',
    [c.id],
  );
  expect(runs).toEqual([{ kind: 'regression', platform: 'web', result: 'passed' }]);
  const events = await q('SELECT 1 FROM events WHERE type=$1', ['RegressionRequested']);
  expect(events).toHaveLength(1);
});

test('AC regression schedule: a due regression schedule creates a regression card that a tester runs', async () => {
  const before = (await q<{ n: string }>(`SELECT count(*) AS n FROM cards WHERE origin='regression'`))[0]!.n;
  const created = await api.post('/api/schedules', {
    data: {
      projectId,
      name: 'Nightly regression',
      kind: 'regression',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      cardTemplate: { title: 'Nightly regression', fields: { platform: 'web' } },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const s = (await created.json()) as { id: string; nextFireAt: string };
  try {
    const clockRes = await fetch(`${BASE_URL}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ advanceMs: 0 }),
    });
    const now = new Date(((await clockRes.json()) as { now: string }).now).getTime();
    const advance = Math.max(new Date(s.nextFireAt).getTime() - now + 2000, 1);
    const adv = await fetch(`${BASE_URL}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ advanceMs: advance }),
    });
    expect(adv.ok).toBeTruthy();
    const cards = await waitFor(
      'the scheduled regression card',
      () => q<CardRow>(`SELECT * FROM cards WHERE origin='regression' ORDER BY number DESC`),
      (r) => r.length === Number(before) + 1,
      30_000,
    );
    const c = cards[0]!;
    expect(c).toMatchObject({ card_type: 'regression', stage: 'test' });
    expect(c.fields.platform).toBe('web');
    expect(
      (await q<{ scheduled: boolean }>('SELECT scheduled FROM cards WHERE id=$1', [c.id]))[0]?.scheduled,
    ).toBe(true);
    await waitCard(c.ref, 'done', (x) => x?.status === 'done', 120_000);
    const runs = await q<{ kind: string; result: string }>(
      'SELECT kind, result FROM test_runs WHERE card_id=$1',
      [c.id],
    );
    expect(runs).toEqual([{ kind: 'regression', result: 'passed' }]);
  } finally {
    await api.delete(`/api/schedules/${s.id}`);
  }
});
