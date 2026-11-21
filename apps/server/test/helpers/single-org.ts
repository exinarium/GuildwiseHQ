import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { hashPassword } from '../../src/auth/password.ts';
import { PASSWORD, type TestApp } from './app.ts';

let cachedHash: Promise<string> | undefined;

/**
 * A user with no organization of their own, signed in: the shape of someone who created their account by accepting an
 * organization-member invitation (`UserRegistered`, no `OrganizationCreated`). `createUser` instead gives every user a
 * personal organization, which counts as access elsewhere for the member resets (R6).
 */
export async function singleOrgUser(
  t: TestApp,
  email: string,
): Promise<{ id: string; email: string; cookie: string }> {
  const userId = randomUUID();
  cachedHash ??= hashPassword(PASSWORD);
  await t.app.ctx.store.append([
    {
      streamId: streamId.user(userId),
      event: {
        type: 'UserRegistered',
        payload: {
          userId,
          email,
          displayName: email.split('@')[0] as string,
          passwordHash: await cachedHash,
        },
      },
      actor: { kind: 'user', id: userId },
      scope: { orgId: null, projectId: null, audience: 'user', userId },
    },
  ]);
  await t.app.ctx.notifier.flush();
  return { id: userId, email, cookie: await t.login(email) };
}
