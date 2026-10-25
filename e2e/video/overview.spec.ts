import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { BASE_URL, paths } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS, TEASER_CHAPTERS, TEASER_CUES } from './narration/overview.ts';
import { platformLogin } from './platform.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';
import { monthSpendMicros, seedDemoHistory } from './seed-history.ts';

/**
 * The Overview video (about twelve minutes): a high-level tour of the whole product for people who have never seen it.
 * The script is video/overview-script.md; the narration is narration/overview.ts. The demo organization "Acme" has two
 * projects with a month of history, a team of agents, a CEO, two workstations (one online, one off), a question on the
 * desk, a finished Discovery and a finished Boardroom (both run before the camera rolls, with the mock runtime).
 * Output: media/videos/overview.{webm,mp4,vtt,json} and the poster media/videos/overview.png
 *   e2e/video/record.sh overview
 */
const SLUG = 'overview';
const PASSWORD = 'demo-pass-2026-x';

test.afterAll(async () => {
  await pool.end();
});

/** An optional screen: when the page is not as expected the walk-through goes on and says so on the console. */
const soft = async (what: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (e) {
    console.warn(`overview: skipped "${what}": ${String(e).split('\n')[0]}`);
  }
};

/** A full-screen title card drawn over the page (removed by `clearCard`). */
async function titleCard(page: Page, title: string, lines: string[] = []) {
  await page.evaluate(
    ({ title, lines }) => {
      document.getElementById('gw-title-card')?.remove();
      const el = document.createElement('div');
      el.id = 'gw-title-card';
      el.style.cssText =
        'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:linear-gradient(135deg,#1e1b4b,#312e81 55%,#4338ca);color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:48px;opacity:0;transition:opacity .6s';
      const h = document.createElement('div');
      h.style.cssText =
        'font-size:46px;font-weight:700;letter-spacing:-.5px;max-width:980px;line-height:1.15';
      h.textContent = title;
      el.append(h);
      for (const l of lines) {
        const p = document.createElement('div');
        p.style.cssText = 'font-size:24px;opacity:.88;max-width:900px;line-height:1.35';
        p.textContent = l;
        el.append(p);
      }
      document.body.append(el);
      requestAnimationFrame(() => {
        el.style.opacity = '1';
      });
    },
    { title, lines },
  );
}
async function clearCard(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('gw-title-card');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 600);
  });
  await pause(700);
}

/** The start of each chapter in the script (video/overview-script.md), in seconds: the pace the tour keeps. */
const CHAPTER_START = [0, 45, 120, 170, 270, 330, 435, 510, 585, 645, 705, 750, 772];

/**
 * Lets the screen breathe until chapter `n` (1-based) is due, the way the script paces it: the pointer glides slowly
 * over the page (at most `maxSec`), so the picture stays alive while nobody speaks.
 */
async function holdUntilChapter(page: Page, now: () => number, n: number, maxSec = 40) {
  const end = now() + Math.min(maxSec, Math.max(0, (CHAPTER_START[n - 1] ?? 0) - 1 - now()));
  const pts: Array<[number, number]> = [
    [700, 300],
    [900, 460],
    [520, 520],
    [800, 200],
  ];
  let i = 0;
  while (now() + 4 < end) {
    const [x, y] = pts[i++ % pts.length] as [number, number];
    await page.mouse.move(x, y, { steps: 90 });
    await pause(1500);
  }
  const rest = end - now();
  if (rest > 0) await new Promise((r) => setTimeout(r, rest * 1000));
}

