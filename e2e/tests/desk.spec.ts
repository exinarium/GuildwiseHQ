import { existsSync, readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, storagePath } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { MEMBER, OTHER, paths } from '../support/env.ts';
import { startRunner } from '../support/runner.ts';

// M2: decision desk, questions and ledger. Runs after core-loop, which leaves the runner killed and the server
// clock one hour ahead; the builders Ada and Grace and the reviewer Linus are still hired.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: storagePath('member') });

let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;

const SPEC = {
  context: 'The toy project needs a decision.',
  requirements: 'Ask the manager, then build.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ storageState: storagePath('member') })).newPage();
  api = await apiAs(MEMBER.email, MEMBER.password);
  const projects = (await (await api.get('/api/projects')).json()).projects;
  projectId = projects.find((p: { key: string }) => p.key === 'TOY').id;
  repoId = (await (await api.get(`/api/projects/${projectId}`)).json()).repos[0].id;
  // core-loop ended with the runner killed; bring it back (slow chat tokens so streaming is observable).
  startRunner({ AOM_MOCK_CHAT_TOKEN_MS: '150' });
});

test.afterAll(async () => {
  await pool.end();
});

async function createCard(
  title: string,
  mock?: Record<string, string[]>,
  extra: Record<string, unknown> = {},
  specify = true,
): Promise<{ ref: string; id: string }> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      fields: { ...SPEC, ...(mock ? { mock } : {}) },
      specify,
      ...extra,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { ref: body.card.ref as string, id: body.card.id as string };
}

const cardRow = async (ref: string) =>
  (await q<any>('SELECT id, status, stage, claim_id FROM cards WHERE ref=$1', [ref]))[0];
const deskItem = (title: string) => page.getByRole('article', { name: title });

