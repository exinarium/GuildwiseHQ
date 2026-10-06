import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner, hireFor, type Member } from './helpers/members.ts';
import {
  createWorld,
  MOCK_RUNTIME,
  ok,
  pairWorkstation,
  REPO_SSH,
  until,
  type World,
} from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
  patch: (url: string, body: unknown = {}) => w.t.req('PATCH', url, { cookie, body }),
  del: (url: string) => w.t.req('DELETE', url, { cookie }),
});

describe('inviting and accepting', () => {
  let guest: { id: string; cookie: string; email: string };
  it('only the owner can invite, and only an existing active user', async () => {
    guest = await w.t.userSession(uniqueEmail('guest'));
    const owner = as(w.owner.cookie);
    expect(
      (await owner.post(`/api/projects/${w.projectId}/members`, { email: 'nobody@example.test' })).status,
    ).toBe(404);
    expect((await owner.post(`/api/projects/${w.projectId}/members`, { email: w.owner.email })).status).toBe(
      400,
    );
    // a stranger who cannot see the project gets 404, a member who sees it gets 403
    expect(
      (await as(guest.cookie).post(`/api/projects/${w.projectId}/members`, { email: guest.email })).status,
    ).toBe(404);
    const r = await owner.post(`/api/projects/${w.projectId}/members`, { email: guest.email.toUpperCase() });
    expect(r.status).toBe(201);
    expect(r.body.members.find((m: any) => m.email === guest.email)).toMatchObject({
      role: 'manager',
      status: 'invited',
    });
    expect((await owner.post(`/api/projects/${w.projectId}/members`, { email: guest.email })).status).toBe(
      409,
    );
  });

  it('a pending invitation grants no access; the inbox lists it', async () => {
    const g = as(guest.cookie);
    expect((await g.get('/api/projects')).body.projects).toEqual([]);
    expect((await g.get(`/api/projects/${w.projectId}`)).status).toBe(404);
    expect((await g.get(`/api/board?projectId=${w.projectId}`)).status).toBe(404);
    const inbox = (await g.get('/api/project-invitations')).body.invitations;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ projectId: w.projectId, projectKey: 'TOY', projectName: 'Toy' });
    // the invitee cannot hire onto the project either
    const hire = await g.post('/api/agents', {
      name: 'Nope',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: w.workstationId,
      projectId: w.projectId,
    });
    expect(hire.status).toBe(404);
  });

  it('declining removes the invitation and the owner can invite again', async () => {
    const g = as(guest.cookie);
    expect((await g.post(`/api/projects/${w.projectId}/members/decline`)).status).toBe(200);
    expect((await g.get('/api/project-invitations')).body.invitations).toEqual([]);
    expect((await g.post(`/api/projects/${w.projectId}/members/accept`)).status).toBe(404);
    expect((await g.get(`/api/projects/${w.projectId}`)).status).toBe(404);
    expect(
      (await as(w.owner.cookie).post(`/api/projects/${w.projectId}/members`, { email: guest.email })).status,
    ).toBe(201);
  });

  it('accepting makes the invitee an additional manager who sees the board and cards', async () => {
    const card = await w.card({ title: 'Visible to members' });
    const g = as(guest.cookie);
    const acc = await g.post(`/api/projects/${w.projectId}/members/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body.project).toMatchObject({ key: 'TOY', myRole: 'manager' });
    expect((await g.get('/api/projects')).body.projects.map((p: any) => p.key)).toEqual(['TOY']);
    const board = await g.get(`/api/board?projectId=${w.projectId}`);
    expect(board.status).toBe(200);
    expect(JSON.stringify(board.body)).toContain(card.ref);
    const d = await g.get(`/api/cards/${card.id}`);
    expect(d.status).toBe(200);
    expect(d.body.card.ownerUserId).toBe(w.owner.id);
    // a manager (not owner) cannot manage the owner's project or the owner's cards
    expect((await g.patch(`/api/projects/${w.projectId}`, { name: 'Hijack' })).status).toBe(403);
    expect((await g.post(`/api/cards/${card.id}/cancel`, { reason: 'no' })).status).toBe(403);
    // but may comment, and create cards that become theirs
    expect((await g.post(`/api/cards/${card.id}/comments`, { body: 'hello from a manager' })).status).toBe(
      201,
    );
    const mine = await ok<any>(
      g.post('/api/cards', {
        projectId: w.projectId,
        title: 'Manager card',
        cardType: 'feature',
        fields: {},
      }),
      201,
    );
    expect(mine.card.ownerUserId).toBe(guest.id);
  });

  it("the guest's own projects stay invisible to the owner", async () => {
    const g = as(guest.cookie);
    const mineProject = await ok<any>(g.post('/api/projects', { key: 'MINE', name: 'Private' }), 201);
    const owner = as(w.owner.cookie);
    expect((await owner.get('/api/projects')).body.projects.map((p: any) => p.key)).toEqual(['TOY']);
    expect((await owner.get(`/api/projects/${mineProject.project.id}`)).status).toBe(404);
    expect((await owner.get(`/api/board?projectId=${mineProject.project.id}`)).status).toBe(404);
    // and vice versa for what the owner keeps private: another project of the owner stays hidden
    const hidden = await ok<any>(owner.post('/api/projects', { key: 'HIDE', name: 'Owner private' }), 201);
    expect((await g.get(`/api/projects/${hidden.project.id}`)).status).toBe(404);
    expect((await g.get('/api/projects')).body.projects.map((p: any) => p.key).sort()).toEqual([
      'MINE',
      'TOY',
    ]);
  });
});

describe('agents and claims across managers', () => {
  let m: Member;
  it("a member hires a project-scoped agent onto their own workstation from the owner's catalogue", async () => {
    m = await addMember(w, 'hirer');
    const a = await hireFor(w, m, 'Mia', 'builder', 'junior');
    expect(a).toMatchObject({
      name: 'Mia',
      orgId: w.owner.id,
      hiredForProjectId: w.projectId,
      allowedProjectIds: [w.projectId],
      workstationId: m.workstationId,
      hiredByUserId: m.id,
      managerUserId: m.id,
    });
    // both managers see the agent in the project; the owner's any-project agent is listed for the member too
    const orgWide = await w.hire('Olga', 'builder', 'junior');
    const mine = (await as(m.cookie).get(`/api/agents`)).body.agents.map((x: any) => x.name);
    expect(mine).toContain('Mia');
    expect(mine).toContain('Olga');
    const theirs = (await as(w.owner.cookie).get(`/api/agents?projectId=${w.projectId}`)).body.agents.map(
      (x: any) => x.name,
    );
    expect(theirs).toContain('Mia');
    expect(orgWide.allowedProjectIds).toBeNull();
    // the owner's role catalogue applies: DevOps cannot be hired
    const devops = await as(m.cookie).post('/api/agents', {
      name: 'Dee',
      roleKey: 'devops',
      seniority: 'senior',
      workstationId: m.workstationId,
      projectId: w.projectId,
    });
    expect(devops.status).toBe(400);
    // a member cannot hire onto the owner's workstation
    const stolen = await as(m.cookie).post('/api/agents', {
      name: 'Eve',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: w.workstationId,
      projectId: w.projectId,
    });
    expect(stolen.status).toBe(404);
  });

  it('that agent claims any card of the project, including cards owned by the owner', async () => {
    const r = await connectMemberRunner(w, m);
    await q(`UPDATE agents SET status='retired' WHERE name='Olga'`);
    const card = await w.card({ title: 'Owner card, member agent' });
    expect(card.ownerUserId).toBe(w.owner.id);
    expect(card.ref).toBeTruthy();
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start', (f) => f.agent.name === 'Mia', 5000, from);
    // FIFO: the oldest queued owner card goes first; whichever it is, it is owned by the owner
    const claimed = (
      await q('SELECT owner_user_id, claimed_by_agent_id FROM cards WHERE ref=$1', [start.brief.card.ref])
    )[0]!;
    expect(claimed.owner_user_id).toBe(w.owner.id);
    expect(claimed.claimed_by_agent_id).toBe(start.agent.agentId);
    expect(start.worktree).toMatchObject({ remoteUrlNormalized: 'github.com/acme/toy' });
    // the member's workstation resolves the repo through their membership
    const wsRepos = await q('SELECT 1 FROM workstation_repos WHERE workstation_id=$1', [m.workstationId]);
    expect(wsRepos).toHaveLength(1);
    r.close();
  });
});

describe('a runner that is already connected when the share is accepted', () => {
  it('matches the project repos right away, and drops them again when the member is removed', async () => {
    const m = await w.t.userSession(uniqueEmail('early'));
    const ws = await pairWorkstation(w.t, m, 'early-box');
    const r = await FakeRunner.connect(w.baseUrl, ws.runnerToken);
    r.hello({
      repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/early', headBranch: 'main' }],
      runtimes: MOCK_RUNTIME,
    });
    await r.waitFor('welcome');
    await w.t.app.ctx.notifier.flush();
    const repos = () => q('SELECT 1 FROM workstation_repos WHERE workstation_id=$1', [ws.workstationId]);
    expect(await repos()).toHaveLength(0); // not a member yet
    await ok(as(w.owner.cookie).post(`/api/projects/${w.projectId}/members`, { email: m.email }), 201);
    await ok(as(m.cookie).post(`/api/projects/${w.projectId}/members/accept`));
    await until(async () => (await repos()).length === 1, 4000, 'repo matched after accept');
    const rescan = await r.waitFor('command', (f) => f.command === 'repos.rescan');
    expect(rescan).toBeTruthy();
    await w.t.req('DELETE', `/api/projects/${w.projectId}/members/${m.id}`, { cookie: w.owner.cookie });
    await until(async () => (await repos()).length === 0, 4000, 'repo dropped after removal');
    r.close();
  });
});

describe('decision policy and card re-home', () => {
  it('only the card owner or the project owner sets the policy; default is owner_only', async () => {
    const memberCard = await (async () => {
      const g = await addMember(w, 'policy');
      const body = await ok<any>(
        as(g.cookie).post('/api/cards', {
          projectId: w.projectId,
          title: 'Their card',
          cardType: 'feature',
          fields: {},
        }),
        201,
      );
      return { g, card: body.card };
    })();
    const ownerCard = await w.card({ title: 'Owner policy card' });
    expect(ownerCard.decisionPolicy).toBe('owner_only');
    const url = (id: string) => `/api/cards/${id}/decision-policy`;
    // a manager cannot open the owner's card
    expect((await as(memberCard.g.cookie).post(url(ownerCard.id), { policy: 'any_manager' })).status).toBe(
      403,
    );
    // the card owner can open their own card
    const opened = await as(memberCard.g.cookie).post(url(memberCard.card.id), { policy: 'any_manager' });
    expect(opened.status).toBe(200);
    expect(opened.body.card.decisionPolicy).toBe('any_manager');
    // the project owner can too, and back
    const back = await as(w.owner.cookie).post(url(memberCard.card.id), { policy: 'owner_only' });
    expect(back.body.card.decisionPolicy).toBe('owner_only');
    expect((await as(w.owner.cookie).post(url(ownerCard.id), { policy: 'nope' })).status).toBe(400);
    const ev = await q(`SELECT payload FROM events WHERE type='DecisionPolicyChanged' ORDER BY seq`);
    expect(ev.map((e) => e.payload.policy)).toEqual(['any_manager', 'owner_only']);
  });

  it('re-homing a card forgets its workstation and worktree', async () => {
    const card = await w.card({ title: 'Rehome me' });
    await q(
      `UPDATE cards SET home_workstation_id=$2, worktree_path='/old/path', branch_name='aom/toy-x', base_branch='main' WHERE id=$1`,
      [card.id, w.workstationId],
    );
    const done = await as(w.owner.cookie).post(`/api/cards/${card.id}/rehome`);
    expect(done.status).toBe(200);
    const row = (
      await q('SELECT home_workstation_id, worktree_path, branch_name FROM cards WHERE id=$1', [card.id])
    )[0]!;
    expect(row).toEqual({ home_workstation_id: null, worktree_path: null, branch_name: null });
    const sys = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [card.id]);
    expect(sys.some((s) => /re-homed/.test(s.body))).toBe(true);
    // a claimed card must be released first
    await q(
      `UPDATE cards SET claim_id=gen_random_uuid(), claimed_by_agent_id=(SELECT id FROM agents LIMIT 1), status='claimed' WHERE id=$1`,
      [card.id],
    );
    expect((await as(w.owner.cookie).post(`/api/cards/${card.id}/rehome`)).status).toBe(409);
  });

  it('inbox updates are visible to the invitee only', async () => {
    const x = await w.t.userSession(uniqueEmail('inbox'));
    await ok(as(w.owner.cookie).post(`/api/projects/${w.projectId}/members`, { email: x.email }), 201);
    expect((await as(x.cookie).get('/api/project-invitations')).body.invitations).toHaveLength(1);
    const other = await w.t.userSession(uniqueEmail('other'));
    expect((await as(other.cookie).get('/api/project-invitations')).body.invitations).toEqual([]);
    await until(
      async () => (await q(`SELECT 1 FROM project_members WHERE user_id=$1 AND status='invited'`, [x.id]))[0],
    );
  });
});
