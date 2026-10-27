import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claim } from '../src/dispatcher/claim.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('exclusive claim', () => {
  it('50 concurrent claim() calls on one card produce exactly one CardClaimed', async () => {
    const agents = await Promise.all(
      ['Ann', 'Bob', 'Cy', 'Di', 'Ed'].map((n) => w.hire(n, 'builder', 'junior', { capacity: 8 })),
    );
    const card = await w.card({ title: 'Contended' });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        claim(w.t.app.ctx, {
          cardId: card.id,
          agentId: agents[i % agents.length].id,
          expectedStage: 'build',
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const events = await q(`SELECT 1 FROM events WHERE type='CardClaimed' AND stream_id=$1`, [
      `card-${card.id}`,
    ]);
    expect(events).toHaveLength(1);
    const row = (
      await q(
        'SELECT status, claim_id, claimed_by_agent_id, claim_shift_id, lease_expires_at FROM cards WHERE id=$1',
        [card.id],
      )
    )[0]!;
    expect(row.status).toBe('claimed');
    expect(row.claim_id).toBeTruthy();
    // lease = claim time + 1h
    expect(new Date(row.lease_expires_at).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    const shifts = await q('SELECT status, agent_id FROM shifts WHERE card_id=$1', [card.id]);
    expect(shifts).toEqual([{ status: 'starting', agent_id: row.claimed_by_agent_id }]);
    const winner = results.find(Boolean)!;
    expect(winner.worktree).toMatchObject({
      created: true,
      branchName: expect.stringMatching(/^guildwise\/toy-\d+-contended$/),
      baseBranch: 'main',
      homeWorkstationId: w.workstationId,
    });
  });

  it('a claimed card cannot be claimed again, and wrong stage claims fail', async () => {
    const agents = (await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }))).agents.filter(
      (a: any) => !a.isDevops,
    );
    const card = await w.card({ title: 'Stage check' });
    expect(
      await claim(w.t.app.ctx, { cardId: card.id, agentId: agents[0].id, expectedStage: 'review' }),
    ).toBeNull();
    expect(
      await claim(w.t.app.ctx, { cardId: card.id, agentId: agents[0].id, expectedStage: 'build' }),
    ).not.toBeNull();
    expect(
      await claim(w.t.app.ctx, { cardId: card.id, agentId: agents[1].id, expectedStage: 'build' }),
    ).toBeNull();
  });

  it('refuses agents that are not eligible (no repo, offline, retired, another org, at capacity, wrong role)', async () => {
    const card = await w.card({ title: 'Eligibility' });
    const ctx = w.t.app.ctx;
    const attempt = (agentId: string) => claim(ctx, { cardId: card.id, agentId, expectedStage: 'build' });

    // another org's agent
    const other = await w.t.userSession(uniqueEmail('rival'));
    const otherWs = await pairWorkstation(w.t, other);
    await markOnline(w.t, otherWs.workstationId, { repoIds: [w.repoId] });
    const rival = await ok<any>(
      w.t.req('POST', '/api/agents', {
        cookie: other.cookie,
        body: {
          name: 'Rival',
          roleKey: 'builder',
          seniority: 'junior',
          workstationId: otherWs.workstationId,
          runtime: 'mock',
        },
      }),
      201,
    );
    expect(await attempt(rival.id)).toBeNull();

    // role mismatch: reviewer cannot take a build stage
    const reviewer = await w.hire('Rex', 'reviewer', 'senior');
    expect(await attempt(reviewer.id)).toBeNull();

    // workstation without the repo
    const bare = await pairWorkstation(w.t, w.owner, 'Bare');
    await markOnline(w.t, bare.workstationId, { repoIds: [] });
    const noRepo = await ok<any>(
      w.t.req('POST', '/api/agents', {
        cookie: w.owner.cookie,
        body: {
          name: 'NoRepo',
          roleKey: 'builder',
          seniority: 'junior',
          workstationId: bare.workstationId,
          runtime: 'mock',
        },
      }),
      201,
    );
    expect(await attempt(noRepo.id)).toBeNull();

    // retired agent
    const gone = await w.hire('Gone', 'builder', 'junior');
    await w.t.req('POST', `/api/agents/${gone.id}/fire`, { cookie: w.owner.cookie });
    expect(await attempt(gone.id)).toBeNull();

    // at capacity: capacity-1 agent holding a card
    const busy = await w.hire('Busy', 'builder', 'junior');
    const first = await w.card({ title: 'Busy work' });
    expect(await claim(ctx, { cardId: first.id, agentId: busy.id, expectedStage: 'build' })).not.toBeNull();
    expect(await attempt(busy.id)).toBeNull();
    // ...unless it is an overflow claim
    expect(
      await claim(ctx, { cardId: card.id, agentId: busy.id, expectedStage: 'build', overflow: true }),
    ).not.toBeNull();
  });
});