/** Invites `email` to Acme and accepts it through the link in the mail. */
async function inviteAndJoin(api: APIRequestContext, email: string, name: string, role: 'member' | 'admin') {
  await deleteMailFor(email);
  const r = await api.post('/api/org/invitations', { data: { email, role, projectIds: [] } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const mail = await waitForMail(email, 30_000);
  const token = new RegExp(`${BASE_URL.replace(/[.:/]/g, '\\$&')}/invite/([A-Za-z0-9_-]+)`).exec(
    mail.text,
  )?.[1];
  expect(token, mail.text).toBeTruthy();
  const { request } = await import('@playwright/test');
  const anon = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const accept = await anon.post(`/api/invitations/${token}/accept`, {
    data: { displayName: name, password: PASSWORD },
  });
  expect(accept.ok(), await accept.text()).toBeTruthy();
  await anon.dispose();
}

/** Off camera: a Discovery session answered up to its PRD draft (the analyst is the mock runtime). */
async function runDiscovery(browser: Browser, api: APIRequestContext) {
  const ctx = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  const dialog = page.getByRole('dialog');
  await page.goto('/discovery');
  await page.getByTestId('new-discovery').click();
  await dialog.getByLabel('Title').fill('Invoicing for freelancers');
  await dialog.getByLabel('Starting idea (optional)').fill('Invoices that chase late payers by themselves');
  await dialog.getByLabel('Project (optional)').selectOption({ label: 'SHOP: Web shop' });
  await dialog.getByLabel('How should the analyst work?').selectOption({ label: 'Facilitator' });
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/discovery\/[0-9a-f-]{36}$/);
  const isOpen = page.getByTestId('question-card').and(page.locator('[data-status="open"]'));
  for (let i = 0; i < 16; i++) {
    if (await page.getByTestId('session-drafts').getByTestId('doc-prd').isVisible()) break;
    const shown = await isOpen
      .last()
      .waitFor({ state: 'visible', timeout: 25_000 })
      .then(
        () => true,
        () => false,
      );
    if (!shown) continue;
    await isOpen.last().getByTestId('option-o1').click();
    await expect(isOpen).toHaveCount(0, { timeout: 30_000 });
    const proposal = page.getByTestId('proposal-card').first();
    if (await proposal.isVisible())
      await proposal
        .getByTestId('proposal-apply')
        .click()
        .catch(() => undefined);
  }
  await expect(page.getByTestId('session-drafts').getByTestId('doc-prd')).toBeVisible({ timeout: 90_000 });
  const url = page.url();
  await ctx.close();
  return url;
}

/** Off camera: a Boardroom that ran, had the Chair stop for a decision, and ended with its minutes. */
async function runBoardroom(browser: Browser, api: APIRequestContext) {
  const ctx = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  const dialog = page.getByRole('dialog');
  await page.goto('/boardroom');
  await page.getByTestId('new-boardroom').click();
  await dialog.getByLabel('Topic').fill('Should we launch a pilot with our first customer?');
  await dialog.getByLabel('Brief (optional)').fill('We have one friendly customer and eight weeks.');
  await dialog.getByLabel('Format').selectOption('pre_mortem');
  await dialog.getByRole('checkbox', { name: 'User Advocate' }).check();
  await dialog.getByRole('checkbox', { name: 'Cost Hawk' }).check();
  await dialog.getByLabel('Name', { exact: true }).fill('Regulator');
  await dialog
    .getByLabel('Brief', { exact: true })
    .fill('A cautious compliance officer who asks what could get us fined');
  await dialog.getByTestId('add-adhoc').click();
  await expect(dialog.getByRole('list', { name: 'Chosen cast' })).toContainText('Regulator');
  await dialog.getByLabel('Round cap').fill('6');
  await dialog.getByLabel('Cost limit in USD (optional)').fill('25');
  await dialog.getByLabel('Time limit').selectOption('60');
  for (const l of ['Personas run on', 'The Chair runs on', 'Minutes are written by'])
    await dialog.getByLabel(l).selectOption({ label: 'Mock: Mock' });
  await dialog.getByTestId('start-boardroom').click();
  await expect(page).toHaveURL(/\/boardroom\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('sealed-round')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('board-turn')).toHaveCount(5, { timeout: 120_000 });
  const card = page.getByTestId('decision-card').first();
  await expect(card).toContainText('The Chair needs your decision', { timeout: 120_000 });
  await card.getByTestId('decision-option-o2').click();
  await card.getByLabel('Your decision').fill('with ten paying users');
  await card.getByTestId('decide').click();
  await expect(page.getByTestId('decision-card').first()).toContainText('You decided', { timeout: 30_000 });
  await page.getByTestId('end-session').click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('This session is over')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('minutes-body')).toContainText('Unresolved disagreements', {
    timeout: 60_000,
  });
  const url = page.url();
  await ctx.close();
  return url;
}

