import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgScope, SYSTEM_ACTOR } from '../src/commands/common.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, hireFor, type Member } from './helpers/members.ts';
import { createWorld, markOnline, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
let guest: Member;
let projB: string;
let projC: string;

const refOf = async (cardId: string) =>
  (await q('SELECT ref FROM cards WHERE id=$1', [cardId]))[0]!.ref as string;

/** Runs passes until nothing is claimed; returns the card refs in claim order. */
async function drain(): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 30; i++) {
    const made = await w.t.app.ctx.services.dispatcher.runPass();
    if (made.length === 0) break;
    for (const m of made) out.push(await refOf(m.cardId));
  }
  return out;
}

async function newProject(key: string, extra: Record<string, unknown> = {}): Promise<string> {
  const p = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key, name: key, ...extra } }),
    201,
  );
  await ok(
    w.t.req('POST', `/api/projects/${p.project.id}/repos`, {
      cookie: w.owner.cookie,
      body: { name: key.toLowerCase(), remoteUrl: `https://github.com/acme/${key.toLowerCase()}.git` },
    }),
    201,
  );
  return p.project.id;
}

async function online(): Promise<void> {
  const repos = (await q('SELECT id FROM project_repos')).map((r) => r.id as string);
  await markOnline(w.t, w.workstationId, { repoIds: repos });
  await markOnline(w.t, guest.workstationId, { repoIds: repos });
}

async function reset(): Promise<void> {
  await q(
    'TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents CASCADE',
  );
  await q('UPDATE projects SET next_card_number = 1, max_concurrent_shifts = NULL');
  await online();
}

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method as 'GET', url, { cookie: w.owner.cookie, ...(body ? { body } : {}) });

