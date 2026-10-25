import { type APIRequestContext, expect, request, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { pool } from '../support/db.ts';
import { BASE_URL } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/organization.ts';
import { createProject, demoApi } from './seed.ts';

/**
 * The Organization video (sidebar section 22): General and your role, Members (roles, Invite member, Send invitation),
 * Invitations (Resend, Revoke), Guests, E-mail inbox, Project links and Plan & limits.
 * Output: media/videos/organization.{webm,mp4,vtt,json}
 *   e2e/video/record.sh organization
 */
const SLUG = 'organization';
const PASSWORD = 'demo-password-12345';

test.afterAll(async () => {
  await pool.end();
});

/** Invites `email` to Acme and accepts it through the link in the mail (only this stack's link is taken). */
async function inviteAndJoin(api: APIRequestContext, email: string, name: string, role: 'member' | 'admin') {
  await deleteMailFor(email);
  const r = await api.post('/api/org/invitations', { data: { email, role, projectIds: [] } });
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

test('record the organization video', async ({ browser }) => {
  // ---- seed (demo data only): Acme and its Owner Alex Morgan exist already -----------------------------------------
  const api = await demoApi();
  const { projectId: shop } = await createProject(api, 'SHOP', 'Web shop', { repo: false });
  await createProject(api, 'BLOG', 'Company blog', { repo: false });
  await inviteAndJoin(api, 'jamie.lee@demo.local', 'Jamie Lee', 'member');
  await inviteAndJoin(api, 'priya.shah@demo.local', 'Priya Shah', 'admin');
  const pending = await api.post('/api/org/invitations', {
    data: { email: 'guest@demo.local', role: 'member', projectIds: [] },
  });
  expect(pending.ok(), await pending.text()).toBeTruthy();
  // a guest: the Owner of another organization who works on the web shop
  const sam = { email: 'sam.rivera@demo.local', name: 'Sam Rivera', password: PASSWORD };
  await inviteAndAccept(api, sam);
  const share = await api.post(`/api/projects/${shop}/members`, { data: { email: sam.email } });
  expect(share.ok(), await share.text()).toBeTruthy();
  const samApi = await apiAs(sam.email, sam.password);
  const joined = await samApi.post(`/api/projects/${shop}/members/accept`);
  expect(joined.ok(), await joined.text()).toBeTruthy();
  await samApi.dispose();
  // a link between projects: the web shop depends on an outside payment provider
  const link = await api.post('/api/org-graph/links', {
    data: { from: { projectId: shop }, to: { name: 'Payment provider' }, kind: 'depends_on' },
  });
  expect(link.ok(), await link.text()).toBeTruthy();

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Your organization',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });

  await page.goto('/desk');
  await expect(page.getByTestId('nav-organization')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-organization'));
    await expect(page.getByText('Acme · you are the Owner')).toBeVisible();
    await pause(1500);
    await page.getByText('Your role').hover();
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, tab('Members'));
    await expect(page.getByTestId('members').getByRole('listitem')).toHaveCount(3);
    await pause(1500);
    await page.getByLabel('Role of Jamie Lee').hover();
    await pause(1200);
  });
  const dialog = page.getByRole('dialog', { name: 'Invite a member' });
  await narrate('c2-b', async () => {
    await click(page, page.getByTestId('invite-member'));
    await expect(dialog).toBeVisible();
    await type(page, dialog.getByLabel('Email'), 'chris.taylor@demo.local', 150);
    await click(page, dialog.getByText('Web shop'), 300);
    await click(page, dialog.getByRole('button', { name: 'Send invitation' }));
    await expect(dialog).toHaveCount(0);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, tab('Invitations'));
    await expect(page.getByTestId('invitations')).toContainText('chris.taylor@demo.local');
    await pause(800);
    await click(page, page.getByRole('button', { name: 'Resend invitation to guest@demo.local' }));
    await pause(600);
    await click(page, page.getByRole('button', { name: 'Revoke invitation to chris.taylor@demo.local' }));
    await click(page, page.getByRole('button', { name: 'Revoke invitation', exact: true }));
    await expect(page.getByText('Invitation revoked')).toBeVisible();
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(page, tab('Guests'));
    await expect(page.getByTestId('guests')).toContainText('Sam Rivera');
    await pause(800);
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    await click(page, tab('E-mail inbox'));
    await expect(page.getByTestId('mail-inbox-tab')).toBeVisible();
    await pause(800);
  });
  await narrate('c5-b', async () => {
    await click(page, tab('Project links'));
    await expect(page.getByTestId('org-links')).toContainText('Payment provider');
    await pause(800);
  });

  await chapter(6);
  await narrate('c6-a', async () => {
    await click(page, tab('Plan & limits'));
    await expect(page.getByTestId('plan-summary')).toBeVisible();
    await pause(2000);
  });
  await narrate('outro-1', async () => {
    await click(page, tab('General'));
  });

  await finish();
});
