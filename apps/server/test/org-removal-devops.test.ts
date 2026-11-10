import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { ok, pairWorkstation, until } from './helpers/world.ts';

/**
 * Removing a member from an organization retires the DevOps engineers of their workstations there with exactly one
 * `AgentRetired` each: on a last-organization removal the offboarding unlink retires them, otherwise the removal does.
 */
const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];
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

const activeDevops = (org: string, ws: string) =>
  q(`SELECT id FROM agents WHERE org_id=$1 AND workstation_id=$2 AND is_devops AND status='active'`, [
    org,
    ws,
  ]);

/** Acme: an Owner, an Admin and a Member with a workstation whose Acme DevOps engineer is hired. */
async function acme(opts: { memberHasOtherOrg: boolean; secondStation?: boolean; withProject?: boolean }) {
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
  if (!opts.memberHasOtherOrg)
    await q(`UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$1`, [member.id]);
  const as = (who: { cookie: string }, method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });

  // the Acme engineer of the member's workstation is hired by the membership hook, after the response
  await until(
    async () => (await activeDevops(org, member.workstationId)).length > 0,
    5000,
    'acme devops hired',
  );
  const stations = [member.workstationId];
  if (opts.secondStation) {
    const second = await pairWorkstation(t, member, 'member-box-2');
    await until(
      async () => (await activeDevops(org, second.workstationId)).length > 0,
      5000,
      'second devops',
    );
    stations.push(second.workstationId);
  }
  let projectId: string | undefined;
  if (opts.withProject) {
    const p = await ok<any>(as(owner, 'POST', '/api/projects', { key: 'RMV', name: 'Removal' }), 201);
    projectId = p.project.id as string;
    await ok(as(owner, 'POST', `/api/projects/${projectId}/members`, { email: member.email }), 201);
  }
  const engineers: string[] = [];
  for (const ws of stations) engineers.push(...(await activeDevops(org, ws)).map((a) => a.id));
  return { owner, admin, member, org, as, stations, engineers, projectId };
}

const retiredEvents = (agentId: string) =>
  q(`SELECT payload FROM events WHERE type='AgentRetired' AND payload->>'agentId'=$1`, [agentId]);
const statusOf = async (agentId: string) =>
  (await q('SELECT status FROM agents WHERE id=$1', [agentId]))[0]?.status as string;
/** AC: after the removal no DevOps engineer of the member is left active in the organization. */
const noActiveDevopsLeft = async (org: string, userId: string) =>
  expect(
    await q(
      `SELECT a.id FROM agents a JOIN workstations w ON w.id = a.workstation_id
        WHERE a.org_id=$1 AND a.is_devops AND a.status='active' AND w.user_id=$2`,
      [org, userId],
    ),
  ).toHaveLength(0);
const expectOneUnpairRetire = async (agentId: string) => {
  const ev = await retiredEvents(agentId);
  expect(ev).toHaveLength(1);
  expect(ev[0].payload.reason).toBe('workstation_unpaired');
  expect(await statusOf(agentId)).toBe('retired');
};

