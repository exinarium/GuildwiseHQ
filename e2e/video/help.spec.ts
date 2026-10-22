import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/help.ts';
import { platformLogin } from './platform.ts';
import { demoApi } from './seed.ts';

/**
 * The Help video (sidebar section 23): search the articles, the glossary, what's new, the blog, Contact us and My
 * requests, the "?" page help and the tour.
 * Output: apps/web/public/videos/help.{webm,mp4,vtt,json}
 *   e2e/video/record.sh help
 */
const SLUG = 'help';

test.afterAll(async () => {
  await pool.end();
});

const BLOG_BODY = [
  'A team of AI agents works best when every card says what is wanted, why, and how you will know it is done.',
  'In this post we look at three habits that make cards easy for agents to pick up and finish without questions.',
  '',
  '## Say why, not only what',
  '',
  'An agent that knows the reason behind a change makes better choices when the card leaves something open. One',
  'sentence of context, such as "visitors do not know what the shop sells", is often enough to steer the design.',
  '',
  '## Make the end visible',
  '',
  'Acceptance criteria are the checklist the tester works through. Write them as things anyone can see on the',
  'screen: "the banner is visible", "it can be closed". Vague criteria lead to rework rounds and higher costs.',
  '',
  '## Keep cards small',
  '',
  'A card that touches one area is planned, built and reviewed faster than a card that touches five. When an idea',
  'grows, put the rest on the backlog and send it on later. Your business analyst can split a large request for you.',
  '',
  'Small, clear cards are cheaper, faster and easier to review. Try it on your next three cards and compare.',
].join('\n');

test('record the help video', async ({ browser }) => {
  // ---- seed (demo data only): a blog post, and one answered request in My requests ------------------------------------
  const api = await demoApi();
  const platform = await platformLogin(browser);
  const post = await platform.api.post('/api/platform/blog/posts', {
    headers: platform.headers,
    data: {
      slug: 'three-habits-of-good-cards',
      title: 'Three habits of cards that agents finish',
      summary:
        'Why the reason, visible acceptance criteria and small cards make AI agents faster, cheaper and easier to review.',
      bodyMarkdown: BLOG_BODY,
      coverImage: { defaultKey: 'how-to', alt: 'A board of cards in columns' },
      tags: ['how-to', 'ai-agents'],
    },
  });
  expect(post.status(), await post.text()).toBe(201);
  const postId = ((await post.json()) as { id: string }).id;
  const pub = await platform.api.post(`/api/platform/blog/posts/${postId}/publish`, {
    headers: platform.headers,
  });
  expect(pub.ok(), await pub.text()).toBeTruthy();

  const ticket = await api.post('/api/support/tickets', {
    data: {
      kind: 'question',
      subject: 'Can a reviewer work on two projects?',
      message: 'We have a second project for the mobile app. Can Linus review the cards of both projects?',
      context: { page: '/agents', appVersion: '1.0.0', browser: 'Chrome 141', viewport: '1280x720' },
    },
  });
  expect(ticket.status(), await ticket.text()).toBe(201);
  const ticketId = ((await ticket.json()) as { id: string }).id;
  const reply = await platform.api.post(`/api/platform/support/tickets/${ticketId}/replies`, {
    headers: platform.headers,
    data: {
      body: 'Hi Alex. Yes: open Agents, choose Allowed projects on Linus and tick both projects. He then takes review cards from either board.',
    },
  });
  expect(reply.ok(), await reply.text()).toBeTruthy();
  await platform.ctx.close();

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'The Help centre',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: opens Help from the sidebar ----------------------------------------------------------------
  await page.goto('/desk');
  await expect(page.getByTestId('nav-help')).toBeVisible();
  // The Help centre's home starts with the getting-started video: the walk-through searches at once, so that video
  // (another video, rule 4 of the plan) is only on screen for a moment.
  await narrate('intro-1', async () => {
    const box = await page.getByTestId('nav-help').boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
  });

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-help'), 100);
    await type(page, page.getByTestId('help-search'), 'budget');
    await expect(page.getByTestId('help-results')).toBeVisible();
    await pause(1200);
  });
  await narrate('c1-b', async () => {
    await click(page, page.getByTestId('help-result').first());
    await expect(page.getByTestId('help-article-title')).toBeVisible();
    await pause(800);
    await page.mouse.wheel(0, 400);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, page.getByRole('link', { name: 'All articles' }).first());
    await click(page, page.getByTestId('help-glossary-link'));
    await expect(page.getByTestId('help-glossary')).toBeVisible();
    await pause(800);
    await page.mouse.wheel(0, 500);
  });
  await narrate('c2-b', async () => {
    await click(page, page.getByRole('link', { name: 'All articles' }).first());
    await click(page, page.getByTestId('help-open-whats-new'));
    await expect(page.getByRole('dialog')).toBeVisible();
    await pause(2200);
    await click(page, page.getByRole('dialog').getByRole('button', { name: 'Close' }).last());
  });
  await narrate('c2-c', async () => {
    await click(page, page.getByTestId('help-tab-blog'));
    await expect(page.getByText('Three habits of cards that agents finish').first()).toBeVisible();
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('help-tab-contact'));
    await pause(1500);
  });
  await narrate('c3-b', async () => {
    await click(page, page.getByTestId('help-tab-requests'));
    const row = page.locator('[data-testid^="request-"]').first();
    await expect(row).toContainText('New reply');
    await pause(1200);
    await click(page, row);
    await expect(page.getByText('tick both projects')).toBeVisible();
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(page, page.getByTestId('page-help-button'));
    await expect(page.getByTestId('page-help')).toBeVisible();
    await pause(2500);
    await click(page, page.getByRole('button', { name: 'Close help' }));
  });
  await narrate('c4-b', async () => {
    await click(page, page.getByTestId('help-tab-help'));
    const tour = page.getByTestId('help-replay-tour');
    await expect(tour).toBeVisible();
    // the tour card at the top of the view, the getting-started video above it out of sight
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-testid="help-tour"]');
      if (el) { el.scrollIntoView({ block: 'start' }); let p = el.parentElement; while (p && p !== document.documentElement && p.scrollHeight <= p.clientHeight + 1) p = p.parentElement; (p || document.documentElement).scrollBy(0, -110); }
    })()`);
    await pause(400);
    const box = await tour.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  });
  await narrate('outro-1');

  await finish();
});
