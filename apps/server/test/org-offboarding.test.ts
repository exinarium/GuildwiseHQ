import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDueOffboardingPurges } from '../src/governance/offboarding.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok, pairWorkstation } from './helpers/world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

interface Person {
  id: string;
  email: string;
  cookie: string;
  workstationId: string;
}
/** Acme: an Owner, an Admin and a Member who has a workstation, a phone, a private chat, a session and packs. */
async function acme(opts: { memberHasOtherOrg: boolean } = { memberHasOtherOrg: true }) {
  const mk = async (label: string): Promise<Person> => {
    const s = await t.userSession(uniqueEmail(label));
    const ws = await pairWorkstation(t, s, `${label}-box`);
    return { ...s, workstationId: ws.workstationId };
  };
  const owner = await mk('owner');
  const admin = await mk('admin');
  const member = await mk('member');
  const org = await t.createOrg(owner.id, 'Acme');
  await t.addOrgMember(org, admin.id, 'admin');
  await t.addOrgMember(org, member.id, 'member');
  // the member's own personal organization: gone when this should be their only one
  if (!opts.memberHasOtherOrg)
    await q(`UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$1`, [member.id]);
  const as = (who: Person, method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });

  // things the offboarding must find
  await q(
    `INSERT INTO org_providers (org_id, provider, configured, set_by, set_at) VALUES ($1,'anthropic',true,$2,now())`,
    [org, member.id],
  );
  await q(
    `INSERT INTO org_provider_key_shares (org_id, provider, workstation_id, key_id, status, via, shared_by)
     VALUES ($1,'anthropic',$2,'k1','stored','browser',$3)`,
    [org, member.workstationId, member.id],
  );
  const orgPack = randomUUID();
  await q(
    `INSERT INTO packs (id, org_id, name, url, ref, added_by, added_at, workstation_ids, visibility, source)
     VALUES ($1,$2,'shared-pack','https://example.test/p.git','main',$3,now(),$4,'org','git')`,
    [orgPack, org, owner.id, [owner.workstationId, member.workstationId]],
  );
  await q(
    `INSERT INTO pack_credential_shares (pack_id, workstation_id, key_id, status, updated_at) VALUES ($1,$2,'k','stored',now())`,
    [orgPack, member.workstationId],
  );
  const ownedPack = randomUUID();
  await q(
    `INSERT INTO packs (id, org_id, name, url, ref, added_by, added_at, workstation_ids, visibility, source, owner_user_id)
     VALUES ($1,$2,'authored-by-member','authored:x','main',$3,now(),'{}','org','git',$3)`,
    [ownedPack, org, member.id],
  );
  const privPack = randomUUID();
  await q(
    `INSERT INTO packs (id, org_id, name, url, ref, added_by, added_at, workstation_ids, visibility, source, owner_user_id)
     VALUES ($1,$2,'mine-private','authored:y','main',$3,now(),$4,'private','git',$3)`,
    [privPack, org, member.id, [member.workstationId]],
  );
  await q(
    `INSERT INTO pack_credential_shares (pack_id, workstation_id, key_id, status, updated_at) VALUES ($1,$2,'k','stored',now())`,
    [privPack, member.workstationId],
  );
  const chat = randomUUID();
  await q(
    `INSERT INTO threads (id, org_id, kind, title, created_by, created_at) VALUES ($1,$2,'chat','private chat',$3,now())`,
    [chat, org, member.id],
  );
  const session = randomUUID();
  await q(
    `INSERT INTO threads (id, org_id, kind, title, created_by, created_at) VALUES ($1,$2,'discovery','a session',$3,now())`,
    [session, org, member.id],
  );
  await q(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at) VALUES ($1,$2,$3,'p','a','Phone',now())`,
    [randomUUID(), member.id, `https://push.example.test/${randomUUID()}`],
  );
  await q(
    `INSERT INTO pairing_codes (user_id, code_hash, expires_at, created_at) VALUES ($1,$2,now()+interval '5 min',now())`,
    [member.id, randomUUID()],
  );
  const item = randomUUID();
  await q(
    `INSERT INTO desk_action_tokens (id, org_id, user_id, desk_item_id, action, created_at, expires_at) VALUES ($1,$2,$3,$4,'approve',now(),now()+interval '10 min')`,
    [randomUUID(), org, member.id, item],
  );
  return { owner, admin, member, org, as, orgPack, ownedPack, privPack, chat, session };
}