describe('removing a member retires each of their DevOps engineers exactly once', () => {
  it('removeOrgMember from the last organization: one AgentRetired (the unlink one) and the other effects unchanged', async () => {
    const { admin, member, org, as, stations, engineers, projectId } = await acme({
      memberHasOtherOrg: false,
      withProject: true,
    });
    expect(engineers).toHaveLength(1);
    const r = await ok<any>(as(admin, 'DELETE', `/api/org/members/${member.id}`));

    await expectOneUnpairRetire(engineers[0]!);
    await noActiveDevopsLeft(org, member.id);

    // the other effects of the removal are as before
    expect(r.offboarding.steps.find((s: any) => s.key === 'workstations').status).toBe('done');
    expect((await q('SELECT status FROM workstations WHERE id=$1', [stations[0]]))[0]?.status).toBe(
      'unlinked',
    );
    expect(
      (
        await q('SELECT status FROM project_members WHERE project_id=$1 AND user_id=$2', [
          projectId,
          member.id,
        ])
      )[0]?.status,
    ).toBe('removed');
    const wipes = await q(
      `SELECT payload->>'agentId' AS agent FROM runner_commands WHERE workstation_id=$1 AND type='agent.wipe'`,
      [stations[0]],
    );
    expect(wipes.map((w) => w.agent)).toContain(engineers[0]);
    expect(
      await q(
        `SELECT 1 FROM events WHERE type='OrgMemberRemoved' AND payload->>'orgId'=$1 AND payload->>'userId'=$2`,
        [org, member.id],
      ),
    ).toHaveLength(1);
  });

  it('removeOrgMember with two workstations: one AgentRetired per engineer', async () => {
    const { admin, member, org, as, engineers } = await acme({
      memberHasOtherOrg: false,
      secondStation: true,
    });
    expect(engineers).toHaveLength(2);
    await ok(as(admin, 'DELETE', `/api/org/members/${member.id}`));
    for (const id of engineers) await expectOneUnpairRetire(id);
    await noActiveDevopsLeft(org, member.id);
  });

  it('leaveOrg from the last organization: one AgentRetired per engineer', async () => {
    const { member, org, as, engineers } = await acme({ memberHasOtherOrg: false, secondStation: true });
    await ok(as(member, 'DELETE', '/api/org/members/me'));
    for (const id of engineers) await expectOneUnpairRetire(id);
    await noActiveDevopsLeft(org, member.id);
  });

  it('platform deactivation: one AgentRetired per engineer, the direct unlink adds none', async () => {
    const { member, org, stations, engineers } = await acme({ memberHasOtherOrg: false });
    const root = await t.superAdminSession();
    await ok(
      t.req('POST', `/api/platform/orgs/${member.id}/suspend`, {
        cookie: root.cookie,
        body: { reason: 'leaving' },
      }),
    );
    await ok(
      t.req('PATCH', `/api/platform/users/${member.id}`, {
        cookie: root.cookie,
        body: { status: 'deactivated' },
      }),
    );
    for (const id of engineers) await expectOneUnpairRetire(id);
    await noActiveDevopsLeft(org, member.id);
    expect((await q('SELECT status FROM workstations WHERE id=$1', [stations[0]]))[0]?.status).toBe(
      'unlinked',
    );
  });

  it('not the last organization: the removal retires the engineer once and the workstation stays', async () => {
    const { admin, member, org, as, stations, engineers } = await acme({ memberHasOtherOrg: true });
    const personal = await activeDevops(member.id, stations[0]!);
    await ok(as(admin, 'DELETE', `/api/org/members/${member.id}`));
    const ev = await retiredEvents(engineers[0]!);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.reason).toBeUndefined();
    expect(await statusOf(engineers[0]!)).toBe('retired');
    await noActiveDevopsLeft(org, member.id);
    expect((await q('SELECT status FROM workstations WHERE id=$1', [stations[0]]))[0]?.status).toBe('active');
    for (const p of personal) expect(await statusOf(p.id)).toBe('active');
  });

  it('a legacy engineer on a workstation offboarding does not unlink is still retired, once', async () => {
    const { admin, member, org, as, stations, engineers } = await acme({
      memberHasOtherOrg: false,
      secondStation: true,
    });
    const [, orphanStation] = stations;
    const orphan = (await activeDevops(org, orphanStation!))[0]!.id;
    const linked = engineers.filter((id) => id !== orphan);
    // as if unlinked before unpairing retired engineers: the station is gone, its engineer still active
    await q(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [orphanStation]);
    await ok(as(admin, 'DELETE', `/api/org/members/${member.id}`));

    const ev = await retiredEvents(orphan);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.reason).toBeUndefined();
    expect(await statusOf(orphan)).toBe('retired');
    for (const id of linked) await expectOneUnpairRetire(id);
    await noActiveDevopsLeft(org, member.id);
  });

  it('a member without DevOps engineers: no AgentRetired, the removal otherwise as before', async () => {
    const { admin, member, org, as, engineers } = await acme({ memberHasOtherOrg: false });
    // their engineer was retired earlier (for example by hand on the board)
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [engineers[0]]);
    const r = await ok<any>(as(admin, 'DELETE', `/api/org/members/${member.id}`));
    expect(await retiredEvents(engineers[0]!)).toHaveLength(0);
    expect(r.offboarding).toMatchObject({ orgId: org, userId: member.id });
    expect(
      await q(
        `SELECT 1 FROM events WHERE type='OrgMemberRemoved' AND payload->>'orgId'=$1 AND payload->>'userId'=$2`,
        [org, member.id],
      ),
    ).toHaveLength(1);
    expect(
      await q(`SELECT 1 FROM events WHERE type='MemberOffboarded' AND payload->>'userId'=$1`, [member.id]),
    ).toHaveLength(1);
  });
});
