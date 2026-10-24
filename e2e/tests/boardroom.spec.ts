import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, BOARDER, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';

// Boardroom (phase C): the whole path with the mock runtime and no Claude. The mock personas answer in their own voice and the
// mock Chair chooses speakers, flags convergence and pauses for a decision through the real `aom board` verbs. One user, one
// runner (mock). The topic carries two markers the mock Chair reads: [[decide]] (pause at a decision point) and [[converge]]
// (flag early agreement after round 1).
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('boardroom');
let page: Page;
let api: APIRequestContext;
let sessionUrl = '';

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, BOARDER);
  api = await apiAs(BOARDER.email, BOARDER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner that announces the board verbs', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Boardroom Box', HOME);
  // slow enough that the sealed first round can be seen
  startRunner({ AOM_MOCK_STEP_MS: '1200', AOM_MOCK_CHAT_TOKEN_MS: '15' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  // the analyst who facilitates the Discovery session that "Pull into PRD" starts (personas run on the chosen models; the
  // facilitator is an agent here, on the mock runtime)
  const hire = await api.post('/api/agents', {
    data: { name: 'Ana', roleKey: 'analyst', seniority: 'senior', workstationId: ws[0].id, runtime: 'mock' },
  });
  expect(hire.status(), await hire.text()).toBe(201);
  await waitFor(
    'the runner announces the board verbs',
    async () =>
      (
        await q<any>('SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1', [ws[0].id])
      )[0]?.capabilities,
    (c) => Array.isArray(c) && c.includes('board-verbs:1'),
    30_000,
  );
});

test('the owner starts a boardroom: the cast, the format and the models, and round 1 is sealed until everyone has answered', async () => {
  await page.goto('/boardroom');
  await expect(page.getByText('No boardrooms yet')).toBeVisible();
  await page.getByTestId('new-boardroom').click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Topic')
    .fill('Should we launch a pilot with our first customer? [[decide]] [[converge]]');
  await dialog.getByLabel('Brief (optional)').fill('We have one friendly customer and eight weeks.');
  await dialog.getByLabel('Format').selectOption('pre_mortem');
  // the Optimist and the Devil's Advocate are fixed seats: always in the cast, locked
  await expect(dialog.getByTestId('fixed-seat-optimist')).toBeVisible();
  await expect(dialog.getByTestId('fixed-seat-devils-advocate')).toBeVisible();
  await expect(dialog.getByTestId('start-boardroom')).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'User Advocate' }).check();
  await dialog.getByRole('checkbox', { name: 'Cost Hawk' }).check();
  await dialog.getByLabel('Name', { exact: true }).fill('Regulator');
  await dialog
    .getByLabel('Brief', { exact: true })
    .fill('A cautious compliance officer who asks what could get us fined');
  await dialog.getByTestId('add-adhoc').click();
  await expect(dialog.getByRole('list', { name: 'Chosen cast' })).toContainText('Regulator');
  await expect(dialog.getByTestId('cast-counter')).toContainText('3');
  await dialog.getByLabel('Round cap').selectOption('6');
  await dialog.getByLabel('Cost limit in USD (optional)').fill('25');
  for (const l of ['Personas run on', 'The Chair runs on', 'Minutes are written by'])
    await dialog.getByLabel(l).selectOption({ label: 'Mock: Mock' });
  await dialog.getByTestId('start-boardroom').click();
  await expect(page).toHaveURL(/\/boardroom\/[0-9a-f-]{36}$/);
  sessionUrl = page.url();
  // sealed: nobody's words are shown, only how many answers are in
  const sealed = page.getByTestId('sealed-round');
  await expect(sealed).toBeVisible({ timeout: 30_000 });
  await expect(sealed).toContainText('answers are in');
  await expect(page.getByTestId('board-turn')).toHaveCount(0);
  await page.screenshot({ path: `${paths.vaults}/boardroom-sealed.png`, fullPage: true });
  // revealed together
  await expect(page.getByTestId('board-turn')).toHaveCount(5, { timeout: 120_000 });
  await expect(sealed).toHaveCount(0);
  await expect(page.getByText('All the first answers are in')).toBeVisible();
  await expect(page.getByTestId('round-separator').first()).toContainText(
    'Round 1 of 6 · Everyone answers on their own',
  );
  await expect(page.locator('[data-seat="devils-advocate"]')).toContainText('A year on, it failed because');
  // the sticky notes the seats added are on the whiteboard
  await expect(page.getByTestId('column-risks')).toContainText('Adoption is assumed');
  await page.screenshot({ path: `${paths.vaults}/boardroom-revealed.png`, fullPage: true });
});

test('the Chair stops at a decision point; the owner @mentions a seat and decides', async () => {
  const card = page.getByTestId('decision-card').first();
  await expect(card).toContainText('The Chair needs your decision', { timeout: 90_000 });
  await expect(page.getByTestId('waiting-for')).toContainText('decision');
  // mention a seat while the Chair waits: it speaks first in the next round
  const box = page.getByPlaceholder(/Decide above/);
  await box.fill('What does this cost us? @cost-h');
  await page.getByTestId('mention-cost-hawk').click();
  await expect(box).toHaveValue('What does this cost us? @cost-hawk ');
  await page.getByRole('button', { name: /send/i }).click();
  await expect(page.getByText('What does this cost us? @cost-hawk')).toBeVisible();
  await page.screenshot({ path: `${paths.vaults}/boardroom-decision.png`, fullPage: true });
  await card.getByTestId('decision-option-o2').click();
  await card.getByLabel('Your decision').fill('with ten paying users');
  await card.getByTestId('decide').click();
  await expect(page.getByTestId('decision-card').first()).toContainText('You decided', { timeout: 30_000 });
  await expect(page.getByTestId('column-decisions')).toContainText('Prove demand first', { timeout: 30_000 });
});