test('AC1: a blocking question parks the card in Blocked, frees the builder, and the desk shows everything', async () => {
  const first = await createCard('Needs a decision', { build: ['question', 'ok'] });
  await waitFor(
    'card blocked',
    () => cardRow(first.ref),
    (r) => r?.status === 'blocked',
    90_000,
  );
  const blocked = await cardRow(first.ref);
  expect(blocked.claim_id).toBeNull();
  const released = await q<any>(
    `SELECT payload->>'reason' AS reason FROM events WHERE type='ClaimReleased' AND payload->>'cardId'=$1 ORDER BY seq DESC LIMIT 1`,
    [blocked.id],
  );
  expect(released[0]?.reason).toBe('question');

  // The builders are not stuck on it: the next card goes through while the question waits.
  const next = await createCard('Next card while blocked');
  await waitFor(
    'next card reaches review',
    () => cardRow(next.ref),
    (r) => ['review', 'test'].includes(r?.stage),
    90_000,
  );

  await page.goto('/desk');
  const item = deskItem(`Mock question for ${first.ref}?`);
  await expect(item).toBeVisible();
  await expect(item.getByTestId('asked-by')).toContainText('builder');
  await expect(item.getByTestId('asked-by')).toContainText(/Ada|Grace/);
  await expect(item.getByTestId('item-card')).toContainText(first.ref);
  await expect(item.getByTestId('item-doing')).toContainText('mock build');
  await expect(item.getByRole('radio', { name: /yes/ })).toBeChecked(); // the recommended default is preselected
  await expect(item.getByRole('radio', { name: /no/ })).not.toBeChecked();
  await expect(item.getByText('Recommended')).toBeVisible();
  await expect(item.getByText('Blocking', { exact: true })).toBeVisible();
  await expect(item.getByTestId('affected-count')).toContainText('Affects 1 card');
  await expect(item.getByTestId('urgent-badge')).toBeVisible();
  await expect(page.getByTestId('desk-badge')).toBeVisible();
  await page.screenshot({ path: '/tmp/aom-e2e-desk.png', fullPage: true });

  // Blocked column + the blocker link on the card.
  await page.goto('/p/TOY/board');
  await expect(page.getByTestId('column-Blocked').getByTestId(`card-tile-${first.ref}`)).toBeVisible();
  await page.goto(`/cards/${first.ref}`);
  const link = page
    .getByTestId('card-blockers')
    .getByRole('link', { name: `Mock question for ${first.ref}?` });
  await link.click();
  await expect(page).toHaveURL(/\/desk#desk-item-/);
  await expect(deskItem(`Mock question for ${first.ref}?`)).toBeInViewport();
  test.info().annotations.push({ type: 'card', description: first.ref });
});

test('AC2: answering writes QuestionAnswered + LedgerEntryAdded, unblocks the card, and the next shift prompt has the answer', async () => {
  await page.goto('/desk');
  const ref = (await q<any>(`SELECT ref FROM cards WHERE status='blocked' ORDER BY number LIMIT 1`))[0]
    .ref as string;
  const item = deskItem(`Mock question for ${ref}?`);
  await item.getByRole('button', { name: 'Answer' }).click();
  await expect(item).toHaveCount(0); // gone from the open list once answered

  const events = await q<any>(
    `SELECT e.type FROM events e WHERE e.type IN ('QuestionAnswered','LedgerEntryAdded') AND e.seq >= (SELECT max(seq) FROM events WHERE type='QuestionAnswered' AND payload->>'deskItemId' IN (SELECT id::text FROM desk_items WHERE card_id=(SELECT id FROM cards WHERE ref=$1))) ORDER BY e.seq`,
    [ref],
  );
  expect(events.map((e) => e.type).slice(0, 2)).toEqual(['QuestionAnswered', 'LedgerEntryAdded']);
  const entry = (
    await q<any>(
      `SELECT scope, title, body FROM ledger_entries WHERE card_id=(SELECT id FROM cards WHERE ref=$1)`,
      [ref],
    )
  )[0];
  expect(entry).toMatchObject({ scope: 'decision' });
  expect(entry.body).toContain('Answer: yes');

  // Re-queued, picked up again (second build shift) and its progress log shows the ledger entry it was given.
  await waitFor(
    'card moves on after the answer',
    () => cardRow(ref),
    (r) => ['review', 'test'].includes(r?.stage),
    90_000,
  );
  const shifts = await q<any>(
    `SELECT progress_tail FROM shifts WHERE card_id=(SELECT id FROM cards WHERE ref=$1) AND stage='build' ORDER BY started_at`,
    [ref],
  );
  expect(shifts.length).toBe(2);
  const log = (s: any) => (s.progress_tail as Array<{ text: string }>).map((p) => p.text).join('\n');
  expect(log(shifts[0])).toContain('mock ledger: none');
  expect(log(shifts[1])).toContain(`Question: Mock question for ${ref}?`);
  expect(log(shifts[1])).toContain('Answer: yes');

  // The ledger page has it (searchable).
  await page.goto('/ledger');
  await page.getByLabel('Search', { exact: true }).fill('mock question');
  await expect(
    page.getByTestId('ledger-entry').filter({ hasText: `Mock question for ${ref}?` }),
  ).toBeVisible();
  await expect(page.getByTestId('ledger-entry').first()).toHaveAttribute('data-scope', 'decision');
  // Answered items stay visible as closed.
  await page.goto('/desk');
  await page.getByText(/Answered and closed/).click();
  await expect(page.getByTestId('desk-closed')).toContainText(`Mock question for ${ref}?`);
});

test('AC3: a standing order added on the desk is in the instructions of the next shift of every agent', async () => {
  await page.goto('/desk');
  await page.getByRole('button', { name: 'Add to ledger' }).first().click();
  const form = page.getByRole('form', { name: 'Add to ledger' });
  await form.getByLabel('Title').fill('E2E: never push to main');
  await form.getByLabel('Text').fill('Agents never push to the main branch.');
  await form.getByRole('button', { name: 'Add to ledger' }).click();
  await expect(form.getByText('Added to the ledger.')).toBeVisible();

  const a = await createCard('Standing order A');
  const b = await createCard('Standing order B');
  await waitFor(
    'both cards reach test',
    () => q(`SELECT ref FROM cards WHERE ref = ANY($1) AND stage='test'`, [[a.ref, b.ref]]),
    (r) => r.length === 2,
    120_000,
  );
  // Every agent that worked a shift after the order was added got it, whatever its role.
  const agents = await q<any>(
    `SELECT DISTINCT s.agent_id, ag.name, ag.role_key FROM shifts s JOIN agents ag ON ag.id=s.agent_id
      WHERE s.started_at > (SELECT created_at FROM ledger_entries WHERE title='E2E: never push to main')`,
  );
  expect(agents.map((x) => x.role_key)).toEqual(expect.arrayContaining(['builder', 'reviewer']));
  for (const ag of agents) {
    const file = `${paths.runnerData}/agents/${ag.agent_id}/claude/CLAUDE.md`;
    expect(existsSync(file), file).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text, `${ag.name}'s instructions`).toContain('E2E: never push to main');
    expect(text).toContain('Agents never push to the main branch.');
  }
  const progress = await q<any>(
    `SELECT progress_tail FROM shifts WHERE card_id IN (SELECT id FROM cards WHERE ref = ANY($1)) AND stage='build'`,
    [[a.ref, b.ref]],
  );
  expect(progress.length).toBeGreaterThanOrEqual(2);
  for (const s of progress) {
    expect((s.progress_tail as Array<{ text: string }>).map((p) => p.text).join('\n')).toContain(
      'E2E: never push to main',
    );
  }
});

test('AC4: asking something the ledger already answers shows the matches on the desk item', async () => {
  const c = await createCard('Dedup question', { build: ['question', 'ok'] });
  await waitFor(
    'card blocked',
    () => cardRow(c.ref),
    (r) => r?.status === 'blocked',
    90_000,
  );
  await page.goto('/desk');
  const item = deskItem(`Mock question for ${c.ref}?`);
  await expect(item.getByTestId('dedup-entries')).toContainText('The ledger already has similar entries');
  await expect(item.getByTestId('dedup-entries')).toContainText('Mock question for');
  const raised = await q<any>(
    `SELECT payload->'dedupLedgerIds' AS ids FROM events WHERE type='QuestionRaised' AND payload->>'cardId'=$1`,
    [(await cardRow(c.ref)).id],
  );
  expect(raised[0]?.ids.length).toBeGreaterThan(0);
});

