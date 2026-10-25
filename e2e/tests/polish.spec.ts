import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, POLISHER, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';
import { expandWorkstation } from '../support/ui.ts';

// Polish: priority buttons, the Ctrl+K command palette and its shortcuts, the user picture, chats (close, restore,
// delete) and Unpair (the runner stops by itself with a message). One user, one mock runner, project POL.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('polish');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let agentId: string;
let projectId: string;
let runner: ReturnType<typeof startRunner>;

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, POLISHER);
  api = await apiAs(POLISHER.email, POLISHER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired runner, project POL, an agent and two cards', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Polish Box', HOME);
  runner = startRunner({}, HOME);
  await waitFor(
    'workstation connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === true,
    30_000,
  );
  workstationId = (await (await api.get('/api/workstations')).json()).workstations[0].id;
  const p = await api.post('/api/projects', {
    data: { key: 'POL', name: 'Polish', workflowKey: 'code' },
  });
  expect(p.status(), await p.text()).toBe(201);
  projectId = (await p.json()).project.id;
  const hire = await api.post('/api/agents', {
    data: { name: 'Pia', roleKey: 'builder', seniority: 'junior', workstationId, runtime: 'mock' },
  });
  expect(hire.status(), await hire.text()).toBe(201);
  agentId = (await hire.json()).id;
  for (const [title, priority] of [
    ['Urgent hotfix', 1],
    ['Routine cleanup', 5],
  ] as const) {
    const c = await api.post('/api/cards', {
      data: { projectId, title, cardType: 'feature', fields: { context: 'ctx' }, priority },
    });
    expect(c.status(), await c.text()).toBe(201);
  }
});

