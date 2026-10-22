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
 * Output: apps/web/public/videos/platform-area.{webm,mp4,vtt,json}
 *   e2e/video/record.sh platform-area
 */
const SLUG = 'platform-area';

test.afterAll(async () => {
  await pool.end();
});

const BODY = (topic: string) =>
  [
    `This post is about ${topic}. A team of AI agents works best with clear cards, a short feedback loop and a person`,
    'who decides what matters. Below are the habits we see in the teams that get the most out of their agents.',
    '',
    '## Start small',
    '',
    'Pick one project and one repository. Hire a lean team and send it three small cards. Read what comes back, and',
    'write down what you would change: that list becomes the ledger your agents follow from then on.',
    '',
    '## Answer quickly',
    '',
    'Questions on the Desk hold work up. A team whose owner answers within the hour finishes cards in half the time of',
    'a team whose owner answers once a day. Turn on push notifications, and let the CEO answer what it can.',
    '',
    '## Look at the numbers',
    '',
    'Metrics and Costs show where time and money go. A card that bounces between review and build twice is a card that',
    'was too large or too vague. Split it, and the next one will go through in one round.',
    '',
    '## Keep the ledger current',
    '',
    'Every answer you give can become a ledger entry. Agents read the ledger before they ask, so a decision made once is',
    'not asked again. Retire entries that no longer hold, and your team keeps making the choices you would make.',
  ].join('\n');

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
  const ticket = await owner.post('/api/support/tickets', {
    data: {
      kind: 'question',
      subject: 'Can a reviewer work on two projects?',
      message: 'We have a second project for the mobile app. Can Linus review the cards of both projects?',
      context: { page: '/agents', appVersion: '1.0.0', browser: 'Chrome 141', viewport: '1280x720' },
    },
  });
  expect(ticket.status(), await ticket.text()).toBe(201);

  const platform = await platformLogin(browser);
  const { api, headers } = platform;
  const inv = await api.post('/api/platform/invitations', {
    headers,
    data: { email: 'hana@demo.local', proposedOrgName: 'Harbor Cafe', plan: 'founding', status: 'active' },
  });
  expect(inv.ok(), await inv.text()).toBeTruthy();
  for (const [slug, title, publish] of [
    ['start-small-with-ai-agents', 'Start small: your first week with a team of AI agents', true],
    ['answer-the-desk-quickly', 'Why answering the Desk quickly doubles your throughput', false],
  ] as const) {
    const post = await api.post('/api/platform/blog/posts', {
      headers,
      data: {
        slug,
        title,
        summary:
          'Practical habits from teams that get the most out of their AI agents: small cards, quick answers and a look at the numbers.',
        bodyMarkdown: BODY(title.toLowerCase()),
        coverImage: { defaultKey: 'ai-agents', alt: 'A team of agents around a board' },
        tags: ['ai-agents', 'how-to'],
      },
    });
    expect(post.status(), await post.text()).toBe(201);
    if (publish) {
      const id = ((await post.json()) as { id: string }).id;
      const pub = await api.post(`/api/platform/blog/posts/${id}/publish`, { headers });
      expect(pub.ok(), await pub.text()).toBeTruthy();
    }
  }
  const key = await api.post('/api/platform/api-keys', {
    headers,
    data: { name: 'Blog writer', scopes: ['blog:read', 'blog:write'] },
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
  await narrate('c4-a', async () => {
    await open(page, 'Billing');
    await expect(page.getByText('Plans').first()).toBeVisible();
    await pause(1500);
    await page.mouse.wheel(0, 500);
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    await open(page, 'Support');
    await expect(page.getByTestId('support-inbox')).toContainText('Can a reviewer work on two projects?');
    await pause(1200);
    // the inbox sits under the notification settings
    await page.getByTestId('support-inbox').scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 250);
  });
  await narrate('c5-b', async () => {
    await open(page, 'Blog');
    const draft = page.getByText('Why answering the Desk quickly').first();
    await expect(draft).toBeVisible();
    await pause(800);
    // the posts are listed under the blog's switch and digest settings
    await draft.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 200);
  });

  await chapter(6);
  await narrate('c6-a', async () => {
    await open(page, 'API keys');
    await expect(page.getByTestId('keys-table')).toContainText('Blog writer');
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

  await chapter(7);
  await narrate('c7-a', async () => {
    await open(page, 'Audit log');
    await expect(page.getByRole('heading', { name: 'Audit log' }).first()).toBeVisible();
  });
  await narrate('outro-1');

  await finish();
});
