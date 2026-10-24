import { expect, type Page, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { caption, click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, BA_ANSWER, BA_QUESTION, CHAPTERS, DESK_QUESTION } from './narration/getting-started.ts';
import { demoApi, pairWorkstation } from './seed.ts';

/**
 * The "Getting started" video (plan entry G in docs/guide/VIDEO-PLAN.md): from an empty organization to a team at work.
 * The Get started checklist, the Add a workstation wizard (shown, not waited on: the demo workstation is already
 * paired), a project and its repository, the lean team, a card from the sidebar's New card button, a talk with the
 * business analyst, answering the planner's question on the Desk, the card moving on the Board by itself, and where
 * Help, the tour and Ctrl K are. A fresh local stack and the mock agent runtime (no real Claude, GitHub or Jira).
 *
 *   e2e/video/setup-voice.sh            once: Kokoro, the voice and a static ffmpeg into ~/.cache/aom-video
 *   pnpm build && e2e/video/record.sh getting-started
 *
 * Output: media/videos/getting-started.{webm,mp4,vtt,json}
 */
const SLUG = 'getting-started';

/** What the mock agents do with the card made on camera: the planner asks once (the BA passes it on), then all is ok. */
const MOCK_SCRIPT = { planning: ['question', 'ok'], question: ['escalate', 'escalate'] };

/** What the BA's step on the escalation trail says (the mock BA passes questions on with "mock ba: cannot settle ..."). */
const BA_TRAIL_NOTE = 'a product decision for the owner';

/**
 * A copy of an API response without the mock runtime's scaffolding: the script (`fields.mock`) is left out, and the
 * mock agents' fixed notes on an escalation trail get the words a real analyst would write.
 */
function withoutMock(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutMock);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'fields' && x && typeof x === 'object' && !Array.isArray(x)) {
      const { mock: _mock, ...rest } = x as Record<string, unknown>;
      out[k] = withoutMock(rest);
    } else if (k === 'escalationTrail' && Array.isArray(x)) {
      out[k] = x.map((step: Record<string, unknown>) =>
        typeof step?.note === 'string' && step.note.startsWith('mock ')
          ? { ...step, note: BA_TRAIL_NOTE }
          : step,
      );
    } else out[k] = withoutMock(x);
  }
  return out;
}

test.afterAll(async () => {
  await pool.end();
});

/** The sidebar link `name` (the Main navigation and its footer). */
const nav = (page: Page, name: string | RegExp) =>
  page.getByRole('link', { name, exact: typeof name === 'string' }).first();

/**
 * The mock agent asks a fixed sentence ("Mock question for SHOP-1?"): as soon as the planner's question exists, give it
 * the words a real planner would use (the same rewording the guide screenshots do). Returns the desk item id.
 */
async function rewordQuestion(): Promise<string> {
  const item = await waitFor(
    "the planner's question",
    () =>
      q<{ id: string }>(
        `SELECT d.id FROM desk_items d JOIN cards c ON c.id = d.card_id
          WHERE c.ref = 'SHOP-1' AND d.kind = 'question' AND d.status = 'open'`,
      ),
    (r) => r.length > 0,
    240_000,
  );
  const id = item[0]?.id as string;
  const options = DESK_QUESTION.options.map(([label, description], i) => ({
    id: `o${i + 1}`,
    label,
    description,
  }));
  await q(
    `UPDATE desk_items SET title=$2, body=$3, doing=$4, options=$5::jsonb, recommendation=$6 WHERE id=$1`,
    [
      id,
      DESK_QUESTION.title,
      DESK_QUESTION.body,
      DESK_QUESTION.doing,
      JSON.stringify(options),
      `o${DESK_QUESTION.recommend + 1}`,
    ],
  );
  return id;
}