const sessions = async (userId: string) =>
  Number((await q('SELECT count(*) AS n FROM auth_sessions WHERE user_id=$1', [userId]))[0]?.n);
const step = (report: any, key: string) => report.steps.find((s: any) => s.key === key);

describe('offboarding a removed member', () => {
  it('previews the checklist before anything happens', async () => {
    const { admin, member, as } = await acme();
    const p = await ok<any>(as(admin, 'GET', `/api/org/members/${member.id}/removal-preview`));
    expect(p.privatePurgeDays).toBe(30);
    expect(p.offboarding.map((s: any) => s.key)).toEqual(
      expect.arrayContaining([
        'sessions',
        'tokens',
        'workstations',
        'pack_credentials',
        'org_key_shares',
        'private_items',
      ]),
    );
    expect(p.offboarding.find((s: any) => s.key === 'private_items')).toMatchObject({
      count: 2,
      status: 'flagged',
    });
  });

  it('removes what the person held in this organization and keeps what belongs to their other organization', async () => {
    const { owner, admin, member, org, as, orgPack, ownedPack, privPack, chat, session } = await acme();
    const r = await ok<any>(as(admin, 'DELETE', `/api/org/members/${member.id}`));
    const rep = r.offboarding;
    expect(rep).toMatchObject({ orgId: org, userId: member.id, transferredTo: owner.id });
    expect(rep.privatePurgeAfter).toBeTruthy();

    // the member is still a member of their own organization: workstation, sessions and phone stay
    expect(step(rep, 'workstations').status).toBe('kept');
    expect((await q('SELECT status FROM workstations WHERE id=$1', [member.workstationId]))[0]?.status).toBe(
      'active',
    );
    expect(step(rep, 'sessions').status).toBe('kept');
    expect(await sessions(member.id)).toBeGreaterThan(0);
    expect(step(rep, 'push_devices').status).toBe('kept');

    // notification links of this organization are revoked
    expect(
      (await q('SELECT 1 FROM desk_action_tokens WHERE user_id=$1 AND org_id=$2', [member.id, org])).length,
    ).toBe(0);
    expect(step(rep, 'tokens').count).toBe(1);

    // the organization key copy is cleared on their workstation and a clear command is queued
    expect(
      (
        await q('SELECT 1 FROM org_provider_key_shares WHERE org_id=$1 AND workstation_id=$2', [
          org,
          member.workstationId,
        ])
      ).length,
    ).toBe(0);
    const cmd = await q(
      `SELECT type, payload FROM runner_commands WHERE workstation_id=$1 AND type='provider.key.clear'`,
      [member.workstationId],
    );
    expect(cmd.length).toBe(1);
    expect(cmd[0]?.payload).toMatchObject({ provider: 'anthropic', source: 'org', orgId: org });
    expect(rep.notes.join(' ')).toContain('Rotate it');

    // the organization pack is taken off their workstation, its credential copy is deleted
    const holders = (await q('SELECT workstation_ids FROM packs WHERE id=$1', [orgPack]))[0]
      ?.workstation_ids as string[];
    expect(holders).toEqual([owner.workstationId]);
    expect((await q('SELECT 1 FROM pack_credential_shares WHERE pack_id=$1', [orgPack])).length).toBe(0);
    expect(step(rep, 'pack_assignments').count).toBe(1);
    // their private pack credential goes now
    expect((await q('SELECT 1 FROM pack_credential_shares WHERE pack_id=$1', [privPack])).length).toBe(0);
    expect(step(rep, 'pack_credentials').count).toBe(1);

    // organization-visible things move to the Owner, not to the Admin who removed them
    expect((await q('SELECT created_by FROM threads WHERE id=$1', [session]))[0]?.created_by).toBe(owner.id);
    expect((await q('SELECT owner_user_id FROM packs WHERE id=$1', [ownedPack]))[0]?.owner_user_id).toBe(
      owner.id,
    );
    // private things are flagged for deletion after the grace period, not deleted now
    const purge = (
      await q('SELECT * FROM offboarding_purges WHERE org_id=$1 AND user_id=$2', [org, member.id])
    )[0];
    expect(purge).toMatchObject({ status: 'pending', chat_ids: [chat], pack_ids: [privPack] });
    expect((await q('SELECT deleted_at FROM threads WHERE id=$1', [chat]))[0]?.deleted_at).toBeNull();
    const days = (new Date(purge?.purge_after).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    // the audit record
    const ev = await q(`SELECT payload, actor_id FROM events WHERE type='MemberOffboarded' AND org_id=$1`, [
      org,
    ]);
    expect(ev.length).toBe(1);
    expect(ev[0]?.actor_id).toBe(admin.id);
    expect(JSON.stringify(ev[0]?.payload)).not.toContain('ciphertext');
    expect(
      (await q(`SELECT 1 FROM events WHERE type='OwnedItemsTransferred' AND org_id=$1`, [org])).length,
    ).toBe(1);
  });

  it('signs the person out and unlinks their workstations when this was their last organization', async () => {
    const { admin, member, as, org } = await acme({ memberHasOtherOrg: false });
    expect(await sessions(member.id)).toBeGreaterThan(0);
    const rep = (await ok<any>(as(admin, 'DELETE', `/api/org/members/${member.id}`))).offboarding;
    expect(step(rep, 'sessions')).toMatchObject({ status: 'done' });
    expect(await sessions(member.id)).toBe(0);
    expect(step(rep, 'workstations').status).toBe('done');
    expect((await q('SELECT status FROM workstations WHERE id=$1', [member.workstationId]))[0]?.status).toBe(
      'unlinked',
    );
    expect(
      (await q('SELECT 1 FROM pairing_codes WHERE user_id=$1 AND used_at IS NULL', [member.id])).length,
    ).toBe(0);
    expect((await q('SELECT 1 FROM push_subscriptions WHERE user_id=$1', [member.id])).length).toBe(0);
    expect(org).toBeTruthy();
  });

  it('counts a guest membership on another organization’s project as another organization', async () => {
    const { admin, member, as } = await acme({ memberHasOtherOrg: false });
    const other = await t.userSession(uniqueEmail('host'));
    const proj = await ok<any>(
      t.req('POST', '/api/projects', { cookie: other.cookie, body: { key: 'HOST', name: 'Host' } }),
      201,
    );
    await ok(
      t.req('POST', `/api/projects/${proj.project.id}/members`, {
        cookie: other.cookie,
        body: { email: member.email },
      }),
      201,
    );
    await ok(t.req('POST', `/api/projects/${proj.project.id}/members/accept`, { cookie: member.cookie }));
    const preview = await ok<any>(as(admin, 'GET', `/api/org/members/${member.id}/removal-preview`));
    expect(preview.offboarding.find((x: any) => x.key === 'sessions').status).toBe('kept');
    const rep = (await ok<any>(as(admin, 'DELETE', `/api/org/members/${member.id}`))).offboarding;
    expect(step(rep, 'sessions').status).toBe('kept');
    expect(step(rep, 'workstations').status).toBe('kept');
    expect(await sessions(member.id)).toBeGreaterThan(0);
    expect((await q('SELECT status FROM workstations WHERE id=$1', [member.workstationId]))[0]?.status).toBe(
      'active',
    );
    expect(rep.notes.join(' ')).toContain('guest');
  });

  it('closes the browser connections of a person who was signed out', async () => {
    const { admin, member, as } = await acme({ memberHasOtherOrg: false });
    const closed: string[] = [];
    const browser = t.app.ctx.services.browser;
    const orig = browser.closeUser.bind(browser);
    browser.closeUser = (id: string) => {
      closed.push(id);
      orig(id);
    };
    try {
      await ok(as(admin, 'DELETE', `/api/org/members/${member.id}`));
    } finally {
      browser.closeUser = orig;
    }
    expect(closed).toContain(member.id);
  });

  it('raises the key generation and asks the Owner to rotate when a stored key copy is stranded on an unlinked workstation', async () => {
    const { admin, member, as, org } = await acme({ memberHasOtherOrg: false });
    const before = (await q(`SELECT key_generation FROM org_providers WHERE org_id=$1`, [org]))[0]
      ?.key_generation;
    const rep = (await ok<any>(as(admin, 'DELETE', `/api/org/members/${member.id}`))).offboarding;
    const after = (await q(`SELECT key_generation FROM org_providers WHERE org_id=$1`, [org]))[0]
      ?.key_generation;
    expect(Number(after)).toBe(Number(before ?? 0) + 1);
    expect(
      (
        await q(`SELECT 1 FROM desk_items WHERE org_id=$1 AND subkind='org_key_rotate' AND status='open'`, [
          org,
        ])
      ).length,
    ).toBe(1);
    expect(rep.notes.join(' ')).toContain('generation');
  });

  it('leaving moves their items to the Owner, not to themselves', async () => {
    const { owner, member, as, session } = await acme();
    await ok(as(member, 'DELETE', '/api/org/members/me'));
    expect((await q('SELECT created_by FROM threads WHERE id=$1', [session]))[0]?.created_by).toBe(owner.id);
  });

  it('deletes the private items after the grace period, and not if the person came back', async () => {
    const a = await acme();
    await ok(a.as(a.admin, 'DELETE', `/api/org/members/${a.member.id}`));
    const ctx = t.app.ctx;
    expect(await runDueOffboardingPurges(ctx)).toBe(0);
    t.clock.advance(31 * 86_400_000);
    try {
      expect(await runDueOffboardingPurges(ctx)).toBeGreaterThanOrEqual(1);
      expect((await q('SELECT deleted_at FROM threads WHERE id=$1', [a.chat]))[0]?.deleted_at).not.toBeNull();
      expect(
        (await q('SELECT removed_at FROM packs WHERE id=$1', [a.privPack]))[0]?.removed_at,
      ).not.toBeNull();
      expect(
        (
          await q('SELECT status FROM offboarding_purges WHERE org_id=$1 AND user_id=$2', [
            a.org,
            a.member.id,
          ])
        )[0]?.status,
      ).toBe('done');
      expect(
        (await q(`SELECT 1 FROM events WHERE type='OffboardingPurgeRan' AND org_id=$1`, [a.org])).length,
      ).toBe(1);
      // the organization's shared things are untouched
      expect((await q('SELECT removed_at FROM packs WHERE id=$1', [a.orgPack]))[0]?.removed_at).toBeNull();

      const b = await acme();
      await ok(b.as(b.admin, 'DELETE', `/api/org/members/${b.member.id}`));
      await t.addOrgMember(b.org, b.member.id, 'member');
      t.clock.advance(31 * 86_400_000);
      await runDueOffboardingPurges(ctx);
      expect((await q('SELECT deleted_at FROM threads WHERE id=$1', [b.chat]))[0]?.deleted_at).toBeNull();
      expect(
        (
          await q('SELECT status FROM offboarding_purges WHERE org_id=$1 AND user_id=$2', [
            b.org,
            b.member.id,
          ])
        )[0]?.status,
      ).toBe('cancelled');
    } finally {
      t.clock.setOffset(0);
    }
  });

  it('a removal of an Admin or the Owner is still refused (nothing is offboarded)', async () => {
    const { owner, admin, member, as, org } = await acme();
    expect((await as(admin, 'DELETE', `/api/org/members/${owner.id}`)).status).toBe(409);
    expect((await as(member, 'DELETE', `/api/org/members/${admin.id}`)).status).toBe(403);
    expect((await q(`SELECT 1 FROM events WHERE type='MemberOffboarded' AND org_id=$1`, [org])).length).toBe(
      0,
    );
  });
});
