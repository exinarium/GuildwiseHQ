import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, request, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { BASE_URL } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/governance.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Governance video: approving from a notification (the confirm page a notification button opens), What it may do and
 * the approval gates, the audit export and removing a member with the offboarding checklist.
 * The notification link is made the way the server makes it for a push (a signed, single-use token row): the recording
 * browser has no push service, so the page the button would open is opened directly.
 * Output: media/videos/governance.{webm,mp4,vtt,json}
 *   e2e/video/record.sh governance
 */
const SLUG = 'governance';
const PASSWORD = 'demo-password-12345';

test.afterAll(async () => {
  await pool.end();
});

async function inviteAndJoin(api: APIRequestContext, email: string, name: string) {
  await deleteMailFor(email);
  const r = await api.post('/api/org/invitations', { data: { email, role: 'member', projectIds: [] } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const mail = await waitForMail(email, 30_000);
  const token = new RegExp(`${BASE_URL.replace(/[.:/]/g, '\\$&')}/invite/([A-Za-z0-9_-]+)`).exec(
    mail.text,
  )?.[1];
  expect(token, mail.text).toBeTruthy();
  const anon = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const accept = await anon.post(`/api/invitations/${token}/accept`, {
    data: { displayName: name, password: PASSWORD },
  });
  expect(accept.ok(), await accept.text()).toBeTruthy();
  await anon.dispose();
}

/** A desk-action link for `userId`, signed like the server's (key: AOM_SECRET_KEY, else the one kept in server_secrets). */
async function notificationLink(
  orgId: string,
  userId: string,
  deskItemId: string,
  action: string,
): Promise<string> {
  let key: Buffer;
  if (process.env.AOM_SECRET_KEY) key = createHash('sha256').update(process.env.AOM_SECRET_KEY).digest();
  else {
    await q(
      `INSERT INTO server_secrets (name, value) VALUES ('totp_key', $1) ON CONFLICT (name) DO NOTHING`,
      [randomBytes(32).toString('base64url')],
    );
    const [row] = await q<{ value: string }>(`SELECT value FROM server_secrets WHERE name='totp_key'`);
    key = Buffer.from((row as { value: string }).value, 'base64url');
  }
  const id = randomUUID();
  // the server's clock (the stack has a test clock), not the database's
  const clock = (await (
    await fetch(`${BASE_URL}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ advanceMs: 0 }),
    })
  ).json()) as { now: string };
  const now = new Date(clock.now);
  await q(
    `INSERT INTO desk_action_tokens (id, org_id, user_id, desk_item_id, action, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, orgId, userId, deskItemId, action, now, new Date(now.getTime() + 2 * 3_600_000)],
  );
  const sig = createHmac('sha256', key).update(`desk-action:${id}`).digest('base64url');
  return `/m/desk/${encodeURIComponent(`${id}.${sig}`)}`;
}

test('record the governance video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Governance: approvals, grants, audit and offboarding',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const api = await demoApi();
  const me = (await (await api.get('/api/auth/me')).json()) as {
    user: { id: string };
    activeOrg: { id: string };
  };
  const ws = await pairWorkstation(api, "Alex's laptop", undefined, { AOM_MOCK_STEP_MS: '300' });
  const agents = (await (await api.get('/api/agents')).json()).agents as Array<{
    id: string;
    isDevops?: boolean;
  }>;
  const devops = agents.find((a) => a.isDevops);
  if (devops) await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } });
  const { projectId, repoId } = await createProject(api, 'SHOP', 'Web shop');
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
  await inviteAndJoin(api, 'jamie.lee@demo.local', 'Jamie Lee');
  // a builder that needs a tool installed: the DevOps engineer asks the Owner for approval
  const card = await api.post('/api/cards', {
    data: {
      projectId,
      title: 'Zoom on product photos',
      cardType: 'feature',
      repoId,
      completionAction: 'merge',
      docsNeeded: false,
      fields: {
        context: 'Shoppers want to see details of a product.',
        requirements: 'Let shoppers zoom into product photos.',
        acceptanceCriteria: ['A click on a photo opens a zoomable view'],
        affectedAreas: 'src/',
        constraints: 'Keep the public API unchanged.',
        testPlan: 'Open a product page and zoom in.',
        mockUsage: { inputTokens: 300_000, outputTokens: 20_000 },
        mock: { build: ['devops_install', 'ok'] },
      },
      specify: true,
    },
  });
  expect(card.status(), await card.text()).toBe(201);
  const approval = await waitFor(
    'the DevOps approval on the desk',
    () => q<{ id: string }>(`SELECT id FROM desk_items WHERE subkind='devops' AND status='open'`),
    (r) => r.length > 0,
    240_000,
  ).then((r) => r[0] as { id: string });
  await q(`UPDATE desk_items SET body=$2 WHERE id=$1`, [
    approval.id,
    'Installing the image tools the zoom feature needs is outside the access you granted the DevOps engineer.',
  ]);
  const link = await notificationLink(me.activeOrg.id, me.user.id, approval.id, 'approve');
  const max = (await q<{ id: string }>(`SELECT id FROM agents WHERE name='Max'`))[0] as { id: string };

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const nav = (id: string) => page.getByTestId(id);

  await page.goto('/desk');
  await expect(page.getByTestId('desk-list')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await page
      .getByTestId(`desk-item-${approval.id}`)
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(3500);
  });
  await narrate('c1-b', async () => {
    await page.goto(link);
    await expect(page.getByTestId('desk-action-confirm')).toBeVisible();
    await pause(3500);
  });
  await narrate('c1-c', async () => {
    await click(page, page.getByTestId('desk-action-confirm').getByRole('button', { name: 'Approve' }));
    await expect(page.getByText(/done\. It is on the record/)).toBeVisible({ timeout: 30_000 });
    await pause(2500);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await page.goto('/agents');
    await expect(page.getByRole('button', { name: 'What Max may do' })).toBeVisible();
    await click(page, page.getByRole('button', { name: 'What Max may do' }));
    await expect(page.getByTestId('may-do')).toBeVisible({ timeout: 30_000 });
    await pause(3000);
  });
  await narrate('c2-b', async () => {
    const dlg = page.getByRole('dialog');
    await dlg.getByText('May delegate to').scrollIntoViewIfNeeded();
    await pause(2500);
    await dlg.getByText('Spend and budget').scrollIntoViewIfNeeded();
    await pause(2500);
  });
  await narrate('c2-c', async () => {
    const gate = page.getByTestId('gate-merge_push');
    await gate.scrollIntoViewIfNeeded();
    await pause(1500);
    await click(page, gate.getByRole('checkbox'));
    await expect(gate.getByRole('checkbox')).toBeChecked({ timeout: 15_000 });
    await pause(2500);
  });

  await chapter(3);
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  await narrate('c3-a', async () => {
    await page.keyboard.press('Escape');
    await click(page, nav('nav-organization'));
    await click(page, tab('Audit log'));
    await expect(page.getByTestId('audit-export')).toBeVisible();
    await pause(2500);
    await page.getByTestId('audit-export').getByLabel('Format').selectOption('csv');
    await pause(1000);
    await click(page, page.getByTestId('audit-export').getByRole('button', { name: 'Download' }));
    await expect(page.getByText(/Exported /)).toBeVisible({ timeout: 30_000 });
  });
  await narrate('c3-b', async () => {
    await pause(3000);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(page, tab('Members'));
    const row = page.getByTestId('members').getByRole('listitem').filter({ hasText: 'Jamie Lee' });
    await expect(row).toBeVisible();
    await click(page, row.getByRole('button', { name: /more|actions|menu/i }).first());
    await click(page, page.getByRole('menuitem', { name: 'Remove from organization' }));
    await expect(page.getByTestId('removal-offboarding')).toBeVisible({ timeout: 30_000 });
    await pause(3500);
  });
  await narrate('c4-b', async () => {
    await click(
      page,
      page
        .getByRole('alertdialog')
        .or(page.getByRole('dialog'))
        .getByRole('button', { name: 'Remove from organization' })
        .last(),
    );
    await expect(page.getByTestId('offboarding-report')).toBeVisible({ timeout: 60_000 });
    await pause(4000);
  });
  await narrate('outro-1', async () => {
    await click(page, page.getByRole('dialog').getByRole('button', { name: 'Done' }));
    await pause(500);
  });

  void max;
  await finish();
});
