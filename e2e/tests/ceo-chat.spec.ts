import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { pool } from '../support/db.ts';
import { ADMIN, DATABASE_URL, ROOT } from '../support/env.ts';

// The CEO chat page (/ceo-chat): the standing chat, New chat (reuses an empty one, else archives the old one and opens a
// clean one), the earlier-chats list, and "Archive all" in the chat drawer (never touches the live CEO chat).
// Runs after chat.spec, which leaves the runner online. Archive all chats with agents that are active when it runs:
// core-loop fires one of the builders, and which one depends on the run.
test.describe.configure({ mode: 'serial' });

let page: Page;
let api: APIRequestContext;

test.beforeAll(async ({ browser }) => {
  // The built-in CEO of this organization is created by a data migration that ran before the role catalogue existed.
  execFileSync('pnpm', ['--filter', '@aom/server', 'exec', 'tsx', `${ROOT}/e2e/support/provision-ceo.ts`], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL, AOM_NO_LEAN_TEAM: 'true' },
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
  await expect(page.getByTestId('chat-offline').or(page.getByText('Add a workstation'))).toBeVisible();

  const urlBefore = page.url();
  await page.getByTestId('ceo-chat-new').click();
  // New chat on an empty chat is idempotent (fc4ba509): it stays on the standing chat
  await expect(page).toHaveURL(urlBefore);
  await expect(page.getByTestId('ceo-chat-row')).toHaveCount(1);
  await expect(page.getByTestId('ceo-chat-list')).toContainText('Current chat');

  await expect(page.getByRole('button', { name: 'More chat actions' })).toHaveCount(0);
  expect((await ceoChats()).filter((c) => !c.archived)).toHaveLength(1);
});
test('Archive all closes the other chats and leaves the live CEO chat open', async () => {
  // the live CEO chat (test 2 shows there is exactly one open)
  const liveCeo = (await ceoChats()).filter((c) => !c.archived);
  expect(liveCeo, 'one open CEO chat').toHaveLength(1);
  const ceoThreadId = liveCeo[0].threadId as string;
  const ceoName = liveCeo[0].agentName as string;

  // chat partners chosen by state, not by name: an earlier spec may have fired any one builder
  const agents = (await (await api.get('/api/agents')).json()).agents as any[];
  const partners: any[] = [];
  for (const a of agents) {
    if (a.status !== 'active' || a.isDevops || a.roleKey === 'ceo') continue;
    if (partners.some((p) => p.name === a.name)) continue;
    partners.push(a);
    if (partners.length === 2) break;
  }
  expect(
    partners.length,
    `two active agents to chat with: ${agents.map((a) => `${a.name}:${a.status}`).join(', ')}`,
  ).toBe(2);

  const created: { threadId: string; agentName: string }[] = [];
  for (const a of partners) {
    const made = await api.post('/api/chats', { data: { agentId: a.id } });
    expect(made.status(), await made.text()).toBe(201);
    const { chat } = await made.json();
    created.push({ threadId: chat.threadId, agentName: chat.agentName });
  }

  await page.goto('/desk');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await expect(drawer.getByTestId('chat-list')).toBeVisible();
  for (const c of created) await expect(drawer.getByTestId(`chat-row-${c.agentName}`).first()).toBeVisible();

  await drawer.getByTestId('archive-all-chats').click();
  const archivedResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/chats/archive-all') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Archive all', exact: true }).last().click();
  const res = await archivedResponse;
  expect(res.status(), await res.text()).toBe(200);
  // chats that earlier specs left in the admin's view are archived too
  expect((await res.json()).archived).toBeGreaterThanOrEqual(created.length);

  // the server: the created chats are archived (not deleted), and the only open chat is the live CEO chat
  await expect
    .poll(async () => {
      const chats = (await (await api.get('/api/chats')).json()).chats as any[];
      return {
        created: created.map((c) => chats.find((x) => x.threadId === c.threadId)?.archived ?? 'missing'),
        open: chats.filter((x) => !x.archived).map((x) => x.threadId),
      };
    })
    .toEqual({ created: created.map(() => true), open: [ceoThreadId] });

  // the drawer shows it without a reload
  await expect(drawer.getByTestId('archive-all-chats')).toHaveCount(0);
  for (const c of created) await expect(drawer.getByTestId(`chat-row-${c.agentName}`)).toHaveCount(0);
  await expect(drawer.getByTestId(`chat-row-${ceoName}`)).toBeVisible();
  await drawer
    .getByRole('radiogroup', { name: 'Show chats' })
    .getByRole('button', { name: /^Archived/ })
    .click();
  for (const c of created) await expect(drawer.getByTestId(`chat-row-${c.agentName}`).first()).toBeVisible();
});
