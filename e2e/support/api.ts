import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, request } from '@playwright/test';
import { BASE_URL, DATABASE_URL, E2E_DIR, ROOT, SMTP_URL } from './env.ts';

export const storagePath = (who: string) => `${E2E_DIR}/${who}.storage.json`;

/** A logged-in API client (cookie session) for `email`. */
export async function apiAs(email: string, password: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const res = await ctx.post('/api/auth/login', { data: { email, password } });
  expect(res.ok(), `login ${email}: ${await res.text()}`).toBeTruthy();
  return ctx;
}

/**
 * Creates `user` as the Owner of an organization of their own (the server's `admin:create` command), the way an
 * account started from a new-organization invitation ends up. The specs that need two independent people (an owner and
 * a guest, or a second tenant) use this; the org-members and platform specs cover the invitation flows themselves.
 */
export async function inviteAndAccept(
  _admin: APIRequestContext,
  user: { email: string; name: string; password: string },
): Promise<void> {
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@aom/server',
      'admin:create',
      '--email',
      user.email,
      '--name',
      user.name,
      '--password',
      user.password,
      '--org',
      `${user.name}'s organization`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL, AOM_PUBLIC_ORIGIN: BASE_URL, AOM_SMTP_URL: SMTP_URL },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
}
