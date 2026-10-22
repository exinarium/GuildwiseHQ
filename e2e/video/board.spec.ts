import { type APIRequestContext, expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/board.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Board video (sidebar section 1): the columns of the workflow, the filter chips, a card's detail, New card,
 * Pause project and the Archive.
 * Output: apps/web/public/videos/board.{webm,mp4,vtt,json}
 *   e2e/video/record.sh board
 */
const SLUG = 'board';

test.afterAll(async () => {
  await pool.end();
});

interface CardRow {
  id: string;
  ref: string;
  stage: string;
  status: string;
  rework_round: number;
}
const cardOf = async (title: string): Promise<CardRow | undefined> =>
  (await q<CardRow>(`SELECT id, ref, stage, status, rework_round FROM cards WHERE title=$1`, [title]))[0];
const waitCard = (title: string, what: string, pred: (c: CardRow) => boolean, ms = 240_000) =>
  waitFor(
    `${title}: ${what}`,
    () => cardOf(title),
    (c) => !!c && pred(c),
    ms,
  ) as Promise<CardRow>;

async function makeCard(
  api: APIRequestContext,
  projectId: string,
  repoId: string,
  c: {
    title: string;
    context: string;
    requirements: string;
    criteria: string[];
    mock?: Record<string, string[]>;
  },
  specify = true,
): Promise<string> {
  const r = await api.post('/api/cards', {
    data: {
      projectId,
      title: c.title,
      cardType: 'feature',
      repoId,
      completionAction: 'merge',
      docsNeeded: false,
      fields: {
        context: c.context,
        requirements: c.requirements,
        acceptanceCriteria: c.criteria,
        affectedAreas: 'src/',
        constraints: 'Keep the public API unchanged.',
        testPlan: 'Run the unit tests and walk through the screen in the browser.',
        mockUsage: { inputTokens: 300_000, outputTokens: 20_000 },
        ...(c.mock ? { mock: c.mock } : {}),
      },
      specify,
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).card.id as string;
}

test('record the board video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'The Board and your cards',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const api = await demoApi();
  // a fast mock while the history is made; the camera only starts once every card stands where the video needs it
  const ws = await pairWorkstation(api, "Alex's laptop", undefined, { AOM_MOCK_STEP_MS: '300' });
  const devops = (
    (await (await api.get('/api/agents')).json()).agents as Array<{ id: string; isDevops?: boolean }>
  ).find((a) => a.isDevops);
  if (devops) await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } });
  const { projectId, repoId } = await createProject(api, 'SHOP', 'Web shop');
  const rid = repoId as string;
  await waitFor(
    'the workstation holds the repository',
    async () =>
      ((await (await api.get('/api/workstations')).json()).workstations as Array<{ repos: unknown[] }>)[0]
        ?.repos.length ?? 0,
    (n) => n >= 1,
    30_000,
  );
  // every card waits for the Owner's approval after the review (so one card can stay there)
  expect(
    (await api.put(`/api/projects/${projectId}/owner-approval`, { data: { policy: 'always' } })).ok(),
  ).toBe(true);
  expect((await api.put(`/api/projects/${projectId}/budget`, { data: { monthly: 250 } })).ok()).toBe(true);
  for (const [name, roleKey, seniority] of [
    ['Arno', 'architect', 'senior'],
    ['Ada', 'builder', 'senior'],
    ['Linus', 'reviewer', 'senior'],
    ['Tess', 'tester', 'junior'],
    ['Bea', 'ba', 'senior'],
  ] as const)
    await hireAgent(api, { name, roleKey, seniority, workstationId: ws, projectId });

  const DONE_OLD = 'Fix the typo in the footer';
  const DONE = 'Show the delivery estimate';
  const QA = 'Gift wrapping option';
  const APPROVAL = 'Order confirmation email';
  const REWORK = 'Customer reviews on product pages';
  const BLOCKED = 'Product search box';
  const DRAFT = 'Wishlist for returning customers';
  const LIVE = 'Newsletter sign-up';
  const card = (title: string, context: string, requirements: string, criteria: string[]) => ({
    title,
    context,
    requirements,
    criteria,
  });
  await makeCard(
    api,
    projectId,
    rid,
    card(DONE_OLD, 'The footer says "Copyrigth".', 'Spell "Copyright" correctly in the footer.', [
      'The footer reads "Copyright"',
    ]),
  );
  await makeCard(
    api,
    projectId,
    rid,
    card(
      DONE,
      'Customers ask when their parcel arrives.',
      'Show the expected delivery date on the product page.',
      ['The date is shown under the price', 'It skips weekends'],
    ),
  );
  await makeCard(
    api,
    projectId,
    rid,
    card(QA, 'Customers want to send presents.', 'Offer gift wrapping at checkout for a small fee.', [
      'A gift wrapping box appears at checkout',
      'The fee is added to the total',
    ]),
  );
  await makeCard(
    api,
    projectId,
    rid,
    card(
      APPROVAL,
      'Customers get no email after they order.',
      'Send an order confirmation email with the order lines.',
      ['The email arrives within a minute', 'It lists every item and the total'],
    ),
  );
  await makeCard(api, projectId, rid, {
    ...card(
      REWORK,
      'Shoppers trust products other customers rated.',
      'Show customer reviews and the average rating on each product page.',
      ['The average rating is shown as stars', 'The newest reviews come first'],
    ),
    mock: { review: ['changes', 'ok'] },
  });
  await makeCard(api, projectId, rid, {
    ...card(
      BLOCKED,
      'Customers cannot find products by name.',
      'Add a search box to the header of every page.',
      ['Typing a name lists matching products', 'An empty search shows nothing'],
    ),
    mock: { build: ['question'], question: ['escalate', 'escalate', 'escalate'] },
  });

  // the history: two cards run to Done, one to QA, one waits for approval, one went through rework, one is blocked
  const approve = async (title: string) => {
    const c = await waitCard(
      title,
      'waiting for approval',
      (x) => x.stage === 'owner_approval' && x.status === 'waiting',
    );
    const r = await api.post(`/api/cards/${c.id}/approval/approve`, { data: {} });
    expect(r.ok(), await r.text()).toBe(true);
  };
  const qaPass = async (title: string) => {
    const c = await waitCard(
      title,
      'waiting for QA',
      (x) => x.stage === 'manual_qa' && x.status === 'waiting',
      300_000,
    );
    const r = await api.post(`/api/cards/${c.id}/qa/pass`, { data: {} });
    expect(r.ok(), await r.text()).toBe(true);
  };
  await approve(DONE_OLD);
  await approve(DONE);
  await approve(QA);
  await qaPass(DONE_OLD);
  await qaPass(DONE);
  await waitCard(QA, 'waiting for QA', (x) => x.stage === 'manual_qa' && x.status === 'waiting', 300_000);
  await waitCard(
    APPROVAL,
    'waiting for approval',
    (x) => x.stage === 'owner_approval' && x.status === 'waiting',
  );
  await waitCard(
    REWORK,
    'reworked, waiting for approval',
    (x) => x.rework_round >= 1 && x.stage === 'owner_approval' && x.status === 'waiting',
  );
  const blocked = await waitCard(BLOCKED, 'blocked', (x) => x.status === 'blocked');
  // the mock agent asks a fixed sentence: give the blocked card's question realistic words
  await waitFor(
    'the question of the blocked card',
    () => q(`SELECT id FROM desk_items WHERE card_id=$1 AND status='open'`, [blocked.id]),
    (r) => r.length > 0,
    60_000,
  );
  await q(`UPDATE desk_items SET title=$2, body=$2 WHERE card_id=$1 AND status='open'`, [
    blocked.id,
    'Should the search also match product descriptions, or only names?',
  ]);
  await q(`UPDATE thread_messages SET body = replace(body, $1, $2) WHERE body LIKE '%' || $1 || '%'`, [
    `Mock question for ${blocked.ref}?`,
    'Should the search also match product descriptions, or only names?',
  ]);
  // the first finished card was done days ago: it has left the board and is in the Archive
  await q(`UPDATE cards SET finished_at = now() - interval '3 days' WHERE title=$1`, [DONE_OLD]);
  // a draft, and a card that is being built while the video plays
  await makeCard(
    api,
    projectId,
    rid,
    card(DRAFT, 'Returning customers lose what they liked.', 'Let signed-in customers keep a wishlist.', [
      'A heart on each product adds it to the wishlist',
    ]),
    false,
  );
  await makeCard(api, projectId, rid, {
    ...card(
      LIVE,
      'We have no way to tell customers about offers.',
      'Add a newsletter sign-up form to the footer.',
      ['An email address can be entered and saved', 'A thank-you message is shown'],
    ),
    mock: { build: ['hang'] },
  });
  await waitCard(LIVE, 'being built', (x) => x.stage === 'build' && x.status === 'claimed', 120_000);
  const rework = (await cardOf(REWORK)) as CardRow;
  // the scripts of the mock agents are stage props: keep them out of the brief and the thread
  await q(`UPDATE cards SET fields = fields - 'mock' - 'mockUsage'`);
  await q(
    `UPDATE thread_messages SET body = replace(regexp_replace(body, 'mock [a-z]+: cannot settle "[^"]*"', 'this needs the owner''s decision', 'g'), 'Options: yes / no', 'Options: names only / names and descriptions')`,
  );
  // "mock planning note for SHOP-6" reads "Planning note for SHOP-6"
  for (const [table, col] of [
    ['card_handoffs', 'note'],
    ['thread_messages', 'body'],
  ])
    await q(
      `UPDATE ${table} SET ${col} = upper(left(x, 1)) || substr(x, 2) FROM (SELECT id AS xid, regexp_replace(${col}, '\\mmock:?\\s+', '', 'g') AS x FROM ${table} WHERE ${col} ~ '\\mmock\\M') s WHERE id = s.xid`,
    );

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: starts on Projects, opens the Board from the sidebar ----------------------------------------
  const nav = page.getByRole('navigation', { name: 'Main' });
  await page.goto('/projects');
  await expect(nav.getByRole('link', { name: 'Board', exact: true })).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, nav.getByRole('link', { name: 'Board', exact: true }));
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId(`card-tile-${rework.ref}`)).toBeVisible();
    await pause(1200);
    // the later columns (Approval, QA, Done) are to the right: scroll there and back
    const cols = page.getByLabel('Board columns');
    await cols.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' }));
    await pause(2200);
    await cols.evaluate((el) => el.scrollTo({ left: 0, behavior: 'smooth' }));
  });
  await narrate('c1-b', async () => {
    const spend = page.getByTestId('board-spend');
    if (await spend.isVisible()) {
      const box = await spend.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    }
  });

  await chapter(2);
  const chip = (name: string | RegExp) =>
    page.getByRole('group', { name: 'Filters' }).getByRole('button', { name });
  await narrate('c2-a', async () => {
    await click(page, chip('Blocked'));
    await expect(page.getByTestId(`card-tile-${blocked.ref}`)).toBeVisible();
    await pause(1800);
    await click(page, chip('Blocked'));
  });
  await narrate('c2-b', async () => {
    await click(page, chip(/^Waiting for my approval/));
    await pause(2200);
    await click(page, chip(/^Waiting for my approval/));
    await click(page, chip(/^Waiting for my QA/));
    await pause(2000);
    await click(page, chip(/^Waiting for my QA/));
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId(`card-tile-${blocked.ref}`));
    await expect(page).toHaveURL(/\/cards\/[^/]+$/);
    await expect(page.getByTestId('card-spec')).toBeVisible();
  });
  await narrate('c3-b', async () => {
    const spec = page.getByTestId('card-spec');
    await spec.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(900);
    const box = await spec.boundingBox();
    if (box) await page.mouse.move(box.x + 200, box.y + 60, { steps: 25 });
  });
  await narrate('c3-c', async () => {
    await page
      .getByRole('heading', { name: 'Thread' })
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(2800);
    await page
      .getByTestId('handoffs')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(1500);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(page, page.getByRole('link', { name: 'Back to the board' }).first());
    await expect(page.getByTestId('board')).toBeVisible();
    await click(page, page.getByRole('link', { name: 'New card', exact: true }).first());
    const form = page.getByRole('form', { name: 'New card' });
    await expect(form).toBeVisible();
    await type(page, form.getByLabel('Title', { exact: true }), 'Show a sale banner');
    await pause(800);
    await click(page, form.getByRole('link', { name: 'Cancel' }));
    await expect(page.getByTestId('board')).toBeVisible();
  });
  await narrate('c4-b', async () => {
    await click(page, page.getByTestId('pause-project-open'));
    await type(page, page.getByTestId('pause-project-reason'), 'Release freeze until Monday');
    await click(page, page.getByTestId('pause-project-confirm'));
    await expect(page.getByTestId('project-paused-banner')).toBeVisible();
    await pause(1500);
    await click(page, page.getByTestId('resume-project'));
    await expect(page.getByTestId('project-paused-banner')).toBeHidden();
  });
  await narrate('c4-c', async () => {
    await click(page, page.getByRole('link', { name: 'Archive', exact: true }));
    await expect(page.getByText(DONE_OLD)).toBeVisible();
    await pause(2000);
    await click(page, page.getByRole('link', { name: 'Back to the board' }).first());
    await expect(page.getByTestId('board')).toBeVisible();
  });
  await narrate('outro-1');

  await finish();
});
