import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept, storagePath } from '../support/api.ts';
import { pool, q, transitionsFor, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, MEMBER, OTHER, paths } from '../support/env.ts';
import { killRunner, startRunner } from '../support/runner.ts';

test.describe.configure({ mode: 'serial' });
test.use({ storageState: storagePath('member') });

let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works', 'It is tested'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ storageState: storagePath('member') })).newPage();
  api = await apiAs(MEMBER.email, MEMBER.password);
  const projects = (await (await api.get('/api/projects')).json()).projects;
  const toy = projects.find((p: { key: string }) => p.key === 'TOY');
  projectId = toy.id;
  repoId = (await (await api.get(`/api/projects/${projectId}`)).json()).repos[0].id;
});

test.afterAll(async () => {
  await pool.end();
});

/** Creates + specifies a card over the API (the UI form is exercised for TOY-1). */
async function createCard(title: string, mock?: Record<string, string[]>): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      fields: { ...SPEC, ...(mock ? { mock } : {}) },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  expect(body.missing ?? []).toEqual([]);
  return body.card.ref as string;
}

async function waitHanging(shiftId: string): Promise<void> {
  await waitFor(
    `mock shift ${shiftId} hanging`,
    async () => {
      try {
        return readFileSync(`${paths.runnerData}/logs/shifts/${shiftId}.jsonl`, 'utf8');
      } catch {
        return '';
      }
    },
    (log) => log.includes('mock hanging'),
    30_000,
  );
}

const column = (ref: string) => page.getByTestId(`card-tile-${ref}`);

async function openBoard(): Promise<void> {
  await page.goto('/p/TOY/board');
  await expect(page.getByTestId('board')).toBeVisible();
}

/** No card is ever held by two agents: replay card_transitions and check the claim holder. */
async function assertExclusiveClaims(refs: string[]): Promise<void> {
  for (const ref of refs) {
    let holder: string | null = null;
    for (const t of await transitionsFor(ref)) {
      if (t.to_status === 'claimed') {
        expect(holder, `${ref} claimed by ${t.agent_id} while held by ${holder}`).toBeNull();
        holder = t.agent_id;
      } else {
        holder = null;
      }
    }
  }
}

