import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner, hireFor, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let owner: FakeRunner;
let m: Member;
let mr: FakeRunner;
let mia: any;
let rex: any;
let memberCardId: string;
let reworkCardId: string;
let claimedShiftId: string;
let handoffNote: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  owner = await w.connectRunner();
  m = await addMember(w, 'leaver');
  mr = await connectMemberRunner(w, m);
});
afterAll(async () => {
  owner.close();
  mr.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
  del: (url: string) => w.t.req('DELETE', url, { cookie }),
});
const agentRow = async (id: string) => (await q('SELECT * FROM agents WHERE id=$1', [id]))[0]!;
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;

async function accept(r: FakeRunner, start: { shiftId: string; worktree: any }) {
  r.accepted(start.shiftId);
  r.started(start.shiftId, {
    path: `/work/${start.shiftId.slice(0, 4)}`,
    branchName: start.worktree?.branchName ?? 'x',
    baseBranch: 'main',
    created: true,
    headSha: 'abc',
  });
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
  );
}
async function report(
  r: FakeRunner,
  shiftId: string,
  rep: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const { reportId } = r.report(shiftId, rep, extra);
  return r.waitFor('shift.report.result', (f) => f.reportId === reportId);
}

describe('removing a manager from a shared project', () => {
  it("setup: the leaver's agent builds, the owner's reviewer bounces it, and the agent holds the card again", async () => {
    mia = await hireFor(w, m, 'Mia', 'builder', 'junior');
    // Later stages run where the worktree lives (card pinning), so the reviewer is on the leaver's workstation too.
    rex = await hireFor(w, m, 'Rex', 'reviewer', 'senior');
    // a card the leaver owns (kept queued behind the claimed one) and a card for the rework round
    const body = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: m.cookie,
        body: {
          projectId: w.projectId,
          title: 'Leaver card',
          cardType: 'feature',
          fields: {
            context: 'c',
            requirements: 'r',
            acceptanceCriteria: ['a'],
            affectedAreas: 'x',
            constraints: 'y',
            testPlan: 't',
          },
          completionAction: 'merge',
          specify: false,
        },
      }),
      201,
    );
    memberCardId = body.card.id;
    const card = await w.card({ title: 'Rework card' });
    reworkCardId = card.id;

    // Mia builds the rework card
    let from = mr.received.length;
    await dispatcher().run();
    const build = await mr.waitFor('shift.start', (f) => f.agent.name === 'Mia', 5000, from);
    expect(build.brief.card.id).toBe(reworkCardId);
    await accept(mr, build);
    await report(
      mr,
      build.shiftId,
      { kind: 'outcome', outcomeId: 'handoff', note: 'first build', data: {} },
      {
        diffStats: { files: 1, added: 3, removed: 0, architecturalPaths: [] },
        riskTier: 'small',
      },
    );
    mr.ended(build.shiftId, 'reported');

    // Rex requests changes
    from = mr.received.length;
    await dispatcher().run();
    const review = await mr.waitFor('shift.start', (f) => f.agent.name === 'Rex', 5000, from);
    await accept(mr, review);
    handoffNote = 'please add a test for the empty case';
    await report(mr, review.shiftId, {
      kind: 'outcome',
      outcomeId: 'changes',
      note: handoffNote,
      data: { score: 2, reasons: ['weak_tests'], criteriaMissed: [] },
    });
    mr.ended(review.shiftId, 'reported');

    // the original builder gets the rework first
    from = mr.received.length;
    await dispatcher().run();
    const rework = await mr.waitFor('shift.start', (f) => f.agent.name === 'Mia', 5000, from);
    expect(rework.brief.card.reworkRound).toBe(1);
    await accept(mr, rework);
    claimedShiftId = rework.shiftId;
    expect((await cardRow(reworkCardId)).claimed_by_agent_id).toBe(mia.id);
  });

  it('previews what the owner inherits', async () => {
    const preview = await as(w.owner.cookie).get(
      `/api/projects/${w.projectId}/members/${m.id}/removal-preview`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.agents).toEqual([
      { id: mia.id, name: 'Mia', roleKey: 'builder', workstationName: 'leaver-box', claimedCardRef: 'TOY-2' },
      { id: rex.id, name: 'Rex', roleKey: 'reviewer', workstationName: 'leaver-box', claimedCardRef: null },
    ]);
    expect(preview.body.releasedCards.map((c: any) => c.ref)).toEqual(['TOY-2']);
    expect(preview.body.transferredCards.map((c: any) => c.title)).toEqual(['Leaver card']);
    // only the owner may preview or remove
    expect(
      (await as(m.cookie).get(`/api/projects/${w.projectId}/members/${m.id}/removal-preview`)).status,
    ).toBe(403);
    expect((await as(m.cookie).del(`/api/projects/${w.projectId}/members/${m.id}`)).status).toBe(403);
  });

  it('removal: agents need a new home, claims are released with the last handoff, cards move to the owner', async () => {
    const res = await as(w.owner.cookie).del(`/api/projects/${w.projectId}/members/${m.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      inheritedAgentIds: [mia.id, rex.id],
      transferredCardIds: [memberCardId],
      releasedCardIds: [reworkCardId],
    });
    expect(res.body.project.members.map((x: any) => x.email)).not.toContain(m.email);

    const a = await agentRow(mia.id);
    expect(a).toMatchObject({
      status: 'needs_rehome',
      manager_user_id: w.owner.id,
      workstation_id: null,
      hired_by_user_id: m.id,
    });
    const released = await cardRow(reworkCardId);
    expect(released).toMatchObject({
      status: 'queued',
      claim_id: null,
      claimed_by_agent_id: null,
      home_workstation_id: null,
    });
    expect((await cardRow(memberCardId)).owner_user_id).toBe(w.owner.id);

    // ClaimReleased(member_removed) carries the last handoff (the reviewer's change request)
    const ev = (
      await q(
        `SELECT payload FROM events WHERE type='ClaimReleased' AND stream_id=$1 ORDER BY seq DESC LIMIT 1`,
        [`card-${reworkCardId}`],
      )
    )[0]!.payload;
    expect(ev.reason).toBe('member_removed');
    const last = (
      await q(
        'SELECT id, note FROM card_handoffs WHERE card_id=$1 ORDER BY created_at DESC, event_seq DESC LIMIT 1',
        [reworkCardId],
      )
    )[0]!;
    expect(ev.lastHandoffId).toBe(last.id);
    expect(last.note).toBe(handoffNote);

    // the removed member's runner is told to stop the shift and wipe the sandbox
    const stop = await mr.waitFor('shift.stop', (f) => f.shiftId === claimedShiftId);
    expect(stop.reason).toBe('agent_retired');
    const wipe = await q(
      `SELECT payload FROM runner_commands WHERE type='agent.wipe' AND workstation_id=$1`,
      [m.workstationId],
    );
    expect(wipe.map((x) => x.payload.agentId).sort()).toEqual([mia.id, rex.id].sort());
    const moved = await q(`SELECT payload FROM events WHERE type='ProjectMemberRemoved'`);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.payload).toMatchObject({ userId: m.id, removedBy: w.owner.id });
  });

  it('the member loses access, and an agent that needs a home is never dispatched', async () => {
    const g = as(m.cookie);
    expect((await g.get('/api/projects')).body.projects).toEqual([]);
    expect((await g.get(`/api/cards/${reworkCardId}`)).status).toBe(404);
    expect((await g.get(`/api/board?projectId=${w.projectId}`)).status).toBe(404);
    expect((await g.get(`/api/projects/${w.projectId}`)).status).toBe(404);
    mr.ended(claimedShiftId, 'stopped');
    const from = mr.received.length;
    await dispatcher().run();
    expect(mr.received.slice(from).filter((f) => f.type === 'shift.start')).toHaveLength(0);
    // the owner sees the agent as needing a home
    const list = (await as(w.owner.cookie).get('/api/agents')).body.agents as any[];
    expect(list.find((x) => x.id === mia.id)).toMatchObject({
      status: 'needs_rehome',
      workstationId: null,
      managerUserId: w.owner.id,
    });
  });

  it("re-homing: only onto the owner's own workstation; name, history and card go on", async () => {
    const owners = as(w.owner.cookie);
    const body = { workstationId: w.workstationId, runtime: 'mock', model: 'mock' };
    // not the member, not someone else's workstation, not an active agent
    expect((await as(m.cookie).post(`/api/agents/${mia.id}/rehome`, body)).status).toBe(404);
    expect(
      (await owners.post(`/api/agents/${mia.id}/rehome`, { ...body, workstationId: m.workstationId })).status,
    ).toBe(404);
    const done = await owners.post(`/api/agents/${mia.id}/rehome`, body);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      id: mia.id,
      name: 'Mia',
      status: 'active',
      workstationId: w.workstationId,
      hiredByUserId: m.id,
      managerUserId: w.owner.id,
      projectId: w.projectId,
    });
    expect((await owners.post(`/api/agents/${mia.id}/rehome`, body)).status).toBe(409);
    const ev = await q(`SELECT type FROM events WHERE stream_id=$1 ORDER BY seq`, [`agent-${mia.id}`]);
    expect(ev.map((e) => e.type)).toEqual(['AgentHired', 'AgentRehomed']);
    // history carries over: her shifts are still hers
    const shifts = await q('SELECT count(*)::int AS n FROM shifts WHERE agent_id=$1', [mia.id]);
    expect(shifts[0]!.n).toBeGreaterThanOrEqual(2);

    // and she is the first to pick up her rework card on the owner's machine
    const from = owner.received.length;
    await dispatcher().run();
    const start = await owner.waitFor('shift.start', (f) => f.agent.name === 'Mia', 5000, from);
    expect(start.brief.card.id).toBe(reworkCardId);
    expect(start.brief.card.reworkRound).toBe(1);
    // the card forgot the departed manager's workstation at removal, so it starts fresh on the owner's machine
    expect(start.worktree?.mode).toBe('create');
  });
});
