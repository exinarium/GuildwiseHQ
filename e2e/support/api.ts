import { type APIRequestContext, expect, request } from '@playwright/test';
import { BASE_URL, E2E_DIR } from './env.ts';
import { waitForMail } from './mail.ts';

export const storagePath = (who: string) => `${E2E_DIR}/${who}.storage.json`;

/** A logged-in API client (cookie session) for `email`. */
export async function apiAs(email: string, password: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const res = await ctx.post('/api/auth/login', { data: { email, password } });
  expect(res.ok(), `login ${email}: ${await res.text()}`).toBeTruthy();
  return ctx;
}

/** Admin invites `email`, the invitation link is read from Mailpit and accepted over the API. */
export async function inviteAndAccept(
  admin: APIRequestContext,
  user: { email: string; name: string; password: string },
): Promise<void> {
  const inv = await admin.post('/api/admin/invitations', { data: { email: user.email, role: 'member' } });
  expect(inv.ok(), await inv.text()).toBeTruthy();
  const mail = await waitForMail(user.email);
  const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  expect(token).toBeTruthy();
  const anon = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const acc = await anon.post(`/api/invitations/${token}/accept`, {
    data: { displayName: user.name, password: user.password },
  });
  expect(acc.ok(), await acc.text()).toBeTruthy();
  await anon.dispose();
}
