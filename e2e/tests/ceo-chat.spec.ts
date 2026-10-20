import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { pool } from '../support/db.ts';
import { ADMIN, DATABASE_URL, ROOT } from '../support/env.ts';

// The CEO chat page (/ceo-chat): the standing chat, New chat (reuses an empty one, else archives the old one and opens a
// clean one), the earlier-chats list, and "Archive all" in the chat drawer (never touches the live CEO chat).
// Runs after chat.spec, which leaves the runner online and a chat with Linus.
test.describe.configure({ mode: 'serial' });

let page: Page;
let api: APIRequestContext;

test.beforeAll(async ({ browser }) => {
  // The built-in CEO of this organization is created by a data migration that ran before the role catalogue existed.
  execFileSync('pnpm', ['--filter', '@aom/server', 'exec', 'tsx', `${ROOT}/e2e/support/provision-ceo.ts`], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL },
    stdio: 'pipe',
  });
  // Only the organization Owner (the admin account) can chat with the CEO.
  api = await apiAs(ADMIN.email, ADMIN.password);
  page = await (
    await browser.newContext({
      storageState: await api.storageState(),
      viewport: { width: 1280, height: 800 },
    })
  ).newPage();
});
test.afterAll(async () => {
  await pool.end();
});

const ceoChats = async () =>
  (await (await api.get('/api/chats')).json()).chats.filter((c: any) => c.agentRole === 'ceo') as any[];

test('the CEO chat opens as a page on the standing chat', async () => {
  await page.goto('/ceo-chat');
  await expect(page).toHaveURL(/\/ceo-chat\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('ceo-chat-screen')).toBeVisible();
  await expect(page.getByTestId('ceo-chat-list')).toBeVisible();
  await page.screenshot({ path: '/tmp/aom-e2e-ceo-chat.png' });
});

test('New chat on an empty chat keeps the one standing chat and show it in the list', async () => {
  // The e2e CEO has no workstation (the paired one belongs to the member), so no message can be sent here: the
  // archive-with-history path is covered by the server tests (ceo-new-chat) and the web tests.
  const standing = (await ceoChats()).filter((c) => !c.archived);
  expect(standing).toHaveLength(1);
  await expect(page.getByTestId('chat-offline').or(page.getByText('Pair a workstation'))).toBeVisible();

  await page.getByTestId('ceo-chat-new').click();
  await expect(page.getByText('This chat is still empty')).toBeVisible();
  await expect(page.getByTestId('ceo-chat-row')).toHaveCount(1);
  await expect(page.getByTestId('ceo-chat-list')).toContainText('Current chat');

  await expect(page.getByRole('button', { name: 'More chat actions' })).toHaveCount(0);
  expect((await ceoChats()).filter((c) => !c.archived)).toHaveLength(1);
});

test('Archive all closes the other chats and leaves the live CEO chat open', async () => {
  const agents = (await (await api.get('/api/agents')).json()).agents as any[];
  for (const name of ['Ada', 'Grace']) {
    const a = agents.find((x) => x.name === name);
    expect(a, `agent ${name}`).toBeTruthy();
    expect((await api.post('/api/chats', { data: { agentId: a.id } })).ok()).toBe(true);
  }
  await page.goto('/desk');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await expect(drawer.getByTestId('chat-list')).toBeVisible();
  await drawer.getByTestId('archive-all-chats').click();
  await page.getByRole('button', { name: 'Archive all', exact: true }).last().click();

  await expect
    .poll(async () =>
      (await (await api.get('/api/chats')).json()).chats
        .filter((c: any) => !c.archived)
        .map((c: any) => c.agentRole),
    )
    .toEqual(['ceo']);
  await expect(drawer.getByTestId('archive-all-chats')).toHaveCount(0);
});
