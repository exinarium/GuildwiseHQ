import { expect, type Page, test } from '@playwright/test';
import { inviteAndAccept } from '../support/api.ts';
import { pool, q } from '../support/db.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/platform-area.ts';
import { platformLogin } from './platform.ts';
import { demoApi } from './seed.ts';

/**
 * The Platform area video (section P): the platform administrator's separate shell, page by page. The administrator
 * sets up two-factor login before the camera rolls (see platform.ts).
 * Output: media/videos/platform-area.{webm,mp4,vtt,json}
 *   e2e/video/record.sh platform-area
 */
const SLUG = 'platform-area';

test.afterAll(async () => {
  await pool.end();
});

/** Clicks the platform menu entry `name` (the menu scrolls sideways when it does not fit). */
const open = async (page: Page, name: string) => {
  await click(
    page,
    page.getByRole('navigation', { name: 'Platform' }).getByRole('link', { name, exact: true }),
  );
};

test('record the platform area video', async ({ browser }) => {
  // ---- seed (demo data only): a second organization, an open invitation, a support request, blog posts, a key -------
  const owner = await demoApi();
  const nora = { email: 'nora.west@demo.local', name: 'Nora West', password: 'nora-demo-pass-2026' };
  await inviteAndAccept(owner, nora);
  await q(
    `UPDATE organizations SET name='Northwind Traders' WHERE owner_user_id=(SELECT id FROM users WHERE email=$1)`,
    [nora.email],
  );
  // a self-hosted server gives its organizations the Unlimited plan (assigned by the platform administrator)
  await q(`UPDATE organizations SET plan='unlimited'`);
  const platform = await platformLogin(browser);
  const { api, headers } = platform;
  const inv = await api.post('/api/platform/invitations', {
    headers,
    data: { email: 'hana@demo.local', proposedOrgName: 'Harbor Cafe', status: 'active' },
  });
  expect(inv.ok(), await inv.text()).toBeTruthy();
  const key = await api.post('/api/platform/api-keys', {
    headers,
    data: { name: 'Release bot', scopes: ['blog:read'] },
  });
  expect(key.status(), await key.text()).toBe(201);

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'The platform area',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  await platform.ctx.close();

  // ---- the walk-through: the platform shell opens on Organizations -------------------------------------------------
  await page.goto('/platform');
  await expect(page.getByTestId('platform-orgs')).toBeVisible();
  await narrate('intro-1', async () => {
    const menu = page.getByRole('navigation', { name: 'Platform' });
    const box = await menu.boundingBox();
    if (box) await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 15 });
    if (box) await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2, { steps: 40 });
  });

  await chapter(1);
  await narrate('c1-a', async () => {
    await open(page, 'Organizations');
    await expect(page.getByTestId('platform-org-Northwind Traders')).toBeVisible();
    await pause(1500);
  });
  await narrate('c1-b', async () => {
    await click(page, page.getByRole('link', { name: 'Northwind Traders' }));
    await expect(page.getByText('Plan, limits and features').first()).toBeVisible();
    await pause(1500);
    await page.mouse.wheel(0, 400);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await open(page, 'Invitations');
    await expect(page.getByTestId('platform-invitations')).toContainText('Harbor Cafe');
    const form = page.getByTestId('new-org-form');
    const box = await form.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2, { steps: 20 });
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await open(page, 'Accounts');
    await expect(page.getByTestId('platform-users')).toContainText('Nora West');
  });

  await chapter(4);
  await narrate('c6-a', async () => {
    await open(page, 'API keys');
    await expect(page.getByTestId('keys-table')).toContainText('Release bot');
  });
  await narrate('c6-b', async () => {
    await open(page, 'Runners');
    await expect(page.getByRole('heading', { name: 'Runners' }).first()).toBeVisible();
  });
  await narrate('c6-c', async () => {
    await open(page, 'Platform team');
    await expect(page.getByRole('heading', { name: 'Platform team' }).first()).toBeVisible();
    await pause(2500);
    await open(page, 'Inbound mail');
    await expect(page.getByRole('heading', { name: 'Inbound mail' }).first()).toBeVisible();
  });

  await chapter(5);
  await narrate('c7-a', async () => {
    await open(page, 'Audit log');
    await expect(page.getByRole('heading', { name: 'Audit log' }).first()).toBeVisible();
  });
  await narrate('outro-1');

  await finish();
});