let seeded: { api: APIRequestContext; qId: string; discoveryUrl: string } | undefined;

test('record the overview video', async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Guildwise HQ: a tour of the whole product',
    cues: allCues(),
    chapters: CHAPTERS,
    maxMb: 80,
    webmCrf: '40',
    mp4Crf: '30',
  });
  const api = await demoApi();
  // Web shop and Company blog, a month of finished work, a team (switched off with its workstation "Alex's laptop")
  const { shop } = await seedDemoHistory(api, { ceo: true });
  const spent = (await monthSpendMicros(shop)) / 1_000_000;
  const budget = Math.ceil(spent / 0.8 / 5) * 5; // a round number, so the meter sits just under 80 percent
  expect((await api.put(`/api/projects/${shop}/budget`, { data: { monthly: budget } })).status()).toBe(200);
  await inviteAndJoin(api, 'jamie.lee@demo.local', 'Jamie Lee', 'member');
  await inviteAndJoin(api, 'priya.shah@demo.local', 'Priya Shah', 'admin');

  // a second workstation that is online, with the analyst the Discovery and the Boardroom need
  const ws = await pairWorkstation(api, 'Build server', paths.runnerHome('video2'), {
    AOM_MOCK_STEP_MS: '250',
    AOM_MOCK_CHAT_TOKEN_MS: '10',
    AOM_MOCK_BOARD_DECIDE: '1',
  }).catch(async () => undefined);
  expect(ws, 'the second workstation').toBeTruthy();
  const wsId = ws as string;
  await hireAgent(api, {
    name: 'Ana',
    roleKey: 'analyst',
    seniority: 'senior',
    workstationId: wsId,
  });
  await waitFor(
    'the runner announces the session and board verbs',
    async () =>
      (
        await q<{ capabilities: string[] }>(
          'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
          [wsId],
        )
      )[0]?.capabilities,
    (c) => Array.isArray(c) && c.includes('session-verbs:1') && c.includes('board-verbs:1'),
    30_000,
  );
  const discoveryUrl = await runDiscovery(browser, api);
  const boardroomUrl = await runBoardroom(browser, api);

  // a question and an approval on the desk (the blocked card of the demo history waits for the answer)
  const [blocked] = await q<{ id: string; org_id: string; project_id: string }>(
    `SELECT c.id, p.org_id, c.project_id FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.project_id=$1 AND c.status='blocked' LIMIT 1`,
    [shop],
  );
  expect(blocked, 'a blocked card in the Web shop').toBeTruthy();
  const [builder] = await q<{ id: string }>(`SELECT id FROM agents WHERE name='Noah'`);
  const qId = randomUUID();
  const options = [
    { id: 'o1', label: 'Names only', description: 'Fast and predictable.' },
    { id: 'o2', label: 'Names and descriptions', description: 'Finds more, with a ranking step.' },
  ];
  await q(
    `INSERT INTO desk_items (id, org_id, project_id, card_id, kind, status, routed_to, title, body, doing, options,
       recommendation, blocking, affected_card_ids, asked_by_kind, asked_by_agent_id, asked_by_role, created_at, updated_at,
       ceo_recommendation)
     VALUES ($1,$2,$3,$4,'question','open','manager',$5,$6,$7,$8::jsonb,'o1',true,ARRAY[$4::uuid],'agent',$9,'builder',
       now() - interval '20 minutes', now(), $10::jsonb)`,
    [
      qId,
      blocked?.org_id,
      blocked?.project_id,
      blocked?.id,
      'Should the search also match product descriptions, or only names?',
      'Matching descriptions finds more, but also more noise. Names only is faster and simpler.',
      'building the search box',
      JSON.stringify(options),
      builder?.id ?? null,
      JSON.stringify({
        actionId: randomUUID(),
        option: 'o1',
        text: null,
        reason: 'Most shoppers type a product name; names only keeps the search fast.',
        confidence: 0.84,
        at: new Date().toISOString(),
      }),
    ],
  );
  await q(
    `INSERT INTO desk_items (id, org_id, project_id, kind, subkind, status, routed_to, title, body, blocking, created_at, updated_at)
     VALUES ($1,$2,$3,'approval','devops','open','manager','DevOps needs approval: install docker',
       'Installing Docker on the workstation is outside the access you granted the DevOps engineer.',false,
       now() - interval '5 minutes', now())`,
    [randomUUID(), blocked?.org_id, blocked?.project_id],
  );

  seeded = { api, qId, discoveryUrl };
  // the platform administrator signs in off camera (two-factor setup); the video swaps to its session for one page
  const platform = await platformLogin(browser);
  const ownerCookies = (await api.storageState()).cookies;
  const platformCookies = (await platform.api.storageState()).cookies;

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const { page, narrate, chapter, now, finish } = await startRecording(prepared, browser, api);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const link = (name: string | RegExp) =>
    nav.getByRole('link', typeof name === 'string' ? { name, exact: true } : { name });
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  const ctx = page.context();

  // ---- 1. Welcome ---------------------------------------------------------------------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await pause(3000);
  await narrate('intro-1', async () => {
    await pause(1500);
    const logo = nav.locator('img, svg').first();
    const box = await logo.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    await pause(2500);
    await titleCard(page, 'Guildwise HQ', ['Run an organization of AI agents.']);
    await pause(4500);
    await clearCard(page);
  });
  await chapter(1);
  await narrate('c1-a');
  await narrate('c1-b', async () => {
    await page.mouse.move(640, 420, { steps: 30 });
    await pause(2000);
  });
  await narrate('c1-c');
  await narrate('c1-d');

  // ---- 2. A team of agents ------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 2);
  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, link(/^Agents/));
    await expect(page.getByTestId('agent-Noah')).toBeVisible();
    await pause(1500);
  });
  await narrate('c2-b', async () => {
    await soft('hover an agent', async () => {
      const a = page.getByTestId('agent-Noah');
      const box = await a.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
      await pause(1500);
      await a.click();
      await pause(2500);
    });
  });
  await narrate('c2-c', async () => {
    await pause(2000);
  });
  await narrate('c2-d', async () => {
    await soft('back to the list', async () => {
      await click(page, link(/^Agents/));
    });
  });

  // ---- 3. Organization -----------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 3);
  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('nav-organization'));
    await expect(page.getByText('Acme · you are the Owner')).toBeVisible();
    await pause(1500);
  });
  await narrate('c3-b', async () => {
    await click(page, tab('Members'));
    await expect(page.getByText('Jamie Lee').first()).toBeVisible();
    await pause(2500);
  });
  await narrate('c3-c', async () => {
    await pause(2500);
  });

  // ---- 4. The board ---------------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 4);
  await chapter(4);
  const chip = (name: string | RegExp) =>
    page.getByRole('group', { name: 'Filters' }).getByRole('button', { name });
  await narrate('c4-a', async () => {
    await click(page, link('Board'));
    await expect(page.getByTestId('board')).toBeVisible();
    await pause(1500);
    await click(page, page.getByRole('link', { name: 'New card' }).first());
    await pause(2500);
    await click(page, link('Board'));
    await expect(page.getByTestId('board')).toBeVisible();
  });
  await narrate('c4-b', async () => {
    await page.mouse.move(300, 380, { steps: 30 });
    await page.mouse.move(1000, 380, { steps: 60 });
  });
  await narrate('c4-c', async () => {
    await page.mouse.move(640, 500, { steps: 30 });
    await pause(2000);
  });
  await narrate('c4-d', async () => {
    await click(page, chip('Blocked'));
    await pause(1800);
    await click(page, chip('Blocked'));
    await soft('approval chip', async () => {
      await click(page, chip(/^Waiting for my approval/));
      await pause(1500);
      await click(page, chip(/^Waiting for my approval/));
    });
  });
  await narrate('c4-e', async () => {
    await soft('open a card', async () => {
      await click(page, page.locator('[data-testid^="card-tile-"]').first());
      await expect(page).toHaveURL(/\/cards\/[^/]+$/);
      await pause(1500);
      await page
        .getByRole('heading', { name: 'Thread' })
        .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      await pause(2000);
    });
  });

  // ---- 5. Your desk ---------------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 5);
  await chapter(5);
  const itemEl = page.getByTestId(`desk-item-${qId}`);
  await narrate('c5-a', async () => {
    const badge = page.getByTestId('desk-badge');
    const box = await badge.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    await pause(1200);
    await click(page, link(/^Desk/));
    await expect(page.getByTestId('desk-list')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your desk' })).toBeVisible();
  });
  await narrate('c5-b', async () => {
    await itemEl.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(1500);
    await click(page, itemEl.getByRole('radio', { name: /^Names and descriptions/ }));
  });
  await narrate('c5-c', async () => {
    await itemEl.getByLabel('Add to ledger as').selectOption({ label: 'Standing order (this project)' });
    await pause(2500);
  });
  await narrate('c5-d', async () => {
    await soft('recommendation', async () => {
      await itemEl
        .getByTestId('ceo-recommendation')
        .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await pause(2500);
    });
  });

  // ---- 6. Discovery and the Boardroom -----------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 6);
  await chapter(6);
  const dialog = page.getByRole('dialog');
  await narrate('c6-a', async () => {
    await click(page, link('Discovery'));
    await expect(page.getByTestId('new-discovery')).toBeVisible();
    await pause(1500);
  });
  await narrate('c6-b', async () => {
    await click(page, page.getByTestId('new-discovery'));
    await type(page, dialog.getByLabel('Title'), 'Loyalty points for shoppers');
    const stance = dialog.getByLabel('How should the analyst work?');
    await stance.selectOption({ label: 'Partner' });
    await pause(1500);
    await stance.selectOption({ label: 'Ideate for me' });
    await pause(1500);
    await stance.selectOption({ label: 'Facilitator' });
    await pause(800);
    await page.keyboard.press('Escape');
    await soft('close the dialog', async () => {
      if (await dialog.isVisible()) await click(page, dialog.getByRole('button', { name: 'Cancel' }));
    });
    await page.goto(discoveryUrl);
    await expect(page.getByTestId('question-card').first()).toBeVisible({ timeout: 30_000 });
    await pause(2500);
  });
  await narrate('c6-c', async () => {
    const drafts = page.getByTestId('session-drafts');
    await drafts.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(2500);
    await soft('validate', async () => {
      await click(page, drafts.getByTestId('validate-prd'));
      await expect(drafts.getByTestId('prd-validation')).toBeVisible({ timeout: 60_000 });
      await pause(1500);
    });
  });
  await narrate('c6-d', async () => {
    await click(page, link('Boardroom'));
    await expect(page.getByTestId('new-boardroom')).toBeVisible();
    await click(page, page.getByTestId('new-boardroom'));
    await pause(2500);
    await dialog
      .getByTestId('fixed-seat-optimist')
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await pause(2500);
    await page.keyboard.press('Escape');
    await soft('close the dialog', async () => {
      if (await dialog.isVisible()) await click(page, dialog.getByRole('button', { name: 'Cancel' }));
    });
    await page.goto(boardroomUrl);
    await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId('whiteboard')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(2500);
  });
  await narrate('c6-e', async () => {
    await page
      .getByTestId('minutes-panel')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(3000);
  });

  // ---- 7. Agents, CEO, org chart ------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 7);
  await chapter(7);
  await narrate('c7-a', async () => {
    await click(page, link(/^Agents/));
    await click(page, page.getByRole('button', { name: 'Hire agent' }).first());
    const form = page.getByRole('form', { name: 'Hire agent' });
    await expect(form).toBeVisible();
    await form.getByLabel('Role', { exact: true }).selectOption({ label: 'Tester' });
    await pause(900);
    await form.getByLabel('Seniority').selectOption('senior');
    await pause(900);
    await form.getByLabel('Runtime').selectOption('mock');
    await pause(900);
    await form
      .getByLabel('Allow SHOP')
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await pause(1500);
    await page.keyboard.press('Escape');
    await soft('cancel the form', async () => {
      if (await form.isVisible()) await click(page, form.getByRole('button', { name: 'Cancel' }));
    });
  });
  await narrate('c7-b', async () => {
    await click(page, link('CEO'));
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await pause(2500);
    await click(page, tab('Reporting & alerts'));
    await pause(2500);
    await click(page, tab('Activity log'));
    await pause(1500);
  });
  await narrate('c7-c', async () => {
    await click(page, link(/^Org chart/));
    await expect(
      page
        .getByTestId('org-chart')
        .or(page.getByRole('heading', { name: /Org chart/ }))
        .first(),
    ).toBeVisible();
    await pause(3000);
  });

  // ---- 8. Workstations ----------------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 8);
  await chapter(8);
  await narrate('c8-a', async () => {
    await click(page, link(/^Workstations/));
    const ws1 = page.getByTestId("workstation-Alex's laptop");
    const ws2 = page.getByTestId('workstation-Build server');
    await expect(ws1).toBeVisible();
    await expect(ws2).toBeVisible();
    for (const w of [ws2, ws1]) {
      const dot = await w.getByTestId('connection-dot').first().boundingBox();
      if (dot) await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2, { steps: 25 });
      await pause(1800);
    }
  });
  await narrate('c8-b', async () => {
    await click(page, page.getByTestId('add-workstation-button'));
    await expect(page.getByTestId('add-workstation')).toBeVisible();
    await pause(1500);
    await soft('wizard steps', async () => {
      await click(page, page.getByTestId('where-local'));
      await click(page, page.getByTestId('os-linux'));
      await expect(page.getByTestId('install-command')).toBeVisible();
      await pause(2500);
    });
    await page.keyboard.press('Escape');
    await soft('close the wizard', async () => {
      const d = page.getByTestId('add-workstation');
      if (await d.isVisible()) await click(page, d.getByRole('button', { name: /Cancel|Close/ }).first());
    });
  });
  await narrate('c8-c', async () => {
    await pause(3000);
  });
  await narrate('c8-d', async () => {
    await pause(2000);
  });
  await narrate('c8-e', async () => {
    await soft('shifts at once', async () => {
      const w = page.getByTestId('workstation-Build server');
      await click(page, w.getByTestId('workstation-toggle'));
      await expect(w.getByTestId('workstation-details')).toBeVisible();
      const limit = w.getByLabel('Shifts at once');
      await limit.scrollIntoViewIfNeeded();
      const box = await limit.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
      await pause(2500);
    });
    await soft('integrations tiles', async () => {
      await click(page, link(/^Integrations/));
      await pause(2500);
    });
  });

  // ---- 9. Control ----------------------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 9);
  await chapter(9);
  await narrate('c9-a', async () => {
    await click(page, link(/^Costs/));
    await soft('last 30 days', async () => {
      await click(
        page,
        page.getByRole('group', { name: 'Range' }).getByRole('button', { name: 'Last 30 days' }),
      );
    });
    await expect(page.getByText('Total spend').first()).toBeVisible();
    await pause(2500);
    await page.evaluate(() => window.scrollBy({ top: 420, behavior: 'smooth' }));
    await pause(2500);
  });
  await narrate('c9-b', async () => {
    await click(page, link(/^Desk/));
    await soft('approvals', async () => {
      await page
        .getByRole('group', { name: 'Filter items' })
        .getByRole('button', { name: /^Approvals/ })
        .click();
      await pause(2500);
    });
  });
  await narrate('c9-c', async () => {
    await click(page, page.getByTestId('nav-organization'));
    await click(page, tab('Audit log'));
    await pause(3500);
  });
  await narrate('c9-d', async () => {
    await pause(1500);
  });

  // ---- 10. Releases, environments, integrations ----------------------------------------------------------------------
  await holdUntilChapter(page, now, 10);
  await chapter(10);
  await narrate('c10-a', async () => {
    await click(page, link(/^Releases/));
    await pause(2000);
    await soft('freeze', async () => {
      await click(page, page.getByTestId('releases-tab-rules'));
      await expect(page.getByTestId('freeze-toggle')).toBeVisible();
      await pause(2000);
    });
  });
  await narrate('c10-b', async () => {
    await click(page, link(/^Environments/));
    await pause(3500);
  });
  await narrate('c10-c', async () => {
    await click(page, link(/^Integrations/));
    await pause(2000);
    await soft('open a workstation', async () => {
      await page.getByText('Build server').first().click();
      await pause(2500);
    });
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await pause(2500);
  });

  // ---- 11. Run it yourself, or let us host it ----------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 11);
  await chapter(11);
  await narrate('c11-a', async () => {
    await titleCard(page, 'Free and open source', [
      'Apache 2.0 license',
      'Run it yourself: a server, a domain name and an email relay',
      'github.com/exinarium/GuildwiseHQ',
    ]);
    await pause(6000);
    await clearCard(page);
  });
  await narrate('c11-b', async () => {
    await ctx.clearCookies();
    await ctx.addCookies(platformCookies);
    await page.goto('/platform/invitations');
    await expect(page.getByTestId('new-org-form')).toBeVisible();
    await pause(3000);
  });

  // ---- 12. Closing ---------------------------------------------------------------------------------------------------------------
  await holdUntilChapter(page, now, 12);
  await chapter(12);
  await narrate('c12-a', async () => {
    await ctx.clearCookies();
    await ctx.addCookies(ownerCookies);
    await page.goto('/p/SHOP/board');
    await expect(page.getByTestId('board')).toBeVisible();
    await pause(3000);
  });
  await narrate('c12-b', async () => {
    await titleCard(page, 'Guildwise HQ. Free and open source.', ['github.com/exinarium/GuildwiseHQ']);
    await pause(3500);
  });
  await holdUntilChapter(page, now, 13, 20);
  await pause(1500);

  await finish();
});