test('AC5: the desk is sorted pinned, blocking, affected-card count, then age; urgent items carry a badge', async () => {
  // P: older, 1 card. X: younger but holds up a dependent card, so it affects 2 and sorts first.
  const p = await createCard('Sort P', { build: ['question', 'ok'] });
  await waitFor(
    'P blocked',
    () => cardRow(p.ref),
    (r) => r?.status === 'blocked',
    90_000,
  );
  const x = await createCard('Sort X', { build: ['question', 'ok'] });
  const xRow = await cardRow(x.ref);
  await createCard('Sort Y depends on X', undefined, { dependencies: [xRow.id] }, false);
  await waitFor(
    'X blocked',
    () => cardRow(x.ref),
    (r) => r?.status === 'blocked',
    90_000,
  );

  await page.goto('/desk');
  const list = page.getByTestId('desk-list');
  await expect(deskItem(`Mock question for ${x.ref}?`)).toBeVisible();
  const titles = await list.getByRole('heading', { level: 2 }).allInnerTexts();
  const idx = (ref: string) => titles.indexOf(`Mock question for ${ref}?`);
  expect(idx(x.ref), titles.join(' | ')).toBeGreaterThanOrEqual(0);
  expect(idx(x.ref)).toBeLessThan(idx(p.ref)); // bigger blast radius first
  await expect(deskItem(`Mock question for ${x.ref}?`).getByTestId('affected-count')).toContainText(
    'Affects 2 cards',
  );
  // Every open item here is blocking and pinned: all carry the badge, and all are ahead of anything non-blocking.
  const badges = await list.getByTestId('urgent-badge').count();
  expect(badges).toBe(await list.getByRole('article').count());
  // Same order as the API.
  const apiItems = (await (await api.get('/api/desk')).json()).items as Array<{
    title: string;
    urgent: boolean;
  }>;
  expect(apiItems.map((i) => i.title)).toEqual(titles);
  expect(apiItems.every((i) => i.urgent)).toBe(true);
  await page.screenshot({ path: '/tmp/aom-e2e-desk-sorted.png', fullPage: true });
});

test('AC6: owner_only - a member sees the item read-only and cannot answer; no notifications exist', async ({
  browser,
}) => {
  const item = (await (await api.get('/api/desk')).json()).items[0] as {
    id: string;
    title: string;
    canAnswer: boolean;
  };
  expect(item.canAnswer).toBe(true);
  // Fixture membership (full sharing arrives in M3): OTHER becomes an active manager of TOY.
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, role, status, joined_at)
     SELECT $1, id, 'manager', 'active', now() FROM users WHERE email=$2`,
    [projectId, OTHER.email],
  );
  try {
    const other = await apiAs(OTHER.email, OTHER.password);
    const view = (await (await other.get('/api/desk')).json()).items.find(
      (i: { id: string }) => i.id === item.id,
    );
    expect(view).toMatchObject({ canAnswer: false, decisionPolicy: 'owner_only' });
    const denied = await other.post(`/api/desk/${item.id}/answer`, { data: { answer: 'nope' } });
    expect(denied.status()).toBe(403);

    const ctx = await browser.newContext({ storageState: undefined });
    const p = await ctx.newPage();
    await p.goto('/login');
    await p.getByLabel('Email').fill(OTHER.email);
    await p.getByLabel('Password').fill(OTHER.password);
    await p.getByRole('button', { name: 'Sign in' }).click();
    await expect(p.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await p.goto('/desk');
    const card = p.getByRole('article', { name: item.title });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('read-only')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Answer' })).toHaveCount(0);
    await ctx.close();
  } finally {
    await pool.query(
      `DELETE FROM project_members WHERE project_id=$1 AND role='manager' AND user_id=(SELECT id FROM users WHERE email=$2)`,
      [projectId, OTHER.email],
    );
  }
  // No email goes out for urgent items: nothing was mailed to the member about the desk.
  const mail = await fetch(
    `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${MEMBER.email} subject:desk`)}`,
  );
  expect(((await mail.json()) as { messages?: unknown[] }).messages ?? []).toHaveLength(0);
});

test('cleanup: answer what is left so the next spec starts from an idle fleet', async () => {
  const items = (await (await api.get('/api/desk')).json()).items as Array<{ id: string }>;
  for (const i of items) {
    const res = await api.post(`/api/desk/${i.id}/answer`, { data: { answer: 'yes' } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  await waitFor(
    'no blocked cards left',
    () => q(`SELECT 1 FROM cards WHERE status='blocked'`),
    (r) => r.length === 0,
    30_000,
  );
});
