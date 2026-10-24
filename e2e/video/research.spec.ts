import { expect, type Locator, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/research.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Research video (sidebar section 4): New research card, the research In progress, and the Published notes with
 * their citations and where each note is kept.
 * Output: media/videos/research.{webm,mp4,vtt,json}
 *   e2e/video/record.sh research
 * A mock researcher and checker work the cards with scripted claims (example.com sources): no network, no tokens.
 */
const SLUG = 'research';

test.afterAll(async () => {
  await pool.end();
});

async function scrollTo(target: Locator, ms = 900): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(ms);
}

const claim = (text: string, slug: string, title: string) => ({
  text,
  url: `https://example.com/research/${slug}`,
  title,
});

test('record the research video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  // no CEO: it would answer the open research's question itself, and the video shows research that waits for you
  const api = await demoApi({ ceo: false });
  const { projectId } = await createProject(api, 'INS', 'Customer insights', {
    repo: false,
    workflowKey: 'research',
  });
  const workstationId = await pairWorkstation(api);
  await hireAgent(api, { name: 'Rhea', roleKey: 'researcher', workstationId, projectId });
  await hireAgent(api, { name: 'Chuck', roleKey: 'checker', workstationId, projectId });
  const card = async (title: string, fields: Record<string, unknown>) => {
    const r = await api.post('/api/cards', {
      data: {
        projectId,
        title,
        cardType: 'research',
        fields: { question: title, depth: 'standard', ...fields },
        specify: true,
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).card.ref as string;
  };
  const status = async (ref: string) =>
    (await q<{ status: string }>('SELECT status FROM cards WHERE ref=$1', [ref]))[0]?.status;
  // a published note
  const done = await card('Which payment methods do online shoppers expect?', {
    mockResearch: {
      claims: [
        claim(
          'Most shoppers expect to pay by card and by a digital wallet at checkout',
          'checkout-survey',
          'Checkout survey 2026',
        ),
        claim(
          'Buy now, pay later is offered by a growing share of small web shops',
          'bnpl-report',
          'Payments report',
        ),
        claim(
          'Fewer payment choices than expected is a common reason to leave the checkout',
          'cart-abandonment',
          'Why carts are abandoned',
        ),
      ],
    },
  });
  await waitFor(
    'the note is published',
    () => status(done),
    (s) => s === 'done',
    240_000,
  );
  await waitFor(
    'the publication',
    () => q('SELECT 1 FROM research_publications'),
    (r) => r.length === 1,
    60_000,
  );
  // research that waits for an answer from you (it stays in progress)
  const open = await card('Which delivery times do customers accept?', {
    mock: { research: ['question'] },
    mockResearch: {
      claims: [claim('Next-day delivery is expected in cities', 'delivery-times', 'Delivery study')],
    },
  });
  await waitFor(
    'the open research waits',
    () => status(open),
    (s) => s === 'blocked',
    120_000,
  );

  const prepared = prepareVideo({ slug: SLUG, title: 'Research', cues: allCues(), chapters: CHAPTERS });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  await page.goto('/p/INS/board');
  await expect(page.getByTestId('nav-research')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-research'));
    await expect(page.getByTestId('research-tab')).toBeVisible();
    await expect(page.getByTestId('research-note')).toHaveCount(1);
  });
  await narrate('c1-b', async () => {
    await click(page, page.getByRole('link', { name: 'New research card' }).first());
    const form = page.getByRole('form', { name: 'New card' });
    await type(page, form.getByLabel('Title'), 'Do customers want gift wrapping?');
    await type(
      page,
      form.getByLabel('Question'),
      'How many online shoppers ask for gift wrapping, and what do they pay for it?',
    );
    const depth = form.getByLabel('Depth');
    await click(page, depth, 200);
    await depth.selectOption('standard');
    // what the mock researcher finds (a recording-only field of the mock runtime): demo sources on example.com
    await form.getByLabel(/research claims/).fill(
      JSON.stringify({
        claims: [
          claim('About one in four gift orders asks for gift wrapping', 'gift-orders', 'Gift orders study'),
          claim(
            'Shoppers pay a small fee for wrapping when the price is shown early',
            'wrapping-fees',
            'Checkout extras',
          ),
        ],
      }),
    );
    await pause(600);
    await click(page, form.getByRole('button', { name: 'Specify' }));
    await expect(page).toHaveURL(/\/cards\/INS-\d+$/);
    await pause(1200);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('nav-research'));
    const list = page.getByTestId('research-open');
    await expect(list).toBeVisible();
    await expect(list).toContainText('Which delivery times do customers accept?');
    await pause(1500);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await scrollTo(page.getByTestId('publication-preview').first(), 1500);
    await scrollTo(page.getByTestId('publication-citations').first(), 1200);
  });
  await narrate('c3-b', async () => {
    const path = page.getByTestId('publication-path').first();
    await scrollTo(path, 400);
    await path.hover();
    await pause(1500);
  });
  await narrate('outro-1');

  await finish();
});
