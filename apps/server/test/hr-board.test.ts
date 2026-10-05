import { BUILTIN_ROLES, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { board, kindsOf, recommendations } from './helpers/hr.ts';
import { addMember, hireFor, type Member } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Additional managers see HR actions only for their own hires; built-in role updates belong to the owner.
let w: World;
let m1: Member;
let m2: Member;
let olga: any; // owner, org-wide
let pam: any; // owner, project-scoped
let mia: any; // m1, project-scoped
beforeAll(async () => {
  w = await createWorld();
  m1 = await addMember(w, 'm-one');
  m2 = await addMember(w, 'm-two');
  olga = await w.hire('Olga', 'builder', 'junior');
  pam = await w.hire('Pam', 'builder', 'junior', { projectId: w.projectId });
  mia = await hireFor(w, m1, 'Mia', 'builder', 'junior');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
});

describe('HR recommendations in a shared project', () => {
  let owner: string;
  let c1: string;
  let c2: string;
  beforeAll(async () => {
    // Ten idle days: every builder is a fire-or-reassign candidate (an empty queue, other builders on the team).
    w.t.clock.advance(10 * 86_400_000);
    owner = await w.t.login(w.owner.email);
    c1 = await w.t.login(m1.email);
    c2 = await w.t.login(m2.email);
  });
  afterAll(() => w.t.clock.setOffset(0));

  const byAgent = (recs: any[]) => Object.fromEntries(recs.map((r) => [r.agentName, r.canApply]));

  it('the owner sees and can apply the recommendations of every agent', async () => {
    const recs = await recommendations(w, owner);
    expect(kindsOf(recs)).toEqual(['fire_idle', 'fire_idle', 'fire_idle']);
    expect(byAgent(recs)).toEqual({ Olga: true, Pam: true, Mia: true });
  });

  it('a member sees the project agents (not the owner org-wide ones) and can apply only for their own hire', async () => {
    expect(byAgent(await recommendations(w, c1))).toEqual({ Pam: false, Mia: true });
    expect(byAgent(await recommendations(w, c2))).toEqual({ Pam: false, Mia: false });
    const b = await board(w, c1);
    expect(
      b.agents
        .filter((a: any) => !a.agent.isDevops)
        .map((a: any) => a.agent.name)
        .sort(),
    ).toEqual(['Mia', 'Pam']);
    const mine = b.agents.find((a: any) => a.agent.name === 'Mia');
    expect(mine.agent.managerUserId).toBe(m1.id);
    expect(b.recommendations.map((r: any) => r.agentName).sort()).toEqual(['Mia', 'Pam']);
  });

  it("applying someone else's recommendation is refused, and so is one for an agent they cannot see", async () => {
    const id = (agentName: string, recs: any[]) => recs.find((r) => r.agentName === agentName).id as string;
    const ownerRecs = await recommendations(w, owner);
    expect((await as(c1).post(`/api/hr/recommendations/${id('Pam', ownerRecs)}/apply`)).status).toBe(403);
    expect((await as(c2).post(`/api/hr/recommendations/${id('Mia', ownerRecs)}/apply`)).status).toBe(403);
    expect((await as(c1).post(`/api/hr/recommendations/${id('Olga', ownerRecs)}/apply`)).status).toBe(404);
    expect((await q('SELECT status FROM agents WHERE id=$1', [olga.id]))[0]!.status).toBe('active');
  });

  it('the hiring manager applies theirs; the change is an event by them', async () => {
    const recs = await recommendations(w, c1);
    const res = await as(c1).post(
      `/api/hr/recommendations/${recs.find((r) => r.agentName === 'Mia').id}/apply`,
    );
    expect(res.status).toBe(200);
    expect(res.body.agentIds).toEqual([mia.id]);
    expect((await q('SELECT status FROM agents WHERE id=$1', [mia.id]))[0]!.status).toBe('retired');
    const ev = (await q(`SELECT actor_id FROM events WHERE type='AgentRetired'`))[0]!;
    expect(ev.actor_id).toBe(m1.id);
    // Pam stays (and is no longer one of several idle builders in her scope for Mia, but still has Olga).
    expect((await q('SELECT status FROM agents WHERE id=$1', [pam.id]))[0]!.status).toBe('active');
  });
});

/** The shipped default version of the tester role (bumped whenever its definition changes). */
const TESTER_V = BUILTIN_ROLES.find((r) => r.key === 'tester')?.version ?? 0;

describe('built-in role defaults', () => {
  const extend = (baseVersion: number) =>
    w.t.app.ctx.store.append([
      {
        streamId: streamId.role(w.owner.id, 'tester'),
        event: {
          type: 'RoleExtended',
          payload: {
            orgId: w.owner.id,
            roleKey: 'tester',
            baseVersion,
            extensions: {
              instructions: 'Always run lint first.',
              skills: ['lint'],
              standingOrders: ['Never skip e2e'],
            },
          },
        },
        actor: { kind: 'user', id: w.owner.id },
        scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
      },
    ]);

  it('the owner sees a new default version and resets, which drops the extensions shown beforehand', async () => {
    const tess = await w.hire('Tess', 'tester', 'junior');
    await q('UPDATE agents SET role_version = 1 WHERE id=$1', [tess.id]);
    await extend(1); // written against v1; the shipped default is newer (tester)
    const b = await board(w);
    expect(b.roleUpdates).toEqual([
      {
        roleKey: 'tester',
        roleName: 'Tester',
        extensionBaseVersion: 1,
        latestVersion: TESTER_V,
        purpose: expect.any(String),
        extensions: {
          instructions: 'Always run lint first.',
          skills: ['lint'],
          standingOrders: ['Never skip e2e'],
        },
        agentsOnOlderVersion: 1,
      },
    ]);

    const res = await ok<any>(w.t.req('POST', '/api/hr/roles/tester/reset', { cookie: w.owner.cookie }));
    expect(res).toMatchObject({
      roleKey: 'tester',
      toVersion: TESTER_V,
      droppedExtensions: {
        instructions: 'Always run lint first.',
        skills: ['lint'],
        standingOrders: ['Never skip e2e'],
      },
      updatedAgentIds: [tess.id],
    });
    expect(await q(`SELECT 1 FROM role_extensions WHERE org_id=$1`, [w.owner.id])).toHaveLength(0);
    expect((await q('SELECT role_version FROM agents WHERE id=$1', [tess.id]))[0]!.role_version).toBe(
      TESTER_V,
    );
    const ev = (await q(`SELECT payload, actor_id FROM events WHERE type='RoleResetToDefault'`))[0]!;
    expect(ev.payload).toMatchObject({
      roleKey: 'tester',
      toVersion: TESTER_V,
      droppedExtensions: { skills: ['lint'] },
    });
    expect(ev.actor_id).toBe(w.owner.id);
    expect((await board(w)).roleUpdates).toEqual([]);
    expect((await w.t.req('POST', '/api/hr/roles/tester/reset', { cookie: w.owner.cookie })).status).toBe(
      409,
    );
  });

  it("a member neither sees the owner's role updates nor can reset them", async () => {
    await extend(1);
    const cookie = await w.t.login(m1.email);
    expect((await board(w, cookie)).roleUpdates).toEqual([]);
    expect((await ok<any>(w.t.req('GET', '/api/hr/role-updates', { cookie }))).roleUpdates).toEqual([]);
    expect((await w.t.req('POST', '/api/hr/roles/tester/reset', { cookie })).status).toBe(409);
    expect(await q(`SELECT 1 FROM role_extensions WHERE org_id=$1`, [w.owner.id])).toHaveLength(1);
    expect(
      (await w.t.req('POST', '/api/hr/roles/nonexistent/reset', { cookie: w.owner.cookie })).status,
    ).toBe(404);
  });

  it('a role without extensions is offered when an agent runs an older default, and reset moves the agent', async () => {
    // Real use: a new app version shipped BA v5; agents hired on v4 never saw it because the list required extensions.
    await q('DELETE FROM role_extensions');
    const tess = await w.hire('Tara', 'tester', 'junior');
    await q('UPDATE agents SET role_version = 1 WHERE id=$1', [tess.id]);
    const b = await board(w);
    expect(b.roleUpdates).toEqual([
      expect.objectContaining({
        roleKey: 'tester',
        extensionBaseVersion: null,
        latestVersion: TESTER_V,
        extensions: { instructions: '', skills: [], standingOrders: [] },
        agentsOnOlderVersion: 1,
      }),
    ]);
    const res = await ok<any>(w.t.req('POST', '/api/hr/roles/tester/reset', { cookie: w.owner.cookie }));
    expect(res).toMatchObject({ roleKey: 'tester', toVersion: TESTER_V, updatedAgentIds: [tess.id] });
    expect((await q('SELECT role_version FROM agents WHERE id=$1', [tess.id]))[0]!.role_version).toBe(
      TESTER_V,
    );
    expect((await board(w)).roleUpdates).toEqual([]);
  });

  it('an extension already on the latest version is not an update', async () => {
    await q('DELETE FROM role_extensions');
    await extend(TESTER_V);
    expect((await board(w)).roleUpdates).toEqual([]);
  });
});
