import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createFeedInterest } from './helpers/feeds.ts';
import { createWorld, markOnline, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
const refOf = async (cardId: string) =>
  (await q('SELECT ref FROM cards WHERE id=$1', [cardId]))[0]!.ref as string;

/** Runs passes until nothing is claimed; returns the card refs in the order they were claimed. */
async function drain(): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 30; i++) {
    const made = await w.t.app.ctx.services.dispatcher.runPass();
    if (made.length === 0) break;
    for (const m of made) out.push(await refOf(m.cardId));
  }
  return out;
}

/** Creates a code project with the toy repository and returns its id. */
async function newProject(key: string, name: string): Promise<string> {
  const existing = (await q('SELECT id FROM projects WHERE org_id=$1 AND key=$2', [w.owner.id, key]))[0];
  const p = existing
    ? { project: { id: existing.id as string } }
    : await ok<any>(w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key, name } }), 201);
  if (!existing)
    await w.t.req('POST', `/api/projects/${p.project.id}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'toy', remoteUrl: 'https://github.com/acme/toy.git' },
    });
  await markOnline(w.t, w.workstationId, {
    repoIds: (await q('SELECT id FROM project_repos')).map((r) => r.id),
  });
  return p.project.id;
}

/** The Owner orders the projects by key, most important first (every active project must be named). */
async function rank(keys: string[]) {
  const ids = await Promise.all(
    keys.map(
      async (k) => (await q('SELECT id FROM projects WHERE org_id=$1 AND key=$2', [w.owner.id, k]))[0]!.id,
    ),
  );
  const rest = (
    await q(
      `SELECT id FROM projects WHERE org_id=$1 AND kind='project' AND status='active' AND NOT (id = ANY($2::uuid[]))`,
      [w.owner.id, ids],
    )
  ).map((r) => r.id);
  await ok(
    w.t.req('PUT', '/api/projects/ranking', {
      cookie: w.owner.cookie,
      body: { projectIds: [...ids, ...rest] },
    }),
  );
}
const ranks = async () =>
  Object.fromEntries(
    (await q(`SELECT key, rank FROM projects WHERE kind='project' ORDER BY rank`)).map((r) => [
      r.key,
      r.rank,
    ]),
  );

async function reset() {
  await q(
    'TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents CASCADE',
  );
  await q('UPDATE projects SET next_card_number = 1');
  await markOnline(w.t, w.workstationId, {
    repoIds: (await q('SELECT id FROM project_repos')).map((r) => r.id),
  });
}

beforeAll(async () => {
  w = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('dispatcher ordering', () => {
  it('takes scheduled cards first, then projects in the order the organization ranked them', async () => {
    await reset();
    const personal = await ok<any>(
      w.t.req('POST', '/api/projects', {
        cookie: w.owner.cookie,
        body: { key: 'PER', name: 'Side project' },
      }),
      201,
    );
    await w.t.req('POST', `/api/projects/${personal.project.id}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'toy', remoteUrl: 'https://github.com/acme/toy.git' },
    });
    const repos = await q('SELECT id FROM project_repos');
    await markOnline(w.t, w.workstationId, { repoIds: repos.map((r) => r.id) });
    await w.hire('Solo', 'builder', 'junior', { capacity: 8 });
    const p1 = await w.card({ projectId: personal.project.id, title: 'personal first' }); // PER-1, oldest
    const work = await w.card({ title: 'work' }); // TOY-1
    const sched = await w.card({ projectId: personal.project.id, title: 'scheduled personal' }); // PER-2
    await q('UPDATE cards SET scheduled = true WHERE id=$1', [sched.id]);
    expect(p1.ref).toBe('PER-1');
    // PER was created after TOY, so it is ranked below it (a new project goes to the bottom)
    expect(await ranks()).toEqual({ TOY: 1, PER: 2 });
    expect(await drain()).toEqual(['PER-2', 'TOY-1', 'PER-1']);
  });

  it('builders take own rework/bug, then other rework/bug, then To do; FIFO within a class', async () => {
    await reset();
    const me = await w.hire('Me', 'builder', 'junior', { capacity: 8 });
    const other = await w.hire('Other', 'builder', 'junior');
    const todoOld = await w.card({ title: 'todo old' }); // TOY-1
    const todoNew = await w.card({ title: 'todo new' }); // TOY-2
    const otherRework = await w.card({ title: 'other rework' }); // TOY-3
    const myRework = await w.card({ title: 'my rework' }); // TOY-4
    const myBug = await w.card({ title: 'my bug', cardType: 'bug' }); // TOY-5
    await q('UPDATE cards SET rework_round=1, original_builder_agent_id=$2 WHERE id=$1', [
      otherRework.id,
      other.id,
    ]);
    await q('UPDATE cards SET rework_round=2, original_builder_agent_id=$2 WHERE id=$1', [
      myRework.id,
      me.id,
    ]);
    await q('UPDATE cards SET original_builder_agent_id=$2 WHERE id=$1', [myBug.id, me.id]);
    // make "Other" unavailable so only "Me" claims
    await q(`UPDATE agents SET status='active', workstation_id=$2 WHERE id=$1`, [other.id, w.workstationId]);
    await q('UPDATE agents SET capacity=1 WHERE id=$1', [other.id]);
    await q(`UPDATE cards SET queued_at = now() - interval '1 hour' WHERE id=$1`, [todoOld.id]);
    await q(`UPDATE cards SET queued_at = now() - interval '30 minutes' WHERE id=$1`, [todoNew.id]);
    await q(`UPDATE cards SET queued_at = now() - interval '50 minutes' WHERE id=$1`, [myRework.id]);
    await q(`UPDATE cards SET queued_at = now() - interval '40 minutes' WHERE id=$1`, [myBug.id]);
    await q(`UPDATE cards SET queued_at = now() - interval '20 minutes' WHERE id=$1`, [otherRework.id]);
    // Retire "Other" by SQL so it is not a competitor; "Me" works through the queue.
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [other.id]);
    const order = await drain();
    // own rework/bug first (FIFO among them), then other's rework, then To do by age
    expect(order).toEqual(['TOY-4', 'TOY-5', 'TOY-3', 'TOY-1', 'TOY-2']);
  });

  it('gates the first build on dependencies and releases it when they are done', async () => {
    await reset();
    await w.hire('Dep', 'builder', 'junior', { capacity: 8 });
    const base = await w.card({ title: 'base' }); // TOY-1
    const dependent = await w.card({ title: 'dependent', dependencies: [base.id] }); // TOY-2
    expect(dependent.dependencies.map((d: any) => d.ref)).toEqual(['TOY-1']);
    expect(await drain()).toEqual(['TOY-1']);
    await q(
      `UPDATE cards SET status='done', stage='done', claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL, claim_workstation_id=NULL WHERE id=$1`,
      [base.id],
    );
    await q(`UPDATE agents SET capacity = 8`);
    expect(await drain()).toEqual(['TOY-2']);
  });

  it('S1a: a card with an unmerged dependency is offered for design only, never for build or review, until it merges', async () => {
    await reset();
    await q(`UPDATE projects SET design_step=true, investigation_location='repo' WHERE id=$1`, [w.projectId]);
    const builder = await w.hire('Gate Bld', 'builder', 'senior', { capacity: 8 });
    await w.hire('Gate Rev', 'reviewer', 'senior', { capacity: 8 });
    await w.hire('Gate Arch', 'architect', 'senior', { capacity: 8 });
    const base = await w.card({ title: 'base' }); // TOY-1
    await q(`UPDATE cards SET status='blocked' WHERE id=$1`, [base.id]); // never dispatched, never landed
    const dep = await w.card({ title: 'dependent', designNeeded: true, dependencies: [base.id] }); // TOY-2
    const release = (stage: string, extra = '') =>
      q(
        `UPDATE cards SET stage=$2, status='queued', claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL,
           claim_workstation_id=NULL, worktree_path='/tmp/wt', queued_at=now() ${extra} WHERE id=$1`,
        [dep.id, stage],
      );
    const claimedStage = async () => {
      const made = await w.t.app.ctx.services.dispatcher.runPass();
      return made.map((m) => m.stage);
    };
    // first build and review: nothing is offered
    await release('build');
    expect(await claimedStage()).toEqual([]);
    await release('review');
    expect(await claimedStage()).toEqual([]);
    // a card that already had its first build and returns to build or review (rework) waits as well
    await release(
      'build',
      `, rework_round=1, original_builder_agent_id='${builder.id}', last_agent_id='${builder.id}'`,
    );
    expect(await claimedStage()).toEqual([]);
    await release(
      'review',
      `, rework_round=1, original_builder_agent_id='${builder.id}', last_agent_id='${builder.id}'`,
    );
    expect(await claimedStage()).toEqual([]);
    // design is the one stage that is offered while the dependency is unmerged
    await release('investigate');
    expect(await claimedStage()).toEqual(['investigate']);
    // once the dependency has merged, build is offered
    await q(`UPDATE cards SET merged_into_working_at=now() WHERE id=$1`, [base.id]);
    await release('build');
    expect(await claimedStage()).toEqual(['build']);
    await q(`UPDATE projects SET design_step=false WHERE id=$1`, [w.projectId]);
  });

  it('orders by project rank, then card priority, then FIFO', async () => {
    await reset();
    await w.hire('Prio', 'builder', 'junior', { capacity: 8 });
    const hi = await newProject('HI', 'Hi');
    await rank(['HI', 'TOY']); // the Owner dragged HI to the top
    const a = await w.card({ title: 'a' }); // TOY-1 prio 2
    const b = await w.card({ title: 'b', priority: 1 }); // TOY-2 prio 1
    const c = await w.card({ title: 'c', projectId: hi, priority: 5 }); // HI-1 in the top project
    const d = await w.card({ title: 'd' }); // TOY-3 prio 2 (younger than a)
    await q(`UPDATE cards SET queued_at = now() - interval '10 minutes' WHERE id=$1`, [a.id]);
    await q(`UPDATE cards SET queued_at = now() - interval '5 minutes' WHERE id=$1`, [d.id]);
    expect(b.priority).toBe(1);
    expect(c.ref).toBe('HI-1');
    // the project's rank beats the card's own priority
    expect(await drain()).toEqual(['HI-1', 'TOY-2', 'TOY-1', 'TOY-3']);
  });

  it('moving a project in the ranking changes who is served first', async () => {
    await reset();
    await w.hire('Mover', 'builder', 'junior', { capacity: 8 });
    const lo = await newProject('LOW', 'Low');
    await rank(['TOY', 'LOW']);
    await w.card({ title: 'toy' }); // TOY-1
    await w.card({ title: 'low', projectId: lo }); // LOW-1
    expect(await drain()).toEqual(['TOY-1', 'LOW-1']);
    await reset();
    await w.hire('Mover2', 'builder', 'junior', { capacity: 8 });
    await rank(['LOW', 'TOY']);
    await w.card({ title: 'toy' });
    await w.card({ title: 'low', projectId: lo });
    expect(await drain()).toEqual(['LOW-1', 'TOY-1']);
  });

  it("an agent's own rework comes before the ranking; a focus project is a soft preference ahead of it", async () => {
    await reset();
    const me = await w.hire('Focus', 'builder', 'junior', { capacity: 8 });
    const lo = await newProject('LOW', 'Low');
    await rank(['TOY', 'LOW']);
    const top = await w.card({ title: 'top project' }); // TOY-1, rank 1
    const low = await w.card({ title: 'low project', projectId: lo }); // LOW-1, rank 2
    const rework = await w.card({ title: 'my rework', projectId: lo }); // LOW-2, rank 2, own rework
    await q('UPDATE cards SET rework_round=1, original_builder_agent_id=$2 WHERE id=$1', [rework.id, me.id]);
    expect(top.ref).toBe('TOY-1');
    expect(low.ref).toBe('LOW-1');
    // without a focus: own rework, then the ranking
    expect(await drain()).toEqual(['LOW-2', 'TOY-1', 'LOW-1']);
    await reset();
    const me2 = await w.hire('Focus2', 'builder', 'junior', { capacity: 8 });
    await q(`UPDATE agents SET focus_project_ids = ARRAY[$1]::uuid[] WHERE id=$2`, [lo, me2.id]);
    await w.card({ title: 'top project' });
    await w.card({ title: 'low project', projectId: lo });
    // the focus project's card is preferred although its project is ranked lower
    expect(await drain()).toEqual(['LOW-1', 'TOY-1']);
  });

  it('an interest run and "Research this" count as scheduled: they come before ranked project work', async () => {
    await reset();
    await w.hire('Rhea', 'researcher', 'junior', { capacity: 8 });
    const research = await ok<any>(
      w.t.req('POST', '/api/projects', {
        cookie: w.owner.cookie,
        body: { key: 'RSCH', name: 'Research', workflowKey: 'research' },
      }),
      201,
    );
    await rank(['RSCH', 'TOY']);
    await ok(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: research.project.id,
          title: 'A ranked research question',
          cardType: 'research',
          fields: { question: 'Why?', depth: 'quick' },
          specify: true,
        },
      }),
      201,
    );
    const { id, projectId } = await createFeedInterest(w, { name: 'Topic' });
    // the interest's project is never ranked
    expect((await q('SELECT rank FROM projects WHERE id=$1', [projectId]))[0]!.rank).toBeNull();
    const run = await ok<any>(
      w.t.req('POST', `/api/interests/${id}/run`, { cookie: w.owner.cookie, body: { kind: 'research' } }),
      201,
    );
    expect((await q('SELECT scheduled FROM cards WHERE id=$1', [run.cardId]))[0]!.scheduled).toBe(true);
    const order = await drain();
    expect(order).toHaveLength(2);
    expect(order[0]).toBe(run.ref);
    expect(order[1]).toBe('RSCH-1');
  });

  it('never dispatches to offline agents, stale workstations, or agents at capacity', async () => {
    await reset();
    const agent = await w.hire('Flaky', 'builder', 'junior', { capacity: 1 });
    await w.card({ title: 'one' });
    await w.card({ title: 'two' });
    await q('UPDATE workstations SET connected=false WHERE id=$1', [w.workstationId]);
    expect(await w.t.app.ctx.services.dispatcher.runPass()).toEqual([]);
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    await q(`UPDATE workstations SET last_seen_at = now() - interval '2 minutes' WHERE id=$1`, [
      w.workstationId,
    ]);
    expect(await w.t.app.ctx.services.dispatcher.runPass()).toEqual([]); // heartbeat stale
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    await q(
      `UPDATE workstations SET runtimes='[{"id":"mock","version":"1","available":false,"capabilities":[]}]' WHERE id=$1`,
      [w.workstationId],
    );
    expect(await w.t.app.ctx.services.dispatcher.runPass()).toEqual([]); // runtime unavailable
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    expect(await drain()).toHaveLength(1); // capacity 1: second card waits
    expect(agent.id).toBeTruthy();
  });

  it('review goes only to senior reviewers other than the builder and earlier approvers', async () => {
    await reset();
    const builder = await w.hire('Bld', 'builder', 'senior', { capacity: 4 });
    const rev1 = await w.hire('Rev One', 'reviewer', 'senior');
    const card = await w.card({ title: 'to review' });
    await q(
      `UPDATE cards SET stage='review', status='queued', original_builder_agent_id=$2, last_agent_id=$2, excluded_agent_ids=ARRAY[$2]::uuid[], risk_tier='large' WHERE id=$1`,
      [card.id, builder.id],
    );
    // a senior builder cannot take a review stage (role), nor can the reviewer if excluded
    await q('UPDATE cards SET excluded_agent_ids = excluded_agent_ids || $2::uuid WHERE id=$1', [
      card.id,
      rev1.id,
    ]);
    expect(await drain()).toEqual([]);
    await q(`UPDATE cards SET excluded_agent_ids = ARRAY[$2]::uuid[] WHERE id=$1`, [card.id, builder.id]);
    // a junior reviewer is never eligible for the senior-only stage
    await q(`UPDATE agents SET seniority='junior' WHERE id=$1`, [rev1.id]);
    expect(await drain()).toEqual([]);
    await q(`UPDATE agents SET seniority='senior' WHERE id=$1`, [rev1.id]);
    expect(await drain()).toEqual(['TOY-1']);
    const claimed = (await q('SELECT claimed_by_agent_id FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(claimed.claimed_by_agent_id).toBe(rev1.id);
  });

  it('does not hand out cards of another organization', async () => {
    await reset();
    const rival = await w.t.userSession(uniqueEmail('rival'));
    const ws = await pairWorkstation(w.t, rival);
    await markOnline(w.t, ws.workstationId, { repoIds: [w.repoId] });
    await ok(
      w.t.req('POST', '/api/agents', {
        cookie: rival.cookie,
        body: {
          name: 'Rival',
          roleKey: 'builder',
          seniority: 'junior',
          workstationId: ws.workstationId,
          runtime: 'mock',
        },
      }),
      201,
    );
    await w.card({ title: 'mine' });
    expect(await drain()).toEqual([]);
  });

  it('only dispatches to a workstation that holds the repo; a card stays pinned to its home workstation', async () => {
    await reset();
    const bare = await pairWorkstation(w.t, w.owner, 'Bare2');
    await markOnline(w.t, bare.workstationId, { repoIds: [] });
    await ok(
      w.t.req('POST', '/api/agents', {
        cookie: w.owner.cookie,
        body: {
          name: 'Bare',
          roleKey: 'builder',
          seniority: 'junior',
          workstationId: bare.workstationId,
          runtime: 'mock',
        },
      }),
      201,
    );
    const card = await w.card({ title: 'needs repo' });
    expect(await drain()).toEqual([]);
    const good = await w.hire('Good', 'builder', 'junior');
    expect(await drain()).toEqual(['TOY-1']);
    // after release the card is pinned to the home workstation
    await q(
      `UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL, claim_workstation_id=NULL, status='queued' WHERE id=$1`,
      [card.id],
    );
    await markOnline(w.t, bare.workstationId, { repoIds: [w.repoId] });
    await q(`UPDATE agents SET capacity=1 WHERE true`);
    await q(`UPDATE agents SET last_shift_ended_at = NULL WHERE name='Bare'`);
    const again = await drain();
    expect(again).toEqual(['TOY-1']);
    expect(
      (await q('SELECT claimed_by_agent_id FROM cards WHERE id=$1', [card.id]))[0]!.claimed_by_agent_id,
    ).toBe(good.id);
  });

  it('starts one overflow shift per organization for a late scheduled card when the agent is at capacity', async () => {
    await reset();
    await w.hire('Solo2', 'builder', 'junior', { capacity: 1 });
    const busyWork = await w.card({ title: 'regular work' });
    expect(await drain()).toEqual(['TOY-1']);
    const late1 = await w.card({ title: 'late scheduled 1' });
    const late2 = await w.card({ title: 'late scheduled 2' });
    await q(
      `UPDATE cards SET scheduled=true, queued_at = now() - interval '2 minutes' WHERE id = ANY($1::uuid[])`,
      [[late1.id, late2.id]],
    );
    const made = await w.t.app.ctx.services.dispatcher.runPass();
    expect(made).toHaveLength(1);
    expect(made[0]!.overflow).toBe(true);
    expect(await refOf(made[0]!.cardId)).toBe('TOY-2');
    // the second late scheduled card waits: one extra shift at a time per org
    expect(await w.t.app.ctx.services.dispatcher.runPass()).toEqual([]);
    expect(busyWork.id).toBeTruthy();
    const flags = await q('SELECT ref, claim_overflow FROM cards WHERE claim_id IS NOT NULL ORDER BY number');
    expect(flags).toEqual([
      { ref: 'TOY-1', claim_overflow: false },
      { ref: 'TOY-2', claim_overflow: true },
    ]);
  });
});