beforeAll(async () => {
  w = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  guest = await addMember(w, 'guest');
  projB = await newProject('BEE');
  projC = await newProject('CEE');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('allow-list x membership x guest workstation (dispatcher eligibility)', () => {
  it('an agent allowed on one project never takes a card of another; "any" takes both', async () => {
    await reset();
    await w.hire('OnlyToy', 'builder', 'junior', { allowedProjectIds: [w.projectId] });
    const toy = await w.card({ title: 'toy' });
    await w.card({ projectId: projB, title: 'bee' });
    expect(await drain()).toEqual([toy.ref]);

    await reset();
    await w.hire('Anywhere', 'builder', 'junior', { allowedProjectIds: null, capacity: 8 });
    await w.card({ title: 'toy' });
    await w.card({ projectId: projB, title: 'bee' });
    expect((await drain()).sort()).toEqual(['BEE-1', 'TOY-1']);
  });

  it('an empty allow-list benches the agent', async () => {
    await reset();
    const a = await w.hire('Benched', 'builder', 'junior', { allowedProjectIds: [w.projectId] });
    await w.card({ title: 'toy' });
    await ok(owner('PUT', `/api/agents/${a.id}/allowed-projects`, { projectIds: [] }));
    expect(await drain()).toEqual([]);
    await ok(owner('PUT', `/api/agents/${a.id}/allowed-projects`, { projectIds: null }));
    expect(await drain()).toEqual(['TOY-1']);
  });

  it("a guest's agent works the shared project but never a project its workstation owner is not on", async () => {
    await reset();
    // allowed on both, but the guest is a member of TOY only
    const g = await hireFor(w, guest, 'Gus', 'builder', 'junior', { capacity: 8 });
    await q('UPDATE agents SET allowed_project_ids = $2::uuid[] WHERE id=$1', [g.id, [w.projectId, projB]]);
    await w.card({ title: 'toy' });
    await w.card({ projectId: projB, title: 'bee' });
    expect(await drain()).toEqual(['TOY-1']);
    // "any project" does not widen the membership rule either
    await q('UPDATE agents SET allowed_project_ids = NULL WHERE id=$1', [g.id]);
    await q(
      `UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL, status='queued', queued_at=now() WHERE ref='TOY-1'`,
    );
    await q('TRUNCATE shifts CASCADE');
    expect(await drain()).toEqual(['TOY-1']);
    expect((await q(`SELECT status FROM cards WHERE ref='BEE-1'`))[0]!.status).toBe('queued');
  });

  it('the owner agent is limited by the allow-list although the owner is a member of every project', async () => {
    await reset();
    await w.hire('Bee', 'builder', 'junior', { allowedProjectIds: [projB], capacity: 8 });
    await w.card({ title: 'toy' });
    await w.card({ projectId: projB, title: 'bee' });
    await w.card({ projectId: projC, title: 'cee' });
    expect(await drain()).toEqual(['BEE-1']);
  });

  it('a suspended organization is never offered cards', async () => {
    await reset();
    await w.hire('Susp', 'builder', 'junior', { allowedProjectIds: null });
    await w.card({ title: 'toy' });
    await q(`UPDATE organizations SET status='suspended' WHERE id=$1`, [w.owner.id]);
    try {
      expect(await drain()).toEqual([]);
    } finally {
      await q(`UPDATE organizations SET status='active' WHERE id=$1`, [w.owner.id]);
    }
  });
});

describe('focus projects order the work inside the allow-list', () => {
  it('a focus project goes before an older card of another project; without focus FIFO decides', async () => {
    await reset();
    const a = await w.hire('Focus', 'builder', 'junior', { allowedProjectIds: null, capacity: 8 });
    await w.card({ title: 'toy old' }); // TOY-1
    await w.card({ projectId: projB, title: 'bee' }); // BEE-1
    await q(`UPDATE cards SET queued_at = now() - interval '1 hour' WHERE ref='TOY-1'`);
    expect(await drain()).toEqual(['TOY-1', 'BEE-1']);

    await reset();
    await w.hire('Focus2', 'builder', 'junior', { allowedProjectIds: null, capacity: 8 });
    const id = (await q(`SELECT id FROM agents WHERE name='Focus2'`))[0]!.id as string;
    await ok(owner('PUT', `/api/agents/${id}/focus-projects`, { projectIds: [projB] }));
    await w.card({ title: 'toy old' });
    await w.card({ projectId: projB, title: 'bee' });
    await q(`UPDATE cards SET queued_at = now() - interval '1 hour' WHERE ref='TOY-1'`);
    expect(await drain()).toEqual(['BEE-1', 'TOY-1']);
    expect(a.focusProjectIds).toEqual([]);
  });

  it('focus is a preference only: it never lets an agent work outside its allow-list', async () => {
    await reset();
    const a = await w.hire('Pref', 'builder', 'junior', { allowedProjectIds: [w.projectId], capacity: 8 });
    // a focus on a project outside the allow-list is refused ...
    const bad = await owner('PUT', `/api/agents/${a.id}/focus-projects`, { projectIds: [projB] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('focus_not_allowed');
    // ... and narrowing the allow-list drops the project from the focus
    await ok(owner('PUT', `/api/agents/${a.id}/allowed-projects`, { projectIds: [w.projectId, projB] }));
    await ok(owner('PUT', `/api/agents/${a.id}/focus-projects`, { projectIds: [projB] }));
    await ok(owner('PUT', `/api/agents/${a.id}/allowed-projects`, { projectIds: [w.projectId] }));
    expect(
      (await q('SELECT focus_project_ids FROM agents WHERE id=$1', [a.id]))[0]!.focus_project_ids,
    ).toEqual([]);
  });

  it('the hire dialog default: allowed and focus projects at hire time', async () => {
    const a = await w.hire('Hired', 'builder', 'junior', {
      allowedProjectIds: [w.projectId, projB],
      focusProjectIds: [projB],
    });
    expect(a).toMatchObject({ allowedProjectIds: [w.projectId, projB], focusProjectIds: [projB] });
    const refused = await w.t.req('POST', '/api/agents', {
      cookie: w.owner.cookie,
      body: {
        name: 'Outside',
        roleKey: 'builder',
        seniority: 'junior',
        workstationId: w.workstationId,
        allowedProjectIds: [w.projectId],
        focusProjectIds: [projB],
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('focus_not_allowed');
  });
});

describe('who may set the allow-list', () => {
  it('a guest manager may only name projects they are on and never "any project"', async () => {
    const g = await hireFor(w, guest, 'Gil', 'builder', 'junior');
    const set = (projectIds: string[] | null) =>
      w.t.req('PUT', `/api/agents/${g.id}/allowed-projects`, { cookie: guest.cookie, body: { projectIds } });
    expect((await set(null)).status).toBe(403);
    expect((await set([projB])).status).toBe(403); // the guest is not on BEE
    expect((await set([w.projectId])).status).toBe(200);
    // the owner of the organization may do anything with it
    expect((await owner('PUT', `/api/agents/${g.id}/allowed-projects`, { projectIds: null })).status).toBe(
      200,
    );
  });

  it('a guest hires into the owner organization only for projects they are on', async () => {
    const base = {
      name: 'Nope',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: guest.workstationId,
      runtime: 'mock',
      model: 'mock',
    };
    const outside = await w.t.req('POST', '/api/agents', {
      cookie: guest.cookie,
      body: { ...base, allowedProjectIds: [projB] },
    });
    expect(outside.status).toBe(404);
    const inOrg = await w.t.req('POST', '/api/agents', {
      cookie: guest.cookie,
      body: { ...base, name: 'Yes', allowedProjectIds: [w.projectId] },
    });
    expect(inOrg.status).toBe(201);
    expect(inOrg.body.orgId).toBe(w.owner.id);
  });

  it('the DevOps engineer is not subject to allow-lists or focus', async () => {
    await pairWorkstation(w.t, w.owner, 'second-box'); // pairing hires the DevOps engineer of the workstation
    const devops = (await ok<any>(owner('GET', '/api/agents'))).agents.find((a: any) => a.isDevops);
    const r1 = await owner('PUT', `/api/agents/${devops.id}/allowed-projects`, { projectIds: [w.projectId] });
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('devops_fixed');
    expect((await owner('PUT', `/api/agents/${devops.id}/focus-projects`, { projectIds: [] })).status).toBe(
      400,
    );
  });

  it('refuses projects of another organization', async () => {
    const a = await w.hire('Foreign', 'builder', 'junior');
    const other = await w.t.userSession(`other-${Date.now()}@example.test`);
    const own = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: other.cookie, body: { key: 'ZZZ', name: 'Elsewhere' } }),
      201,
    );
    const r = await owner('PUT', `/api/agents/${a.id}/allowed-projects`, { projectIds: [own.project.id] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_project');
  });
});

describe('optional per-project concurrency cap', () => {
  it('is off by default and limits the shifts running at once when set', async () => {
    await reset();
    await w.hire('Many', 'builder', 'junior', { allowedProjectIds: null, capacity: 8 });
    await w.hire('Many2', 'builder', 'junior', { allowedProjectIds: null, capacity: 8 });
    for (let i = 0; i < 3; i++) await w.card({ title: `c${i}` });
    const detail = await ok<any>(owner('GET', `/api/projects/${w.projectId}`));
    expect(detail.project.maxConcurrentShifts).toBeNull();

    const set = await ok<any>(owner('PUT', `/api/projects/${w.projectId}/concurrency-cap`, { cap: 2 }));
    expect(set.project.maxConcurrentShifts).toBe(2);
    expect(await drain()).toHaveLength(2);
    expect(
      (
        await q(`SELECT count(*)::int AS n FROM cards WHERE project_id=$1 AND claim_id IS NOT NULL`, [
          w.projectId,
        ])
      )[0]!.n,
    ).toBe(2);

    // the cap is per project: another project is not held back by it
    await w.card({ projectId: projB, title: 'free' });
    expect(await drain()).toEqual(['BEE-1']);

    // removing the cap lets the third card go
    const off = await ok<any>(owner('PUT', `/api/projects/${w.projectId}/concurrency-cap`, { cap: null }));
    expect(off.project.maxConcurrentShifts).toBeNull();
    expect(await drain()).toHaveLength(1);
  });

  it('rejects a cap below one and a stranger', async () => {
    expect((await owner('PUT', `/api/projects/${w.projectId}/concurrency-cap`, { cap: 0 })).status).toBe(400);
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    const r = await w.t.req('PUT', `/api/projects/${w.projectId}/concurrency-cap`, {
      cookie: stranger.cookie,
      body: { cap: 1 },
    });
    expect(r.status).toBe(404);
  });
});

describe('members leaving: agents are re-homed only when it was their last project', () => {
  it('keeps the agent when the guest is still on another project of the organization', async () => {
    await reset();
    // share BEE with the guest too
    await ok(owner('POST', `/api/projects/${projB}/members`, { email: guest.email }), 201);
    await ok(w.t.req('POST', `/api/projects/${projB}/members/accept`, { cookie: guest.cookie }));
    const a = await hireFor(w, guest, 'Stay', 'builder', 'junior', {
      allowedProjectIds: [w.projectId, projB],
    });
    await ok(
      w.t.req('PUT', `/api/agents/${a.id}/focus-projects`, {
        cookie: guest.cookie,
        body: { projectIds: [projB] },
      }),
    );
    // removal of BEE: the guest is on TOY still, so the agent stays active on its workstation
    await ok(owner('DELETE', `/api/projects/${projB}/members/${guest.id}`));
    let row = (
      await q('SELECT status, workstation_id, focus_project_ids FROM agents WHERE id=$1', [a.id])
    )[0]!;
    expect(row.status).toBe('active');
    expect(row.workstation_id).toBe(guest.workstationId);
    expect(row.focus_project_ids).toEqual([]); // BEE left its focus
    // it can still work TOY but no longer BEE
    await w.card({ title: 'toy' });
    await w.card({ projectId: projB, title: 'bee' });
    expect(await drain()).toEqual(['TOY-1']);
    // removal from the last project: the agent goes back to the owner, needing a new home
    await ok(owner('DELETE', `/api/projects/${w.projectId}/members/${guest.id}`));
    row = (await q('SELECT status, workstation_id, manager_user_id FROM agents WHERE id=$1', [a.id]))[0]!;
    expect(row.status).toBe('needs_rehome');
    expect(row.workstation_id).toBeNull();
    expect(row.manager_user_id).toBe(w.owner.id);
  });
});

describe('projection rebuild', () => {
  it('replays allow-lists, focus and caps; a pre-allow-list AgentHired keeps its meaning', async () => {
    const w2 = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
    try {
      const o2 = (method: string, url: string, body?: unknown) =>
        w2.t.req(method as 'GET', url, { cookie: w2.owner.cookie, ...(body ? { body } : {}) });
      const pb = await ok<any>(o2('POST', '/api/projects', { key: 'BEE', name: 'Bee' }), 201);
      const a = await w2.hire('Rebuilt', 'builder', 'junior', {
        allowedProjectIds: [w2.projectId, pb.project.id],
      });
      await ok(o2('PUT', `/api/agents/${a.id}/focus-projects`, { projectIds: [pb.project.id] }));
      await ok(o2('PUT', `/api/projects/${w2.projectId}/concurrency-cap`, { cap: 3 }));
      // a hire written before allow-lists existed: only `projectId`, or nothing at all
      const src = (
        await q(`SELECT payload FROM events WHERE stream_id=$1 AND type='AgentHired'`, [`agent-${a.id}`])
      )[0]!.payload;
      const legacy = async (name: string, projectId?: string) => {
        const { allowedProjectIds: _a, focusProjectIds: _f, projectId: _p, ...rest } = src;
        const id = randomUUID();
        await w2.t.app.ctx.store.append([
          {
            streamId: streamId.agent(id),
            event: {
              type: 'AgentHired',
              payload: { ...rest, agentId: id, name, ...(projectId ? { projectId } : {}) },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(w2.owner.id),
          },
        ]);
        return id;
      };
      const scoped = await legacy('OldScoped', pb.project.id);
      const wide = await legacy('OldWide');
      const row = async (id: string) =>
        (await q('SELECT allowed_project_ids, hired_for_project_id FROM agents WHERE id=$1', [id]))[0]!;
      expect(await row(scoped)).toEqual({
        allowed_project_ids: [pb.project.id],
        hired_for_project_id: pb.project.id,
      });
      expect(await row(wide)).toEqual({ allowed_project_ids: null, hired_for_project_id: null });

      const snapshot = async () => ({
        agents: await q(
          `SELECT name, hired_for_project_id, allowed_project_ids, focus_project_ids FROM agents ORDER BY name`,
        ),
        caps: await q('SELECT key, max_concurrent_shifts FROM projects ORDER BY key'),
      });
      const before = await snapshot();
      expect(before.agents.find((x) => x.name === 'Rebuilt')?.focus_project_ids).toEqual([pb.project.id]);
      await rebuildProjections(w2.t.app.ctx.pool, w2.t.app.ctx.store);
      expect(await snapshot()).toEqual(before);
    } finally {
      await w2.t.close();
    }
  });
});