test('the next round is a dissent round led by the mentioned seat, and a disagreement is recorded', async () => {
  const seps = page.getByTestId('round-separator');
  await expect(seps.nth(1)).toContainText('Round 2 of 6 · Dissent round', { timeout: 120_000 });
  const picks = page.getByTestId('chair-picks').first();
  await expect(picks).toContainText('Chair picks: Cost Hawk');
  await expect(page.getByTestId('chair-status')).toContainText('Chair picks');
  // the speakers of round 2 answer one after the other
  await expect(page.locator('[data-seat="cost-hawk"]')).toHaveCount(2, { timeout: 120_000 });
  const round = (await q<any>(`SELECT kind, source, speakers FROM board_rounds WHERE round=2`))[0];
  expect(round).toMatchObject({ kind: 'dissent', source: 'chair' });
  expect(round.speakers[0].name).toBe('Cost Hawk');
  expect(round.speakers.length).toBeLessThanOrEqual(3);
  await page.screenshot({ path: `${paths.vaults}/boardroom-dissent.png`, fullPage: true });
});

test('the owner works the whiteboard: add, vote, move and merge', async () => {
  const board = page.getByTestId('whiteboard');
  await board.getByLabel('New ideas note').fill('Pilot with one friendly partner');
  await board.getByRole('button', { name: 'Add to Ideas' }).click();
  await expect(page.getByTestId('column-ideas')).toContainText('Pilot with one friendly partner');
  const mine = page
    .getByTestId('column-ideas')
    .getByTestId('board-note')
    .filter({ hasText: 'Pilot with one friendly partner' });
  await mine.getByTestId('vote-note').click();
  await expect(mine.getByTestId('vote-note')).toHaveAttribute('aria-pressed', 'true');
  await mine.getByLabel('Move to').selectOption('decisions');
  await expect(page.getByTestId('column-decisions')).toContainText('Pilot with one friendly partner');
  // merge two notes of the decisions column into one
  await board.getByTestId('merge-mode').click();
  const notes = page.getByTestId('column-decisions').getByTestId('board-note');
  await notes.nth(0).getByLabel('Select note to merge').check();
  await notes.nth(1).getByLabel('Select note to merge').check();
  await board.getByTestId('merge-selected').click();
  await expect(page.getByTestId('column-decisions').getByTestId('board-note')).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('column-decisions')).toContainText('Merged:');
  const merged = (
    await q<any>(`SELECT votes, merged_from FROM board_notes WHERE col='decisions' AND removed_at IS NULL`)
  )[0];
  expect(merged.votes.length).toBe(1);
  await expect(page.getByTestId('meter-cost')).not.toContainText('$0.00');
  await expect(page.getByTestId('meter-estimate')).toContainText('speaker');
});

test('ending the session writes the minutes; Pull into PRD opens a seeded Discovery session', async () => {
  await page.getByTestId('end-session').click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('This session is over')).toBeVisible({ timeout: 120_000 });
  const body = page.getByTestId('minutes-body');
  await expect(body).toContainText('Positions', { timeout: 30_000 });
  await expect(body).toContainText('Unresolved disagreements');
  await expect(body).toContainText('Whiteboard');
  await expect(body).toContainText('Move fast with a pilot or prove demand first');
  await page.screenshot({ path: `${paths.vaults}/boardroom-minutes.png`, fullPage: true });
  const doc = (await q<any>(`SELECT kind, status, title FROM documents WHERE kind='minutes'`))[0];
  expect(doc).toMatchObject({ kind: 'minutes', status: 'draft' });
  await page.getByTestId('pull-into-prd').click();
  await expect(page).toHaveURL(/\/discovery\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId('phase-capture')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('panel-decisions')).toContainText('Prove demand first', { timeout: 30_000 });
  await expect(page.getByTestId('session-drafts').getByTestId('doc-prd')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('session-drafts').getByTestId('document-text')).toContainText(
    'Boardroom background',
  );
  await expect(page.getByText('I read the boardroom minutes')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${paths.vaults}/boardroom-prd.png`, fullPage: true });
  await page.goto(sessionUrl);
  await expect(page.getByTestId('open-prd-session')).toBeVisible();
  await page.goto('/boardroom');
  const row = page.getByTestId('boardroom-row').first();
  await expect(row).toContainText('Over');
  await expect(row).toContainText('Pre-mortem');
});

test('on a phone the boardroom is three tabs', async ({ browser }) => {
  const ctx = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 390, height: 844 },
  });
  const phone = await ctx.newPage();
  await phone.goto(sessionUrl);
  await expect(phone.getByRole('tab', { name: 'Conversation' })).toBeVisible();
  await phone.screenshot({ path: `${paths.vaults}/boardroom-phone.png` });
  await phone.getByRole('tab', { name: /Whiteboard/ }).click();
  await expect(phone.getByTestId('whiteboard')).toBeVisible();
  await phone.getByRole('tab', { name: 'Minutes' }).click();
  await expect(phone.getByTestId('minutes-panel')).toBeVisible();
  await phone.screenshot({ path: `${paths.vaults}/boardroom-phone-minutes.png` });
  await ctx.close();
});
