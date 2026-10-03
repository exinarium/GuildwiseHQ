import { expect, type Page, test } from '@playwright/test';
import { apiAs, storagePath } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { MEMBER } from '../support/env.ts';
import { killRunner, startRunner } from '../support/runner.ts';

// M2: chat with an agent from the desk. Streams through the runner on the agent's workstation (mock adapter echo);
// an offline workstation is reported on the spot and nothing is queued.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: storagePath('member') });

let page: Page;
let threadId = '';

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ storageState: storagePath('member') })).newPage();
});
test.afterAll(async () => {
  await pool.end();
});

const reviewerName = 'Linus';
const messages = (id: string) =>
  q<any>(
    `SELECT author_kind, kind, body, data FROM thread_messages WHERE thread_id=$1 ORDER BY created_at, event_seq`,
    [id],
  );

async function openChat() {
  await page.goto('/desk');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  return page.getByRole('dialog', { name: 'Chat' });
}

test('AC1: chat with an agent streams tokens to the browser and saves the conversation to a thread', async () => {
  const drawer = await openChat();
  await drawer.getByLabel('Agent').selectOption({ label: `${reviewerName} (reviewer)` });
  await drawer.getByRole('button', { name: 'Start chat' }).click();
  await expect(drawer.getByTestId('chat-panel')).toBeVisible();
  await expect(drawer.getByTestId('chat-offline')).toHaveCount(0);

  await drawer.getByLabel('Message').fill('hello there');
  await drawer.getByRole('button', { name: 'Send' }).click();
  // Tokens arrive one at a time: a partial reply is visible before the final message lands.
  const streaming = drawer.getByTestId('chat-streaming');
  await expect(streaming).toContainText('[mock]', { timeout: 30_000 });
  await expect(streaming).not.toContainText('(turn 1)');
  await page.screenshot({ path: '/tmp/aom-e2e-chat-streaming.png' });
  await expect(drawer.getByTestId('chat-message').last()).toContainText(
    '[mock] Linus heard: hello there (turn 1)',
    {
      timeout: 30_000,
    },
  );
  await expect(streaming).toHaveCount(0);

  const thread = (
    await q<any>(`SELECT id FROM threads WHERE kind='chat' ORDER BY created_at DESC LIMIT 1`)
  )[0];
  threadId = thread.id;
  const saved = await messages(threadId);
  expect(saved.map((m) => [m.author_kind, m.kind, m.body])).toEqual([
    ['user', 'chat', 'hello there'],
    ['agent', 'chat', '[mock] Linus heard: hello there (turn 1)'],
  ]);
  const shift = (
    await q<any>(
      `SELECT kind, outcome, tokens_output, card_id FROM shifts WHERE kind='chat' ORDER BY started_at DESC LIMIT 1`,
    )
  )[0];
  expect(shift).toMatchObject({ kind: 'chat', outcome: 'reported', card_id: null });
  expect(Number(shift.tokens_output)).toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/aom-e2e-chat-done.png' });
});

test('AC1b: the saved conversation reappears after a reload and continues in the same session', async () => {
  const drawer = await openChat();
  await drawer
    .getByTestId('chat-list')
    .getByRole('button', { name: new RegExp(reviewerName) })
    .click();
  await expect(drawer.getByTestId('chat-message')).toHaveCount(2);
  await drawer.getByLabel('Message').fill('and again');
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(drawer.getByTestId('chat-message').last()).toContainText('(turn 2)', { timeout: 30_000 });
  expect(await messages(threadId)).toHaveLength(4);
});

test('AC2: with the workstation offline the chat says so and nothing is queued', async () => {
  killRunner('SIGKILL');
  const api = await apiAs(MEMBER.email, MEMBER.password);
  await waitFor(
    'workstation offline',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w.connected === false,
    30_000,
  );
  const before = (await q<any>(`SELECT count(*)::int AS n FROM thread_messages`))[0].n;
  const drawer = await openChat();
  await drawer
    .getByTestId('chat-list')
    .getByRole('button', { name: new RegExp(reviewerName) })
    .click();
  await expect(drawer.getByTestId('chat-offline')).toContainText('offline');
  await drawer.getByLabel('Message').fill('are you there?');
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(drawer.getByTestId('chat-error')).toContainText('Nothing is queued');
  await page.screenshot({ path: '/tmp/aom-e2e-chat-offline.png' });
  // Not saved, not queued anywhere.
  expect((await q<any>(`SELECT count(*)::int AS n FROM thread_messages`))[0].n).toBe(before);
  expect(
    await q(
      `SELECT 1 FROM runner_commands WHERE type NOT IN ('agent.wipe','worktree.remove','repos.rescan','vault.configure')`,
    ),
  ).toHaveLength(0);

  // Back online: the banner clears and the same message now goes through.
  startRunner({ AOM_MOCK_CHAT_TOKEN_MS: '150' });
  await expect(drawer.getByTestId('chat-offline')).toHaveCount(0, { timeout: 30_000 });
  await drawer.getByLabel('Message').fill('welcome back');
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(drawer.getByTestId('chat-message').last()).toContainText('welcome back', { timeout: 30_000 });
  await expect(drawer.getByTestId('chat-message').last()).toContainText('(turn 3)', { timeout: 30_000 });
});

test('AC3: a conversation opens as a page on a phone-sized screen', async ({ browser }) => {
  const ctx = await browser.newContext({
    storageState: storagePath('member'),
    viewport: { width: 390, height: 844 },
  });
  const p = await ctx.newPage();
  await p.goto(`/chat/${threadId}`);
  await expect(p.getByRole('heading', { name: 'Chat with Linus' })).toBeVisible();
  await expect(p.getByTestId('chat-message')).toHaveCount(6);
  await expect(p.getByLabel('Message')).toBeVisible();
  await p.screenshot({ path: '/tmp/aom-e2e-chat-phone.png' });
  await ctx.close();
});