test('AC3: hire two builders and a reviewer (mock runtime); the hire form has no role limits', async () => {
  await page.goto('/agents');
  const hire = async (role: string, name: string, seniority?: string) => {
    await page.getByRole('button', { name: 'Hire agent' }).first().click();
    const form = page.getByRole('form', { name: 'Hire agent' });
    await form.getByLabel('Role', { exact: true }).selectOption({ label: role });
    if (seniority) await form.getByLabel('Seniority').selectOption(seniority);
    await form.getByLabel('Runtime').selectOption('mock');
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByRole('button', { name: 'Hire', exact: true }).click();
    await expect(page.getByTestId(`agent-${name}`)).toBeVisible();
  };
  await hire('Builder', 'Ada');
  await hire('Builder', 'Grace');
  await hire('Reviewer', 'Linus', 'senior');

  // M9 removed the first-run cap: the form offers every role and no limits are shown.
  await page.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = page.getByRole('form', { name: 'Hire agent' });
  await expect(form.getByRole('option', { name: 'Builder', exact: true })).toBeEnabled();
  await expect(page.getByTestId('hire-caps')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('AC4: create TOY-1 with all required fields and a mock script, then specify it', async () => {
  await page.goto('/cards/new');
  const form = page.getByRole('form', { name: 'New card' });
  await form.getByLabel('Title', { exact: true }).fill('Add the thing');
  await form.getByLabel('Repository').selectOption({ label: 'toy' });
  await form.getByLabel('Completion action').selectOption('push_branch');
  await form.getByLabel('Context', { exact: true }).fill(SPEC.context);
  await form.getByLabel('Requirements').fill(SPEC.requirements);
  await form.getByLabel('Acceptance criteria').fill(SPEC.acceptanceCriteria.join('\n'));
  await form.getByLabel('Affected areas').fill(SPEC.affectedAreas);
  await form.getByLabel('Constraints').fill(SPEC.constraints);
  await form.getByLabel('Test plan').fill(SPEC.testPlan);
  await form.getByLabel('Mock script').fill('{"review":["changes","ok"]}');
  await form.getByRole('button', { name: 'Specify', exact: true }).click();
  await expect(page).toHaveURL(/\/cards\/TOY-1$/);
  const row = (await q('SELECT status, stage, fields FROM cards WHERE ref=$1', ['TOY-1']))[0];
  expect(['queued', 'claimed']).toContain(row?.status);
  expect(row?.fields).toMatchObject({ mock: { review: ['changes', 'ok'] } });
});

test('AC4 (negative): an incomplete card cannot be specified; the UI lists what is missing', async () => {
  // Server-side check through the card page: a draft with only a title.
  const res = await api.post('/api/cards', {
    data: { projectId, title: 'Incomplete draft', cardType: 'feature' },
  });
  expect(res.status()).toBe(201);
  const ref = (await res.json()).card.ref as string;
  const direct = await api.post(`/api/cards/${ref}/specify`);
  expect(direct.status()).toBe(422);
  expect((await direct.json()).error.code).toBe('missing_fields');
  await page.goto(`/cards/${ref}`);
  await page.getByRole('button', { name: 'Specify', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Missing' })).toContainText('Requirements');
  // Creating with specify:true and missing fields saves a draft and reports what is missing.
  const partial = await api.post('/api/cards', {
    data: { projectId, title: 'Partial', cardType: 'feature', specify: true },
  });
  expect(partial.status()).toBe(201);
  expect((await partial.json()).missing.length).toBeGreaterThan(0);
  await api.post(`/api/cards/${ref}/cancel`, { data: { reason: 'e2e cleanup' } });
  await api.post(`/api/cards/${(await partial.json()).card.ref}/cancel`, { data: { reason: 'e2e cleanup' } });
});

test('AC5: TOY-1 goes In progress -> Review -> Rework -> Review -> Test with two build handoffs', async () => {
  await openBoard();
  // Live board: the tile appears in the In progress column with a builder, within 30 s, without reloading.
  await expect(page.getByTestId('column-In progress').getByTestId('card-tile-TOY-1')).toBeVisible({
    timeout: 30_000,
  });
  await expect(column('TOY-1').getByTestId('tile-assignee')).toBeVisible();
  await expect(page.getByTestId('column-Review').getByTestId('card-tile-TOY-1')).toBeVisible({
    timeout: 30_000,
  });
  // Rework: the bounced card is queued in the Rework column for a fraction of a second (the dispatcher hands it
  // straight back to the same builder), then shows in In progress carrying the rework-round badge.
  await expect(
    page.getByTestId('column-In progress').getByTestId('card-tile-TOY-1').getByTitle('Rework round'),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: '/tmp/aom-e2e-board-rework.png' });
  await expect(page.getByTestId('column-Review').getByTestId('card-tile-TOY-1')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('column-Test').getByTestId('card-tile-TOY-1')).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: '/tmp/aom-e2e-board-test-column.png' });

  const stages = (await transitionsFor('TOY-1')).map(
    (t) => `${t.from_stage ?? 'new'}>${t.to_stage}:${t.to_status}`,
  );
  // build -> review -> build (rework) -> review -> test, each hop through a claim.
  const hops = (await transitionsFor('TOY-1'))
    .filter((t) => t.from_stage && t.from_stage !== t.to_stage)
    .map((t) => `${t.from_stage}>${t.to_stage}`);
  expect(hops, stages.join(', ')).toEqual([
    'spec>build',
    'build>review',
    'review>build',
    'build>review',
    'review>test',
  ]);

  await page.goto('/cards/TOY-1');
  const handoffs = page.getByTestId('handoff');
  await expect(handoffs.filter({ hasText: 'build: handoff' })).toHaveCount(2);
  await expect(handoffs.filter({ hasText: 'review: changes' })).toHaveCount(1);
  await expect(handoffs.filter({ hasText: 'review: approve' })).toHaveCount(1);
  await expect(page.getByTestId('handoff-review').filter({ hasText: 'missed requirement' })).toBeVisible();
  // Same builder both times.
  const builders = await q<{ agent_id: string }>(
    `SELECT DISTINCT t.agent_id FROM card_transitions t JOIN cards c ON c.id=t.card_id
      WHERE c.ref='TOY-1' AND t.to_status='claimed' AND t.to_stage='build'`,
  );
  expect(builders).toHaveLength(1);

  // The card branch exists in the worktree with the mock commits.
  const card = (
    await q<{ branch_name: string; worktree_path: string }>(
      'SELECT branch_name, worktree_path FROM cards WHERE ref=$1',
      ['TOY-1'],
    )
  )[0];
  expect(card?.branch_name).toMatch(/^aom\/toy-1-/);
  await expect(page.getByText(card?.branch_name ?? '').first()).toBeVisible();
  expect(existsSync(card?.worktree_path ?? '/nonexistent')).toBeTruthy();
  const log = execFileSync('git', ['-C', card?.worktree_path ?? '', 'log', '--format=%s', 'main..HEAD'], {
    encoding: 'utf8',
  });
  expect(log).toContain('mock build round 1: TOY-1');
  expect(log).toContain('mock build round 2: TOY-1');
  const branches = execFileSync('git', ['-C', paths.toyClone, 'branch', '--list', 'aom/toy-1-*'], {
    encoding: 'utf8',
  });
  expect(branches).toContain('aom/toy-1-');
  await assertExclusiveClaims(['TOY-1']);
});

test('AC6: two cards specified at once are claimed by two different builders concurrently', async () => {
  const [a, b] = await Promise.all([createCard('Concurrent A'), createCard('Concurrent B')]);
  const claimed = await waitFor(
    'both cards claimed at once by different builders',
    () =>
      q<{ ref: string; claimed_by_agent_id: string | null }>(
        `SELECT ref, claimed_by_agent_id FROM cards WHERE ref = ANY($1) AND status='claimed'`,
        [[a, b]],
      ),
    (r) => r.length === 2,
    45_000,
  );
  expect(new Set(claimed.map((r) => r.claimed_by_agent_id)).size).toBe(2);
  await openBoard();
  await expect(page.getByTestId('column-In progress').getByTestId(`card-tile-${a}`)).toBeVisible();
  await expect(page.getByTestId('column-In progress').getByTestId(`card-tile-${b}`)).toBeVisible();
  await page.screenshot({ path: '/tmp/aom-e2e-board-concurrent.png' });

  // Let both finish their pipeline so the next tests start from an idle fleet.
  await waitFor(
    'both cards reach Test',
    () => q(`SELECT ref FROM cards WHERE ref = ANY($1) AND stage='test'`, [[a, b]]),
    (r) => r.length === 2,
    90_000,
  );
  await assertExclusiveClaims(['TOY-1', a, b]);
  // And across everything so far: no card has two holders at any time.
  const dup = await q(
    `SELECT card_id FROM card_transitions WHERE to_status='claimed' GROUP BY card_id, event_seq HAVING count(*) > 1`,
  );
  expect(dup).toHaveLength(0);
});

test('AC7a: killing the runner mid-shift and restarting it within the lease keeps the claim', async () => {
  const ref = await createCard('Survives a runner restart', { build: ['hang', 'ok'] });
  const before = await waitFor(
    'card claimed with a running shift',
    () =>
      q<{ claim_id: string; claimed_by_agent_id: string; claim_shift_id: string; status: string }>(
        `SELECT c.claim_id, c.claimed_by_agent_id, c.claim_shift_id, s.status FROM cards c JOIN shifts s ON s.id=c.claim_shift_id WHERE c.ref=$1 AND c.claim_id IS NOT NULL`,
        [ref],
      ),
    (r) => r[0]?.status === 'running',
  );
  // The mock records its attempt number early; wait until it is demonstrably hanging so the restart sees attempt 2.
  await waitHanging(before[0]?.claim_shift_id ?? '');
  killRunner('SIGKILL');
  startRunner();
  await waitFor(
    'card advanced to review by the same agent after the restart',
    () => q<{ stage: string }>('SELECT stage FROM cards WHERE ref=$1', [ref]),
    (r) => r[0]?.stage === 'review' || r[0]?.stage === 'test',
    60_000,
  );
  const trans = await transitionsFor(ref);
  // The claim was never released in between: the first transition after the claim is the handoff to review.
  const claimIdx = trans.findIndex((t) => t.to_status === 'claimed' && t.to_stage === 'build');
  expect(trans[claimIdx]?.agent_id).toBe(before[0]?.claimed_by_agent_id);
  expect(trans[claimIdx + 1]?.to_stage).toBe('review');
  const reasons = await q<{ reason: string }>(
    `SELECT payload->>'reason' AS reason FROM events WHERE type='ClaimReleased' AND payload->>'cardId' = (SELECT id::text FROM cards WHERE ref=$1)`,
    [ref],
  );
  expect(reasons.map((r) => r.reason)).not.toContain('runner_lost_shift');
  const shifts = await q(
    `SELECT id FROM shifts WHERE card_id=(SELECT id FROM cards WHERE ref=$1) AND stage='build'`,
    [ref],
  );
  expect(shifts).toHaveLength(1); // the same shift continued
});

test('AC8: firing a builder holding a card releases it and another builder claims it', async () => {
  const ref = await createCard('Fire the holder', { build: ['hang', 'ok'] });
  const first = await waitFor(
    'card claimed',
    () =>
      q<{ claimed_by_agent_id: string; name: string }>(
        `SELECT c.claimed_by_agent_id, a.name FROM cards c JOIN agents a ON a.id=c.claimed_by_agent_id WHERE c.ref=$1 AND c.claim_id IS NOT NULL`,
        [ref],
      ),
    (r) => r.length === 1,
  );
  // Wait for the observable precondition (the first shift is really running, hanging) instead of racing it.
  await waitFor(
    'the first shift is running',
    () =>
      q<{ status: string }>(
        `SELECT s.status FROM shifts s JOIN cards c ON c.id=s.card_id WHERE c.ref=$1 AND s.agent_id=$2 AND s.ended_at IS NULL`,
        [ref, first[0]?.claimed_by_agent_id],
      ),
    (r) => r.some((x) => x.status === 'running'),
    60_000,
  );
  await page.goto('/agents');
  await page.getByRole('button', { name: `Fire ${first[0]?.name}` }).click();
  await expect(page.getByTestId('fire-releases')).toContainText(ref);
  await page.getByRole('dialog').getByRole('button', { name: /fire/i }).last().click();
  const holder = await waitFor(
    'another builder holds the card or finished it',
    () =>
      q<{ agent_id: string | null }>(
        `SELECT t.agent_id FROM card_transitions t JOIN cards c ON c.id=t.card_id WHERE c.ref=$1 AND t.to_status='claimed' ORDER BY t.id`,
        [ref],
      ),
    (r) => r.length >= 2,
    60_000,
  );
  expect(holder[1]?.agent_id).not.toBe(first[0]?.claimed_by_agent_id);
  const released = await transitionsFor(ref);
  expect(
    released.some(
      (t) =>
        t.reason.toLowerCase().includes('retire') ||
        t.reason.toLowerCase().includes('fire') ||
        t.to_status === 'queued',
    ),
  ).toBeTruthy();
  await assertExclusiveClaims([ref]);
});

test("AC9: a second user sees none of the first user's projects, cards or agents (UI and API)", async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, OTHER);
  const other = await apiAs(OTHER.email, OTHER.password);
  expect((await (await other.get('/api/projects')).json()).projects).toEqual([]);
  expect((await (await other.get('/api/agents')).json()).agents).toEqual([]);
  expect((await (await other.get('/api/workstations')).json()).workstations).toEqual([]);
  const board = await other.get(`/api/board?projectId=${projectId}`);
  expect([403, 404]).toContain(board.status());
  expect([403, 404]).toContain((await other.get('/api/cards/TOY-1')).status());
  expect([403, 404]).toContain((await other.get(`/api/projects/${projectId}`)).status());

  const ctx = await browser.newContext({ storageState: undefined });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.getByLabel('Email').fill(OTHER.email);
  await p.getByLabel('Password').fill(OTHER.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await p.goto('/projects');
  await expect(p.getByText('TOY')).toHaveCount(0);
  await p.goto('/agents');
  await expect(p.getByText('No agents hired yet.')).toBeVisible();
  await expect(p.getByText('Ada')).toHaveCount(0);
  await p.goto('/cards/TOY-1');
  await expect(p.getByText('Add the thing')).toHaveCount(0);
  await ctx.close();
});

test('AC7b: runner killed and the server clock advanced 1 h requeues the card with the last handoff attached', async () => {
  const ref = await createCard('Lease expiry', { review: ['changes'], build: ['ok', 'hang'] });
  const hung = await waitFor(
    'second build shift running (after a review bounce)',
    () =>
      q<{ rework_round: number; status: string }>(
        `SELECT c.rework_round, c.status FROM cards c JOIN shifts s ON s.id=c.claim_shift_id AND s.status='running' WHERE c.ref=$1 AND c.stage='build'`,
        [ref],
      ),
    (r) => (r[0]?.rework_round ?? 0) >= 1,
    90_000,
  );
  expect(hung[0]?.status).toBe('claimed');
  const shiftNow = await q<{ claim_shift_id: string }>('SELECT claim_shift_id FROM cards WHERE ref=$1', [
    ref,
  ]);
  await waitHanging(shiftNow[0]?.claim_shift_id ?? '');
  killRunner('SIGKILL');
  const adv = await fetch(`${BASE_URL}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ advanceMs: 3_600_000 + 60_000 }),
  });
  expect(adv.ok).toBeTruthy();
  const row = await waitFor(
    'card requeued',
    () =>
      q<{ status: string; stage: string; claim_id: string | null }>(
        'SELECT status, stage, claim_id FROM cards WHERE ref=$1',
        [ref],
      ),
    (r) => r[0]?.status === 'queued',
    30_000,
  );
  expect(row[0]).toMatchObject({ stage: 'build', claim_id: null });
  const rel = await q<{ reason: string; last: string | null }>(
    `SELECT payload->>'reason' AS reason, payload->>'lastHandoffId' AS last FROM events
      WHERE type='ClaimReleased' AND payload->>'cardId'=(SELECT id::text FROM cards WHERE ref=$1) ORDER BY seq DESC LIMIT 1`,
    [ref],
  );
  expect(rel[0]?.reason).toBe('lease_expired');
  expect(rel[0]?.last).toBeTruthy();
  await page.goto(`/cards/${ref}`);
  await expect(page.getByTestId('thread')).toContainText(/last handoff/i);
  await expect(page.getByTestId('card-column')).toContainText('Rework'); // bounced once, so it sits in the Rework column
});
