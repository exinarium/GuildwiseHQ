import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { twoFactorRecoveryTick } from '../src/commands/two-factor-recovery.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo, waitForMessages } from './helpers/mailpit.ts';
import { singleOrgUser } from './helpers/single-org.ts';

/**
 * Release-readiness O2: an Owner's two-factor reset of a member takes effect 24 hours later. When it fires, the scheduler
 * re-checks the rule of the immediate path (R6): the requester is still the Owner, the person is still an active member
 * and has no access in another organization. Otherwise the reset is cancelled, two-factor login stays on, and both the
 * member and the Owner who asked are mailed.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const DAY = 24 * 3600_000 + 1000;

async function scheduled() {
  const owner = await t.userSession(uniqueEmail('o2-owner'));
  const member = await singleOrgUser(t, uniqueEmail('o2-member'));
  const org = await t.createOrg(owner.id, 'Acme O2');
  await t.addOrgMember(org, member.id, 'member');
  await t.enableTwoFactor(member.id);
  const r = await t.req('POST', `/api/org/members/${member.id}/reset-two-factor`, {
    cookie: owner.cookie,
    headers: { 'x-aom-org': org },
  });
  expect(r.status).toBe(200);
  await waitForMessages(member.email, 1); // "will be reset in 24 hours"
  return { owner, member, org };
}

async function tickAfterWait(): Promise<string[]> {
  t.clock.advance(DAY);
  try {
    return await twoFactorRecoveryTick(t.app.ctx);
  } finally {
    t.clock.advance(-DAY);
  }
}

const twoFactorOn = async (userId: string) =>
  (await q('SELECT two_factor_enabled FROM users WHERE id=$1', [userId]))[0]!.two_factor_enabled as boolean;
const recovery = async (userId: string) =>
  (
    await q('SELECT * FROM two_factor_recoveries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [userId])
  )[0]!;
const subjects = async (email: string) => (await messagesTo(email)).map((m) => m.Subject);

describe('O2: a scheduled Owner reset re-checks the rule when it fires', () => {
  it('stores the organization and the Owner who asked', async () => {
    const { owner, member, org } = await scheduled();
    expect(await recovery(member.id)).toMatchObject({ org_id: org, requested_by: owner.id });
  });

  it('control: nothing changed in the 24 hours, the reset happens', async () => {
    const { member } = await scheduled();
    expect(await tickAfterWait()).toContain(member.id);
    expect(await twoFactorOn(member.id)).toBe(false);
  });

  it('the member gained access to another organization: cancelled, 2FA stays, both are mailed', async () => {
    const { owner, member } = await scheduled();
    const other = await t.userSession(uniqueEmail('o2-other'));
    const orgB = await t.createOrg(other.id, 'Other O2');
    await t.addOrgMember(orgB, member.id, 'member');

    expect(await tickAfterWait()).not.toContain(member.id);
    expect(await twoFactorOn(member.id)).toBe(true);
    const row = await recovery(member.id);
    expect(row.cancelled_at).not.toBeNull();
    expect(row.done_at).toBeNull();
    await waitForMessages(member.email, 2);
    expect(await subjects(member.email)).toContain('Your two-factor login stays on');
    await waitForMessages(owner.email, 1);
    expect(await subjects(owner.email)).toContain('A two-factor reset was not done');
    // the member's sessions survive
    expect((await t.req('GET', '/api/auth/me', { cookie: member.cookie })).status).toBe(200);
  });

  it('project access in another organization counts too', async () => {
    const { member } = await scheduled();
    const other = await t.userSession(uniqueEmail('o2-proj'));
    const orgB = await t.createOrg(other.id, 'Other O2 project');
    const p = await t.req('POST', '/api/projects', {
      cookie: other.cookie,
      headers: { 'x-aom-org': orgB },
      body: { key: 'OTP', name: 'Other project' },
    });
    expect(p.status).toBe(201);
    // shared with the member, who accepts: active project access in another organization
    const share = await t.req('POST', `/api/projects/${p.body.project.id}/members`, {
      cookie: other.cookie,
      headers: { 'x-aom-org': orgB },
      body: { email: member.email },
    });
    expect(share.status).toBe(201);
    const acc = await t.req('POST', `/api/projects/${p.body.project.id}/members/accept`, {
      cookie: member.cookie,
    });
    expect(acc.status).toBe(200);
    expect(await tickAfterWait()).not.toContain(member.id);
    expect(await twoFactorOn(member.id)).toBe(true);
  });

  it('the Owner changed: cancelled, and the Owner who asked is told it was not done', async () => {
    const { owner, member, org } = await scheduled();
    const next = await t.userSession(uniqueEmail('o2-next'));
    await t.addOrgMember(org, next.id, 'admin');
    await q('UPDATE organizations SET owner_user_id=$2 WHERE id=$1', [org, next.id]);

    expect(await tickAfterWait()).not.toContain(member.id);
    expect(await twoFactorOn(member.id)).toBe(true);
    expect((await recovery(member.id)).cancelled_at).not.toBeNull();
    await waitForMessages(owner.email, 1);
    expect(await subjects(owner.email)).toContain('A two-factor reset was not done');
  });

  it('the member left the organization: cancelled', async () => {
    const { member, org } = await scheduled();
    await q(`UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2`, [org, member.id]);
    expect(await tickAfterWait()).not.toContain(member.id);
    expect(await twoFactorOn(member.id)).toBe(true);
    expect((await recovery(member.id)).cancelled_at).not.toBeNull();
  });

  it('two-factor login already off: done silently, no mail to either', async () => {
    const { owner, member } = await scheduled();
    await q('UPDATE users SET two_factor_enabled=false WHERE id=$1', [member.id]);
    const before = (await messagesTo(member.email)).length;
    expect(await tickAfterWait()).not.toContain(member.id);
    expect((await recovery(member.id)).done_at).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(await messagesTo(member.email)).toHaveLength(before);
    expect(await messagesTo(owner.email)).toHaveLength(0);
  });

  it('migration 3024 cancels open Owner resets from before it (no organization to re-check)', async () => {
    const member = await singleOrgUser(t, uniqueEmail('o2-legacy'));
    const own = await singleOrgUser(t, uniqueEmail('o2-own'));
    const at = new Date('2026-11-20T10:00:00Z');
    const later = new Date('2026-11-20T10:05:00Z');
    const legacy = randomUUID();
    const userStarted = randomUUID();
    await q(
      `INSERT INTO two_factor_recoveries (id, user_id, token_hash, created_at, confirmed_at, effective_at)
       VALUES ($1,$2,$3,$4,$4,$5), ($6,$7,$8,$4,$9,$5)`,
      [legacy, member.id, randomUUID(), at, later, userStarted, own.id, randomUUID(), later],
    );
    const sql = readFileSync(
      join(import.meta.dirname, '../migrations/3024_two_factor_recovery_org.sql'),
      'utf8',
    );
    await q(sql);
    const rows = await q('SELECT id, cancelled_at FROM two_factor_recoveries WHERE id = ANY($1)', [
      [legacy, userStarted],
    ]);
    expect(rows.find((r) => r.id === legacy)!.cancelled_at).not.toBeNull();
    expect(rows.find((r) => r.id === userStarted)!.cancelled_at).toBeNull();
  });
});