test('record the getting-started video', async ({ browser }) => {
  // ---- before the camera rolls: the voice, the scripted BA answer and the demo workstation ---------------------------
  const prepared = prepareVideo(
    {
      slug: SLUG,
      title: 'Getting started with Guildwise HQ',
      cues: allCues(),
      chapters: CHAPTERS,
    },
    { [BA_QUESTION]: BA_ANSWER },
  );
  // no CEO: the video starts from an empty organization and hires the team on camera
  const api = await demoApi({ ceo: false });
  await pairWorkstation(api);
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // The card made on camera carries the mock agents' script (test data for the mock runtime, never shown).
  await page.route('**/api/cards', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const body = JSON.parse(req.postData() ?? '{}');
    body.fields = { ...(body.fields ?? {}), mock: MOCK_SCRIPT };
    await route.continue({ postData: JSON.stringify(body) });
  });
  // ... and the card page never shows that script (in mock mode it lists it under "What to build").
  // ... and the Desk shows its question without the mock agents' fixed notes
  for (const pattern of ['**/api/cards/**', '**/api/desk**']) {
    await page.route(pattern, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      if (!(res.headers()['content-type'] ?? '').includes('json')) return route.fulfill({ response: res });
      await route.fulfill({ response: res, json: withoutMock(await res.json()) });
    });
  }

  // ---- intro: the empty organization ----------------------------------------------------------------------------
  await page.goto('/desk');
  await expect(page.getByTestId('setup-widget')).toBeVisible();
  await narrate('intro-1');

  // ---- 1. the Get started checklist ------------------------------------------------------------------------------
  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('setup-widget'));
    await expect(page.getByTestId('setup-checklist')).toBeVisible();
    await pause(4000);
    await page.mouse.move(640, 330, { steps: 20 });
    await pause(3000);
    await click(page, page.getByRole('dialog').getByRole('button', { name: 'Close' }).last());
  });

  // ---- 2. a workstation ------------------------------------------------------------------------------------------
  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, nav(page, 'Workstations'));
    await click(page, page.getByTestId('add-workstation-button'));
    await expect(page.getByTestId('add-workstation')).toBeVisible();
  });
  await narrate('c2-b', async () => {
    await expect(page.getByTestId('install-steps')).toBeVisible();
    await page.getByTestId('install-steps').scrollIntoViewIfNeeded();
    await pause(2500);
    await page.getByTestId('install-progress').scrollIntoViewIfNeeded();
    await pause(2500);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('add-workstation')).toHaveCount(0);
    await expect(page.getByText("Alex's laptop").first()).toBeVisible();
  });

  // ---- 3. a project and its repository ---------------------------------------------------------------------------
  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, nav(page, 'Projects'));
    await click(page, page.getByRole('button', { name: /new project/i }).first());
    const dlg = page.getByRole('form', { name: 'New project' });
    await type(page, dlg.getByLabel('Name'), 'Web shop');
    await click(page, dlg.getByLabel('Key'), 100);
    await dlg.getByLabel('Key').fill('');
    await dlg.getByLabel('Key').pressSequentially('SHOP', { delay: 90 });
    await pause(500);
    await click(page, dlg.getByRole('button', { name: 'Create project' }));
    await expect(page.getByRole('link', { name: 'Settings for SHOP' })).toBeVisible();
  });
  await narrate('c3-b', async () => {
    await click(page, page.getByRole('link', { name: 'Settings for SHOP' }));
    const add = page.getByRole('form', { name: 'Add repository' });
    await click(page, add.getByLabel('Remote URL'), 100);
    await add.getByLabel('Remote URL').fill(paths.origin);
    await type(page, add.getByLabel('Repository name'), 'shop', 200);
    await click(page, add.getByRole('button', { name: 'Add repository' }));
    await expect(page.getByTestId('repos')).toContainText('shop');
  });

  // ---- 4. the lean team --------------------------------------------------------------------------------------------
  await chapter(4);
  const hire = async (role: string, name: string, showAccess = false) => {
    await click(page, page.getByRole('button', { name: 'Hire agent' }).first(), 300);
    const form = page.getByRole('form', { name: 'Hire agent' });
    await form.getByLabel('Role', { exact: true }).selectOption({ label: role });
    await form.getByLabel('Runtime').selectOption('mock');
    if (showAccess) {
      const access = page.getByTestId('hire-editor');
      await access.scrollIntoViewIfNeeded();
      const box = await access.boundingBox();
      if (box) await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 20 });
      await pause(2500);
    }
    await type(page, form.getByLabel('Name', { exact: true }), name, 150);
    await click(page, form.getByRole('button', { name: 'Hire', exact: true }), 200);
    await expect(page.getByTestId(`agent-${name}`)).toBeVisible();
  };
  await narrate('c4-a', async () => {
    await click(page, nav(page, 'Agents'));
    await hire('Business analyst', 'Bea', true);
  });
  await narrate('c4-b', async () => {
    await hire('Planner', 'Pia');
    await hire('Architect', 'Ari');
    await hire('Builder', 'Ada');
  });
  await narrate('c4-c', async () => {
    await hire('Pre-reviewer', 'Remy');
    await hire('Reviewer', 'Linus');
    await hire('Tester', 'Tess');
  });

  // ---- 5. a card from the sidebar, and a talk with the BA ---------------------------------------------------------
  await chapter(5);
  const form = page.getByRole('form', { name: 'New card' });
  await narrate('c5-a', async () => {
    await click(page, page.getByRole('link', { name: 'New card' }).first());
    await expect(form).toBeVisible();
    await type(page, form.getByLabel('Title', { exact: true }), 'Show a welcome banner', 200);
    await form.getByLabel('Repository').selectOption({ label: 'shop' });
    await form.getByLabel('Context', { exact: true }).fill('Visitors do not know what the shop sells.');
    await form.getByLabel('Requirements').fill('Show a welcome banner on the home page.');
    await form.getByLabel('Acceptance criteria').fill('The banner is visible\nIt can be closed');
    await form.getByLabel('Affected areas').fill('index.js');
    await form.getByLabel('Constraints').fill('None');
    await form.getByLabel('Test plan').fill('Open the home page and close the banner');
    await pause(600);
    await click(page, form.getByRole('button', { name: 'Specify', exact: true }));
    await expect(page).toHaveURL(/\/cards\/SHOP-1$/);
  });
  // the planner picks the card up and asks; give the question its words while the BA talks
  const reworded = rewordQuestion();
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await narrate('c5-b', async () => {
    await click(page, page.getByRole('button', { name: 'Chat with an agent' }));
    const bea = drawer.getByLabel('Agent').locator('option', { hasText: 'Bea' });
    await drawer.getByLabel('Agent').selectOption((await bea.getAttribute('value')) as string);
    await click(page, drawer.getByRole('button', { name: 'Start chat' }));
    await type(page, drawer.getByLabel('Message'), BA_QUESTION, 200);
    await click(page, drawer.getByRole('button', { name: 'Send' }));
  });
  await narrate('c5-c', async () => {
    await expect(drawer.getByTestId('chat-message').last()).toContainText('search box', { timeout: 60_000 });
  });
  await pause(1500);
  await page.keyboard.press('Escape');

  // ---- 6. answer on the Desk ---------------------------------------------------------------------------------------
  await chapter(6);
  const deskId = await reworded;
  const item = page.getByTestId(`desk-item-${deskId}`);
  await narrate('c6-a', async () => {
    await waitFor(
      'the question reaches the desk',
      // the BA has passed it on: its step (with the mock's fixed note) is on the escalation trail
      () =>
        q<{ passed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(escalation_trail) e WHERE e->>'note' LIKE 'mock %') AS passed
             FROM desk_items WHERE id=$1`,
          [deskId],
        ),
      (r) => r[0]?.passed === true,
      180_000,
    );
    await click(page, nav(page, /^Desk/));
    await expect(item).toBeVisible();
    await item.scrollIntoViewIfNeeded();
  });
  await narrate('c6-b', async () => {
    await click(page, item.getByRole('radio', { name: new RegExp(`^${DESK_QUESTION.options[0]?.[0]}`) }));
    await click(page, item.getByRole('button', { name: 'Answer', exact: true }));
    await expect(item).toHaveCount(0);
  });

  // ---- 7. the board ------------------------------------------------------------------------------------------------
  await chapter(7);
  await narrate('c7-a', async () => {
    await click(page, nav(page, 'Board'));
    await expect(page.getByTestId('board')).toBeVisible();
    const tile = page.getByTestId('card-tile-SHOP-1');
    await expect(tile).toBeVisible();
    const box = await tile.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
    // the planner finishes and the card moves on to Investigate & design while the viewer watches
    await waitFor(
      'SHOP-1 leaves Planning',
      () => q<{ stage: string }>(`SELECT stage FROM cards WHERE ref='SHOP-1'`),
      (r) => !!r[0] && r[0].stage !== 'planning' && r[0].stage !== 'spec',
      120_000,
    );
  });
  await pause(3000);

  // ---- 8. Help, the tour and Ctrl K ------------------------------------------------------------------------------
  await chapter(8);
  await narrate('c8-a', async () => {
    await click(page, nav(page, 'Help'));
    await expect(page.getByTestId('help-tour')).toBeVisible();
    const tour = page.getByTestId('help-replay-tour');
    // the tour card at the top of the view (the Help centre opens with this very video above it)
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-testid="help-tour"]');
      if (el) { el.scrollIntoView({ block: 'start' }); let p = el.parentElement; while (p && p !== document.documentElement && p.scrollHeight <= p.clientHeight + 1) p = p.parentElement; (p || document.documentElement).scrollBy(0, -110); }
    })()`);
    await pause(300);
    const box = await tour.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
    await pause(2500);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('combobox')).toBeVisible();
    await page.getByRole('combobox').pressSequentially('board', { delay: 90 });
  });
  await page.keyboard.press('Escape');
  await caption(page, 'A workstation, a project, a team and a card. More in Help.', undefined);
  await narrate('outro-1');

  // ---- finish: mix the voice into the recording, write the captions and the chapter list ----------------------------
  await finish();
});