test('priority is Low, Normal, High or Urgent: buttons on the form, a label on the board, a filter', async () => {
  await page.goto('/cards/new?project=POL');
  const group = page.getByRole('radiogroup', { name: 'Priority' });
  await expect(group.getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
  await group.getByRole('radio', { name: 'High' }).click();
  await expect(group.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio')).toHaveCount(4);

  await page.goto('/p/POL/board');
  await expect(page.getByTestId('board')).toBeVisible();
  const hot = page.getByTestId('card-tile-POL-1');
  await expect(hot).toContainText('Urgent');
  await expect(page.getByTestId('card-tile-POL-2')).not.toContainText('Normal');
  const filter = page.getByRole('radiogroup', { name: 'Priority' });
  await filter.getByRole('radio', { name: 'Urgent' }).click();
  await expect(page.getByTestId('card-tile-POL-1')).toBeVisible();
  await expect(page.getByTestId('card-tile-POL-2')).toHaveCount(0);
  await filter.getByRole('radio', { name: 'Any' }).click();
  await expect(page.getByTestId('card-tile-POL-2')).toBeVisible();
});

test('empty board columns fold into a pill that opens on click', async () => {
  await page.goto('/p/POL/board');
  const pill = page.getByRole('button', { name: /^Review, no cards/ });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('title', /no cards/);
  await pill.click();
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible();
});

test('Ctrl+K jumps to a card, g d goes to the desk, ? lists the shortcuts', async () => {
  await page.goto('/agents');
  await expect(page.getByTestId('palette-button')).toBeVisible(); // the app shell (and its shortcuts) is mounted
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('hotfix');
  await expect(palette.getByText('Urgent hotfix')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/cards\/POL-1$/);

  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette').getByRole('combobox').fill('Pia');
  await expect(page.getByTestId('command-palette').getByText('Pia')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await expect(page).toHaveURL(/\/desk$/);
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await expect(page).toHaveURL(/\/p\/POL\/board$/);
  await expect(page.getByRole('searchbox', { name: 'Search cards' })).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search cards' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-dialog')).toContainText('Your desk');
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await expect(page).toHaveURL(/\/cards\/new\?project=POL/);
});

test('agents have generated faces and "Re-roll face" changes one', async () => {
  await page.goto('/agents');
  const card = page.getByTestId('agent-Pia');
  const face = card.getByTestId('face');
  await expect(face).toBeVisible();
  const before = await face.getAttribute('data-seed');
  await card.getByRole('button', { name: 'Re-roll the face of Pia' }).click();
  await expect(card.getByTestId('face')).not.toHaveAttribute('data-seed', before ?? '');
  // no face is fetched from anywhere: every image is a data: URI or the app's own file
  const srcs = await page
    .locator('[data-testid="face"] img')
    .evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
  expect(srcs.length).toBeGreaterThan(0);
  expect(srcs.every((s) => s.startsWith('data:image/svg+xml'))).toBe(true);
});

test('you pick a cartoon picture on Settings and it shows in the sidebar', async () => {
  await page.goto('/settings');
  await expect(page.getByTestId('change-picture')).toBeVisible();
  await page.getByTestId('change-picture').click();
  const dlg = page.getByRole('dialog', { name: 'Your picture' });
  await expect(dlg.getByTestId('avatar-choice')).toHaveCount(12);
  await dlg.getByRole('button', { name: 'Peeps' }).click();
  await dlg.getByTestId('avatar-choice').nth(2).click();
  await dlg.getByTestId('avatar-save').click();
  await expect(dlg).toHaveCount(0);
  const me = await (await api.get('/api/auth/me')).json();
  expect(me.user.avatar).toMatchObject({ kind: 'cartoon', style: 'open-peeps' });
  await expect(
    page
      .getByRole('button', { name: /Account menu|E2E Polisher/ })
      .first()
      .getByTestId('face'),
  ).toBeVisible();
});

test('the camera tab offers the camera and the phone-camera fallback; an upload goes through the circular crop', async () => {
  await page.goto('/settings');
  await page.getByTestId('change-picture').click();
  const dlg = page.getByRole('dialog', { name: 'Your picture' });
  await dlg.getByRole('tab', { name: 'Take a photo' }).click();
  await expect(dlg.getByTestId('camera-file')).toHaveAttribute('capture', 'user');
  await dlg.getByRole('tab', { name: 'Upload' }).click();
  // a real (tiny) PNG: the browser decodes it, the crop step appears and saving stores a 256 px PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUklEQVR4nO3PQQ0AAAgEoNc/9HkNHBVI0smKSgcQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCPkbCzMn/q3jT1bZAAAAAElFTkSuQmCC',
    'base64',
  );
  await dlg.getByTestId('avatar-file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
  await expect(dlg.getByTestId('avatar-cropper')).toBeVisible();
  await dlg.getByTestId('crop-confirm').click();
  await expect(dlg).toHaveCount(0);
  const me = await (await api.get('/api/auth/me')).json();
  expect(me.user.avatar.kind).toBe('image');
  const img = await api.get(`/api/users/${me.user.id}/avatar`);
  expect(img.status()).toBe(200);
  expect(img.headers()['content-type']).toBe('image/png');
  const body = await img.body();
  expect(body.readUInt32BE(16)).toBe(256);
  expect(body.readUInt32BE(20)).toBe(256);
  await page.goto('/settings');
  await expect(page.getByTestId('user-photo').first()).toBeVisible();
});

test('chats: Close hides one (Archived brings it back), Delete removes one after a confirmation', async () => {
  await page.goto('/desk');
  await page.getByRole('button', { name: 'Chat with an agent' }).click();
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  for (let i = 0; i < 2; i++) {
    const r = await api.post('/api/chats', { data: { agentId } });
    expect(r.status()).toBe(201);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Chat with an agent' }).click();
  await expect(drawer.getByTestId('chat-row-Pia')).toHaveCount(2);

  await drawer.getByRole('button', { name: 'Actions for the chat with Pia' }).first().click();
  await page.getByRole('menuitem', { name: /Close chat/ }).click();
  await expect(drawer.getByTestId('chat-row-Pia')).toHaveCount(1);
  await drawer.getByRole('button', { name: /Archived \(1\)/ }).click();
  await expect(drawer.getByTestId('chat-row-Pia')).toHaveCount(1);
  await drawer.getByRole('button', { name: 'Actions for the chat with Pia' }).click();
  await page.getByRole('menuitem', { name: /Restore to the list/ }).click();
  await drawer.getByRole('button', { name: 'Open' }).click();
  await expect(drawer.getByTestId('chat-row-Pia')).toHaveCount(2);

  await drawer.getByRole('button', { name: 'Actions for the chat with Pia' }).first().click();
  await page.getByRole('menuitem', { name: /Delete chat/ }).click();
  const confirm = page.getByRole('dialog', { name: /Delete the chat with Pia/ });
  await expect(confirm).toContainText('cannot be undone');
  await confirm.getByRole('button', { name: 'Delete chat' }).click();
  await expect(drawer.getByTestId('chat-row-Pia')).toHaveCount(1);
  expect((await (await api.get('/api/chats')).json()).chats).toHaveLength(1);
});

test('Unpair: asks first, then the workstation is gone, its runner stops by itself with a message', async () => {
  await page.goto('/workstations');
  const card = page.getByTestId('workstation-Polish Box');
  await expect(card.getByTestId('connection-dot')).toHaveAttribute('data-connected', 'true');
  // collapsed by default, remembered once opened
  await expect(card.getByTestId('workstation-details')).toHaveCount(0);
  await expandWorkstation(card);
  await expect(card.getByTestId('workstation-details')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('workstation-Polish Box').getByTestId('workstation-details')).toBeVisible();

  const exited = new Promise<number | null>((resolve) => runner.once('exit', (code) => resolve(code)));
  await page.getByRole('button', { name: 'Unpair Polish Box' }).click();
  const confirm = page.getByRole('dialog', { name: 'Unpair Polish Box?' });
  await expect(confirm).toContainText('runner token stops working');
  expect((await (await api.get('/api/workstations')).json()).workstations).toHaveLength(1);
  await confirm.getByRole('button', { name: 'Unpair' }).click();
  await expect(page.getByTestId('workstation-Polish Box')).toHaveCount(0);
  expect((await (await api.get('/api/workstations')).json()).workstations).toHaveLength(0);
  expect(await exited).toBe(0);
  expect(readFileSync(`${HOME}.out.log`, 'utf8')).toContain('this workstation was unpaired');
});
