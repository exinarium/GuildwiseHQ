import { expect, type Locator, type Page, test } from '@playwright/test';
import { pool, q } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { killRunner } from '../support/runner.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/integrations.ts';
import { createProject, demoApi, pairWorkstation } from './seed.ts';

/**
 * The Integrations video (sidebar section 15): the workstation chooser, the Claude Code tiles and Connect another
 * account, a git host and Jira, and signing in and out of an MCP server. Nothing is really connected: the mock runner
 * reports no integrations, so the facts a runner would report are written straight into its table (demo accounts only),
 * and every dialog is cancelled before it would ask the runner to act.
 * Output: apps/web/public/videos/integrations.{webm,mp4,vtt,json}
 *   e2e/video/record.sh integrations
 */
const SLUG = 'integrations';

test.afterAll(async () => {
  await pool.end();
});

const DAY = 86_400_000;

async function report(workstationId: string, statuses: Array<Record<string, unknown>>): Promise<void> {
  const checkedAt = new Date(Date.now() - 12 * 60_000).toISOString();
  for (const s of statuses) {
    const status: Record<string, unknown> = { checkedAt, ...s };
    await q(
      `INSERT INTO workstation_integrations (workstation_id, kind, instance, status, checked_at)
       VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (workstation_id, kind, instance) DO UPDATE
         SET status=EXCLUDED.status, checked_at=EXCLUDED.checked_at`,
      [workstationId, status.kind, status.instance, JSON.stringify(status), checkedAt],
    );
  }
}

async function pointAt(page: Page, target: Locator, dx = 0.5): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * dx, box.y + box.height / 2, { steps: 25 });
}

async function scrollTo(page: Page, target: Locator): Promise<void> {
  // brings the element near the top of the page (smoothly), leaving room for the step banner
  const box = await target.boundingBox();
  if (box) await page.evaluate(`window.scrollBy({ top: ${Math.round(box.y - 90)}, behavior: 'smooth' })`);
  await pause(900);
}

