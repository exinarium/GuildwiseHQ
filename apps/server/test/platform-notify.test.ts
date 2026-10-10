import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditMailTick } from '../src/commands/platform-notify.ts';
import { createTestApp, ORIGIN, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken, messagesTo, messageText, waitForMessages } from './helpers/mailpit.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
const SUPPORT = uniqueEmail('console');
const PW = 'a-long-enough-password';
const settings = (body: unknown) =>
  ok<any>(t.req('PATCH', '/api/platform/settings', { cookie: sa.cookie, body }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const created = (p: Promise<{ status: number; body: any }>) => ok(p, 201);

beforeAll(async () => {
  t = await createTestApp();
  sa = await t.superAdminSession();
  await settings({ supportEmail: SUPPORT });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const signUp = async (orgName: string) => {
  const email = uniqueEmail('signup');
  await created(
    t.req('POST', '/api/platform/invitations', {
      cookie: sa.cookie,
      body: { email, proposedOrgName: orgName },
    }),
  );
  const token = await latestInviteToken(email, ORIGIN);
  await created(
    t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Nia New', password: PW, orgName },
    }),
  );
};

describe('console notifications that are switched off by default', () => {
  it('both switches are off', async () => {
    const s = await ok<any>(t.req('GET', '/api/platform/settings', { cookie: sa.cookie }));
    expect(s).toMatchObject({ notifyNewOrgs: false, notifyAuditEvents: false });
  });

  it('sends nothing about a sign-up or the audit log while off', async () => {
    await signUp('QuietCo');
    await auditMailTick(t.app.ctx);
    await sleep(600);
    expect((await messagesTo(SUPPORT)).filter((m) => /QuietCo|audit/i.test(m.Subject))).toHaveLength(0);
  });

  it('mails once per accepted invitation when new organizations is on', async () => {
    await settings({ notifyNewOrgs: true });
    await signUp('LoudCo');
    const msgs = await waitForMessages(SUPPORT, 1);
    expect(msgs.filter((m) => m.Subject.includes('LoudCo'))).toHaveLength(1);
    expect(msgs.find((m) => m.Subject.includes('LoudCo'))?.Subject).toBe('New organization: LoudCo');
  });

  it('mails each new audit entry exactly once when audit events is on, never the history', async () => {
    await settings({ notifyAuditEvents: true });
    expect(await auditMailTick(t.app.ctx)).toBe(0);
    await signUp('AuditCo');
    const first = await auditMailTick(t.app.ctx);
    expect(first).toBeGreaterThan(0);
    expect(await auditMailTick(t.app.ctx)).toBe(0);
    await sleep(600);
    const audit = (await messagesTo(SUPPORT)).filter((m) => m.Subject.startsWith('Platform audit:'));
    expect(audit.length).toBe(first);
  });
});

describe('who an invitation says it is from', () => {
  it('a super admin invitation always comes from the team', async () => {
    const email = uniqueEmail('teaminv');
    await created(
      t.req('POST', '/api/platform/invitations', {
        cookie: sa.cookie,
        body: { email, proposedOrgName: 'Z' },
      }),
    );
    const [m] = await waitForMessages(email, 1);
    expect(await messageText(m?.ID as string)).toContain('The Guildwise HQ team');
  });

  it('an organization invitation shows the inviter and the organization', async () => {
    const owner = await t.userSession(uniqueEmail('ownerinv'));
    await q('UPDATE users SET display_name=$1 WHERE id=$2', ['Olive Owner', owner.id]);
    const org = await t.createOrg(owner.id, 'Hooli');
    const email = uniqueEmail('memberinv');
    await created(
      t.req('POST', '/api/org/invitations', {
        cookie: owner.cookie,
        headers: { 'x-aom-org': org },
        body: { email, role: 'member' },
      }),
    );
    const [m] = await waitForMessages(email, 1);
    const text = await messageText(m?.ID as string);
    expect(text).toContain('Olive Owner');
    expect(text).toContain('Hooli');
    expect(text).not.toContain('The Guildwise HQ team invited');
  });
});
