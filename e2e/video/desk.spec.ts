import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { BASE_URL, DATABASE_URL, ROOT } from '../support/env.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/desk.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Desk video (sidebar section 5): the filters and groups, answering a question with `Add to ledger as`, accepting
 * the CEO's recommendation, what the CEO handled on its own and its Daily report.
 * Output: media/videos/desk.{webm,mp4,vtt,json}
 *   e2e/video/record.sh desk
 */
const SLUG = 'desk';

test.afterAll(async () => {
  await pool.end();
});

interface Item {
  id: string;
  title: string;
  status: string;
  kind: string;
  subkind: string | null;
  ceo_recommendation: unknown;
  data: Record<string, unknown> | null;
}
const itemsOf = (cardId: string) =>
  q<Item>(
    `SELECT id, title, status, kind, subkind, ceo_recommendation, data FROM desk_items WHERE card_id=$1 ORDER BY created_at`,
    [cardId],
  );
const waitItem = (cardId: string, what: string, pred: (i: Item) => boolean, ms = 240_000) =>
  waitFor(
    `${what}`,
    () => itemsOf(cardId),
    (r) => r.some(pred),
    ms,
  ).then((r) => r.find(pred) as Item);

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
      specify: true,
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).card.id as string;
}

test('record the desk video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({ slug: SLUG, title: 'Your Desk', cues: allCues(), chapters: CHAPTERS });
  const api = await demoApi();
  const ws = await pairWorkstation(api, "Alex's laptop", undefined, { AOM_MOCK_STEP_MS: '300' });
  const devops = (
    (await (await api.get('/api/agents')).json()).agents as Array<{ id: string; isDevops?: boolean }>
  ).find((a) => a.isDevops);
  if (devops) await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } });
  // the organization's CEO (the built-in one, on the mock runtime; see e2e/support/provision-ceo.ts)
  execFileSync('pnpm', ['--filter', '@aom/server', 'exec', 'tsx', `${ROOT}/e2e/support/provision-ceo.ts`], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL },
    stdio: 'pipe',
  });
  const ceo = (
    (await (await api.get('/api/agents')).json()).agents as Array<{
      id: string;
      roleKey: string;
      name: string;
    }>
  ).find((a) => a.roleKey === 'ceo');
  expect(ceo, 'the built-in CEO exists').toBeTruthy();
  const ceoId = (ceo as { id: string }).id;
  expect((await api.patch(`/api/agents/${ceoId}`, { data: { runtime: 'mock', model: 'mock' } })).ok()).toBe(
    true,
  );
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
  // the cards the CEO settles run on to Done without waiting for a test by the Owner
  expect((await api.put(`/api/projects/${projectId}/manual-qa`, { data: { enabled: false } })).ok()).toBe(
    true,
  );
  for (const [name, roleKey, seniority] of [
    ['Arno', 'architect', 'senior'],
    ['Max', 'builder', 'senior'],
    ['Linus', 'reviewer', 'senior'],
    ['Tess', 'tester', 'junior'],
    ['Bea', 'ba', 'senior'],
  ] as const)
    await hireAgent(api, { name, roleKey, seniority, workstationId: ws, projectId });

  const toDesk = { build: ['question', 'ok'], question: ['escalate', 'escalate', 'escalate'] };
  const ceoAnswers = { build: ['question', 'ok'], question: ['escalate', 'answer'] };
  const qPlain = await makeCard(api, projectId, rid, {
    title: 'Product search box',
    context: 'Customers cannot find products by name.',
    requirements: 'Add a search box to the header of every page.',
    criteria: ['Typing a name lists matching products'],
    mock: toDesk,
  });
  const qRec = await makeCard(api, projectId, rid, {
    title: 'Order confirmation email',
    context: 'Customers get no email after they order.',
    requirements: 'Send an order confirmation email with the order lines.',
    criteria: ['The email lists every item and the total'],
    mock: toDesk,
  });
  const ceo1 = await makeCard(api, projectId, rid, {
    title: 'Gift wrapping option',
    context: 'Customers want to send presents.',
    requirements: 'Offer gift wrapping at checkout for a small fee.',
    criteria: ['The fee is added to the total'],
    mock: ceoAnswers,
  });
  const ceo2 = await makeCard(api, projectId, rid, {
    title: 'Show the delivery estimate',
    context: 'Customers ask when their parcel arrives.',
    requirements: 'Show the expected delivery date on the product page.',
    criteria: ['The date is shown under the price'],
    mock: ceoAnswers,
  });
  // the builder needs a tool installed: DevOps asks the Owner for approval (outside the access it was granted)
  await makeCard(api, projectId, rid, {
    title: 'Zoom on product photos',
    context: 'Shoppers want to see details of a product.',
    requirements: 'Let shoppers zoom into product photos.',
    criteria: ['A click on a photo opens a zoomable view'],
    mock: { build: ['devops_install', 'ok'] },
  });

  // the two questions reach the desk; the CEO wakes up and recommends an answer to the open ones
  const plain = await waitItem(
    qPlain,
    'question 1 on the desk',
    (i) => i.kind === 'question' && i.status === 'open',
  );
  const rec = await waitItem(
    qRec,
    'question 2 on the desk',
    (i) => i.kind === 'question' && i.status === 'open',
  );
  // the two questions the CEO answered itself
  const d1 = await waitItem(ceo1, 'the CEO decided question 3', (i) => !!i.data?.ceoDecision, 240_000);
  const d2 = await waitItem(ceo2, 'the CEO decided question 4', (i) => !!i.data?.ceoDecision, 240_000);
  const approval = await waitFor(
    'the DevOps approval on the desk',
    () =>
      q<Item>(
        `SELECT id, title, status, kind, subkind FROM desk_items WHERE subkind='devops' AND status='open'`,
      ),
    (r) => r.length > 0,
    240_000,
  ).then((r) => r[0] as Item);

  // ---- realistic words (the mock agents ask and answer a fixed sentence) --------------------------------------------
  const reword = async (
    id: string,
    t: { title: string; body: string; doing: string; options: Array<[string, string]>; recommend: number },
  ) => {
    const options = t.options.map(([label, description], i) => ({ id: `o${i + 1}`, label, description }));
    await q(
      `UPDATE desk_items SET title=$2, body=$3, doing=$4, options=$5::jsonb, recommendation=$6 WHERE id=$1`,
      [id, t.title, t.body, t.doing, JSON.stringify(options), `o${t.recommend + 1}`],
    );
  };
  await reword(plain.id, {
    title: 'Should the search also match product descriptions, or only names?',
    body: 'Matching descriptions finds more, but also more noise. Names only is faster and simpler.',
    doing: 'building the search box',
    options: [
      ['Names only', 'Fast and predictable.'],
      ['Names and descriptions', 'Finds more, with a ranking step.'],
    ],
    recommend: 0,
  });
  await reword(rec.id, {
    title: 'Which address should the confirmation email come from?',
    body: 'The shop has no sending address yet.',
    doing: 'building the order confirmation email',
    options: [
      ['orders@example.com', 'A dedicated address customers can reply to.'],
      ['no-reply@example.com', 'Replies are not read.'],
    ],
    recommend: 0,
  });
  const decide = async (id: string, question: string, decision: string, reason: string) => {
    await q(
      `UPDATE desk_items SET title=$2,
         data = jsonb_set(jsonb_set(jsonb_set(data, '{ceoDecision,question}', to_jsonb($2::text)),
                '{ceoDecision,decision}', to_jsonb($3::text)), '{ceoDecision,reason}', to_jsonb($4::text))
       WHERE id=$1`,
      [id, question, decision, reason],
    );
    // the CEO's action for the item, as a real CEO records it when it answers on its own (the mock CEO cannot)
    const actionId = randomUUID();
    const org = (await q<{ org_id: string }>('SELECT org_id FROM desk_items WHERE id=$1', [id]))[0]?.org_id;
    await q(
      `INSERT INTO ceo_actions (id, org_id, class, action, mode, status, subject_kind, subject_id, subject_label, params,
         reason, confidence, idem_key, desk_item_id, created_at, event_seq)
       VALUES ($1,$2,'desk.answer_question','answer','decided','done','desk',$3::text,$4,'{}'::jsonb,$5,0.86,$6,$7::uuid,now(),0)`,
      [actionId, org, id, question, reason, `video-${actionId}`, id],
    );
    await q('UPDATE desk_items SET ceo_action_id=$2 WHERE id=$1', [id, actionId]);
  };
  await decide(
    d1.id,
    'Should gift wrapping be offered for every product?',
    'Yes, for every product except digital gift cards.',
    'A standing order says digital products are never shipped.',
  );
  await decide(
    d2.id,
    'Should the delivery estimate count Saturdays?',
    'No. Count weekdays only.',
    'The courier in the ledger delivers on weekdays only.',
  );

  // ---- the next morning: the CEO writes its Daily report ------------------------------------------------------------
  const clock = (advanceMs: number) =>
    fetch(`${BASE_URL}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ advanceMs }),
    });
  const now = new Date(((await (await clock(0)).json()) as { now: string }).now);
  const target = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 8, 5, 0); // the report is due at 08:00 (UTC: no time zone set)
  expect((await clock(target - now.getTime())).ok).toBe(true);
  const report = await waitFor(
    'the daily report',
    () => q<{ id: string; title: string }>(`SELECT id, title FROM desk_items WHERE subkind='ceo_report'`),
    (r) => r.length > 0,
    240_000,
  );
  // the CEO woke up (its report shift) and recommends an answer to the blocking questions
  await waitItem(qRec, 'the CEO recommends', (i) => i.status === 'open' && !!i.ceo_recommendation, 240_000);
  for (const [id, reason] of [
    [rec.id, 'Customers often reply to their order email; a real address keeps those replies.'],
    [plain.id, 'Most shoppers type a product name; names only keeps the search fast.'],
  ])
    await q(
      `UPDATE desk_items SET ceo_recommendation = jsonb_set(ceo_recommendation, '{reason}', to_jsonb($2::text)) WHERE id=$1 AND ceo_recommendation IS NOT NULL`,
      [id, reason],
    );
  // the escalation notes of the mock agents quote their fixed question: say what a real colleague would
  await q(
    `UPDATE desk_items SET escalation_trail = regexp_replace(escalation_trail::text,
       'mock [a-z]+: cannot settle \\\\"Mock question for [A-Z]+-[0-9]+\\?\\\\"', 'I cannot settle this: it is a product decision', 'g')::jsonb
     WHERE escalation_trail IS NOT NULL`,
  );
  await q(`UPDATE desk_items SET body=$2 WHERE id=$1`, [
    approval.id,
    'Installing Docker on the workstation is outside the access you granted the DevOps engineer.',
  ]);
  // the Owner already reviewed one of the CEO's decisions: it is closed, and listed under Handled by CEO
  const ack = await api.post(`/api/desk/${d2.id}/ceo-decision/acknowledge`, { data: {} });
  expect(ack.ok(), await ack.text()).toBe(true);
  // a notice from the CEO's first minutes (before the workstation was ready) was seen already: acknowledge it
  for (const n of await q<{ id: string }>(
    `SELECT id FROM desk_items WHERE subkind='ceo_notice' AND status='open'`,
  )) {
    const r = await api.post(`/api/desk/${n.id}/resolve`, { data: { resolution: 'acknowledged' } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  await q(`UPDATE desk_items SET body=$2 WHERE id=$1`, [
    report[0]?.id,
    [
      'Needs you: two questions about the Web shop (the search box and the confirmation email).',
      'Decisions I took: gift wrapping for every product but gift cards; delivery estimates count weekdays only.',
      'Issues and risks: none. Budget: within the monthly budget.',
    ].join('\n'),
  ]);

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const chip = (name: string | RegExp) =>
    page.getByRole('group', { name: 'Filter items' }).getByRole('button', { name });
  const itemEl = (id: string) => page.getByTestId(`desk-item-${id}`);

  // ---- the walk-through: starts on the board, opens the Desk from the sidebar ---------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    const badge = page.getByTestId('desk-badge');
    const box = await badge.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    await pause(1200);
    await click(page, nav.getByRole('link', { name: /^Desk/ }));
    await expect(page.getByTestId('desk-list')).toBeVisible();
  });
  await narrate('c1-b', async () => {
    for (const group of ['Heads-up', 'CEO decisions']) {
      await page
        .getByRole('region', { name: group })
        .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await pause(1600);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, chip(/^Blocking/));
    await pause(1500);
    await click(page, chip(/^Questions/));
    await pause(1500);
    await click(page, chip(/^Approvals/));
    await expect(itemEl(approval.id)).toBeVisible();
    await pause(1200);
  });
  await narrate('c2-b', async () => {
    await click(page, chip(/^All/));
  });

  await chapter(3);
  const p = itemEl(plain.id);
  await narrate('c3-a', async () => {
    await p.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(1500);
    await click(page, p.getByRole('radio', { name: /^Names and descriptions/ }));
  });
  await narrate('c3-b', async () => {
    await p.getByLabel('Add to ledger as').selectOption({ label: 'Standing order (this project)' });
    await pause(1500);
    await click(page, p.getByRole('button', { name: 'Answer', exact: true }));
    await expect(p).toBeHidden();
  });

  await chapter(4);
  const r = itemEl(rec.id);
  await narrate('c4-a', async () => {
    await r
      .getByTestId('ceo-recommendation')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(800);
  });
  await narrate('c4-b', async () => {
    await click(page, r.getByTestId('ceo-accept'));
    await expect(r).toBeHidden();
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await click(page, chip(/^Handled by CEO/));
    const closed = page.getByTestId('desk-closed');
    await click(page, closed.locator('summary'));
    await expect(page.getByTestId(`desk-closed-${d2.id}`)).toBeVisible();
    await pause(1500);
  });
  await narrate('c5-b', async () => {
    await click(page, chip(/^CEO decisions/));
    const d = itemEl(d1.id);
    await expect(d).toBeVisible();
    await pause(2500);
    await click(page, d.getByRole('button', { name: 'Acknowledge', exact: true }));
    await pause(800);
  });

  await chapter(6);
  await narrate('c6-a', async () => {
    await click(page, chip(/^All/));
    const rep = itemEl(report[0]?.id as string);
    await rep.evaluate((el) => {
      const top = el.getBoundingClientRect().top + window.scrollY - 130; // below the sticky filter bar
      window.scrollTo({ top, behavior: 'smooth' });
    });
    await pause(3500);
  });
  await narrate('outro-1', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  });

  await finish();
});