/** The 55-second teaser, recorded on the stack the overview just used (so it must run after the overview, in this file). */
test('record the overview teaser', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  expect(seeded, 'the overview test seeds the stack first').toBeTruthy();
  const { api, qId, discoveryUrl } = seeded as NonNullable<typeof seeded>;
  const prepared = prepareVideo({
    slug: 'overview-teaser',
    title: 'Guildwise HQ in 55 seconds',
    cues: TEASER_CUES,
    chapters: TEASER_CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await chapter(1);
  await narrate('t1', async () => {
    await page.mouse.move(250, 330, { steps: 30 });
    await page.mouse.move(1000, 330, { steps: 80 });
    await pause(3500);
  });
  await narrate('t2', async () => {
    await titleCard(page, 'Guildwise HQ', ['Run an organization of AI agents.']);
    await pause(8000);
    await clearCard(page);
  });
  await narrate('t3', async () => {
    await click(page, nav.getByRole('link', { name: /^Desk/ }));
    const item = page.getByTestId(`desk-item-${qId}`);
    await item.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(1200);
    await click(page, item.getByRole('radio', { name: /^Names and descriptions/ }));
    await pause(4500);
  });
  await narrate('t4', async () => {
    await page.goto(discoveryUrl);
    await expect(page.getByTestId('session-drafts')).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId('session-drafts')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(6500);
  });
  await narrate('t5', async () => {
    await click(page, nav.getByRole('link', { name: /^Workstations/ }));
    await expect(page.getByTestId('workstation-Build server')).toBeVisible();
    const dot = await page
      .getByTestId('workstation-Build server')
      .getByTestId('connection-dot')
      .first()
      .boundingBox();
    if (dot) await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2, { steps: 25 });
    await pause(5500);
  });
  await narrate('t6', async () => {
    await titleCard(page, 'Free and open source', ['Apache 2.0 license', 'github.com/exinarium/GuildwiseHQ']);
    await pause(6000);
  });
  await finish();
});