test('record the integrations video', async ({ browser }) => {
  // ---- seed (demo data only): two workstations, two Claude accounts, GitHub, Jira and two plugin MCP servers ----------
  const api = await demoApi();
  await createProject(api, 'SHOP', 'Web shop');
  const studioHome = paths.runnerHome('video-studio');
  const studioId = await pairWorkstation(api, 'Studio Mac mini', studioHome);
  killRunner('SIGKILL', studioHome); // offline
  const laptopId = await pairWorkstation(api, "Alex's laptop");
  const [ws] = await q<{ integrations_version: number | null }>(
    'SELECT integrations_version FROM workstations WHERE id=$1',
    [laptopId],
  );
  expect(ws?.integrations_version, 'the runner announces the integrations protocol').not.toBeNull();

  await report(laptopId, [
    {
      kind: 'claude-code',
      instance: '',
      state: 'connected',
      method: 'claude_login',
      account: 'alex.morgan@example.com',
      scope: 'machine',
    },
    {
      kind: 'claude-code',
      instance: 'work',
      state: 'connected',
      method: 'setup_token',
      account: 'builds@example.com',
      expiresAt: new Date(Date.now() + 300 * DAY).toISOString(),
      scope: 'workstation',
    },
    {
      kind: 'github',
      instance: 'github.com',
      state: 'connected',
      method: 'token',
      account: 'acme-builds',
      scopes: ['repo', 'workflow', 'read:org'],
      expiresAt: new Date(Date.now() + 80 * DAY).toISOString(),
      scope: 'machine',
    },
    {
      kind: 'jira',
      instance: '',
      state: 'connected',
      method: 'token',
      account: 'alex.morgan@example.com',
      site: 'https://acme.example.com',
      scope: 'workstation',
    },
    { kind: 'mcp', instance: 'design-files', state: 'connected', method: 'oauth_paste', scope: 'machine' },
    {
      kind: 'mcp',
      instance: 'docs-search',
      state: 'needs_sign_in',
      method: 'oauth_paste',
      scope: 'machine',
      detail: 'Sign in once in your browser; the agents then use that sign-in.',
    },
  ]);
  await report(studioId, [
    {
      kind: 'claude-code',
      instance: '',
      state: 'expired',
      method: 'claude_login',
      account: 'alex.morgan@example.com',
      scope: 'machine',
      detail: 'The login expired. Sign in again.',
    },
  ]);

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Integrations',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: starts on the Board, then opens Integrations from the sidebar --------------------------------
  await page.goto('/p/SHOP/board');
  const nav = page.getByTestId('nav-integrations');
  await expect(nav).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, nav);
    await expect(page.getByTestId('workstation-chooser')).toBeVisible();
    await pause(1000);
    await pointAt(page, page.getByTestId(`choose-${studioId}`).getByTestId('needs-attention'));
    await pause(1500);
    await click(page, page.getByTestId(`choose-${laptopId}`));
    await expect(page.getByRole('heading', { name: "Integrations on Alex's laptop" })).toBeVisible();
  });

  await chapter(2);
  const main = page.getByTestId('tile-claude-code');
  const work = page.getByTestId('tile-claude-code:work');
  await narrate('c2-a', async () => {
    await expect(main).toBeVisible();
    await pointAt(page, main.getByTestId('tile-main-account'));
    await pause(2500);
    await pointAt(page, work.getByRole('heading'), 0.3);
  });
  await narrate('c2-b', async () => {
    await scrollTo(page, work);
    await pointAt(page, work.getByTestId('tile-facts'), 0.2);
    await pause(2500);
    await pointAt(page, work.getByRole('button', { name: 'Test' }));
    await pause(1500);
    await pointAt(page, work.getByRole('button', { name: 'Remove' }));
  });
  await narrate('c2-c', async () => {
    await click(page, page.getByTestId('connect-another-claude-code'));
    const dlg = page.getByTestId('connect-dialog-claude-code');
    await expect(dlg).toBeVisible();
    await pause(1500);
    await pointAt(page, dlg.getByText('How do you want to connect?'), 0.2);
    await pause(2000);
    await pointAt(page, dlg.getByRole('button', { name: 'Start sign-in' }));
    await pause(800);
    await click(page, dlg.getByRole('button', { name: 'Cancel' }));
    await expect(dlg).toBeHidden();
  });

  await chapter(3);
  const github = page.getByTestId('tile-github:github.com');
  const jira = page.getByTestId('tile-jira');
  await narrate('c3-a', async () => {
    await scrollTo(page, page.getByTestId('group-git'));
    await pointAt(page, github.getByTestId('tile-scopes'), 0.3);
    await pause(1500);
  });
  await narrate('c3-b', async () => {
    await scrollTo(page, page.getByTestId('group-tracker'));
    await pointAt(page, jira.getByTestId('tile-facts'), 0.2);
    await pause(1500);
  });

  await chapter(4);
  const signedIn = page.getByTestId('tile-mcp:design-files');
  const needsSignIn = page.getByTestId('tile-mcp:docs-search');
  await narrate('c4-a', async () => {
    await scrollTo(page, page.getByTestId('group-mcp'));
    await click(page, needsSignIn.getByRole('button', { name: 'Sign in', exact: true }));
    const dlg = page.getByTestId('connect-dialog-mcp');
    await expect(dlg).toBeVisible();
    await pause(1500);
    await pointAt(page, dlg.getByRole('button', { name: 'Start sign-in' }));
    await pause(800);
    await click(page, dlg.getByRole('button', { name: 'Cancel' }));
    await expect(dlg).toBeHidden();
  });
  await narrate('c4-b', async () => {
    await click(page, signedIn.getByRole('button', { name: 'Sign out' }));
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(confirm.getByText('Sign out of design-files?')).toBeVisible();
    await pause(2500);
    await click(page, confirm.getByRole('button', { name: 'Cancel' }));
    await expect(confirm).toBeHidden();
  });
  await narrate('outro-1', async () => {
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })");
  });

  await finish();
});
