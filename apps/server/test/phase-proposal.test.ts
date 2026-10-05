import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let member: Member;
let start: any;
let intakeId: string;
let target: any;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  member = await addMember(w, 'mgr');
  r = await w.connectRunner();
  await w.hire('Ben', 'ba', 'senior');
  target = await ok<any>(
    w.t.req('POST', `/api/projects/${w.projectId}/deploy-targets`, {
      cookie: w.owner.cookie,
      body: { name: 'local', kind: 'local_docker', appUrl: 'http://localhost:4601' },
    }),
    201,
  );
  const from = r.received.length;
  const res = await ok<any>(
    w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'ABC-1' } }),
    201,
  );
  intakeId = res.intake.id;
  start = await r.waitFor('chat.start', (f: any) => f.threadId === res.intake.threadId, 15_000, from);
  expect((await rpc('intake.map', { project: 'TOY' })).ok).toBe(true);
});
afterAll(async () => {
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner offline');
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const asMember = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: member.cookie, body });

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId: start.chatId, method, params });
  return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
}

const draft = (over: Record<string, unknown> = {}) => ({
  title: 'Draft card',
  cardType: 'feature',
  completionAction: 'merge',
  repo: 'toy',
  fields: {
    context: 'c',
    requirements: 'r',
    acceptanceCriteria: ['a'],
    affectedAreas: 'x',
    constraints: 'y',
    testPlan: 't',
  },
  ...over,
});

const phaseRow = async (ref: string) => (await q('SELECT * FROM phases WHERE ref=$1', [ref]))[0]!;
const openItems = async (sub: string) =>
  q(`SELECT * FROM desk_items WHERE subkind=$1 AND status='open' ORDER BY created_at`, [sub]);
const firstOpen = async (sub: string) => (await openItems(sub))[0]!;
const lastOpen = async (sub: string) => (await openItems(sub)).at(-1)!;

describe('the BA proposes a phase in its intake chat', () => {
  let ref = '';
  let cardRefs: string[] = [];

  it('lists phases and deploy targets, then proposes a phase with the project default follow-ups', async () => {
    await ok(
      owner('PUT', `/api/projects/${w.projectId}/followup-defaults`, {
        followups: [{ kind: 'deploy', targetId: target.id }],
      }),
    );
    const listed = await rpc('phase.list');
    expect(listed.ok).toBe(true);
    expect(listed.result.deployTargets.map((t: any) => t.name)).toEqual(['local']);
    expect(listed.result.defaultFollowups).toHaveLength(1);
    const p = await rpc('phase.propose', { name: 'Autosave', description: 'Save as you type' });
    expect(p.ok).toBe(true);
    expect(p.result).toMatchObject({ ref: 'TOY-P1', status: 'proposed', existing: false });
    ref = p.result.ref;
    const row = await phaseRow(ref);
    expect(row).toMatchObject({ status: 'proposed', created_by_kind: 'agent', intake_id: intakeId });
    expect((await q('SELECT kind FROM phase_followups WHERE phase_id=$1', [row.id]))[0]?.kind).toBe('deploy');
  });

  it('proposing the same name again returns the existing phase, never a duplicate', async () => {
    const again = await rpc('phase.propose', { name: 'autosave' });
    expect(again.result).toMatchObject({ ref, existing: true });
    expect((await q(`SELECT count(*)::int AS n FROM phases WHERE project_id=$1`, [w.projectId]))[0]?.n).toBe(
      1,
    );
  });

  it('follow-ups may name a target by name; an invented target is refused', async () => {
    const bad = await rpc('phase.propose', {
      name: 'Other',
      followups: [{ kind: 'deploy', target: 'prod' }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("unknown deploy target 'prod'");
    const good = await rpc('phase.propose', {
      name: 'Other',
      followups: [
        { kind: 'deploy', target: 'local' },
        { kind: 'regression', platform: 'web' },
      ],
    });
    expect(good.ok).toBe(true);
    const row = await phaseRow(good.result.ref);
    expect(
      (await q('SELECT kind FROM phase_followups WHERE phase_id=$1 ORDER BY position', [row.id])).map(
        (f) => f.kind,
      ),
    ).toEqual(['deploy', 'regression']);
    // discard it again so the rest of the file has one phase
    await q(`UPDATE phases SET status='discarded' WHERE id=$1`, [row.id]);
  });

  it('drafts carry a phase: proposed assignments, and phase.assign puts an existing card in', async () => {
    const a = await rpc('card.create', draft({ title: 'Card A', phase: ref }));
    const b = await rpc('card.create', draft({ title: 'Card B' }));
    expect(a.ok && b.ok).toBe(true);
    cardRefs = [a.result.ref, b.result.ref];
    const row = await phaseRow(ref);
    const members = await q('SELECT ref, phase_assignment FROM cards WHERE phase_id=$1', [row.id]);
    expect(members).toEqual([{ ref: cardRefs[0], phase_assignment: 'proposed' }]);
    const assigned = await rpc('phase.assign', { card: cardRefs[1], phase: ref });
    expect(assigned.ok).toBe(true);
    expect((await q('SELECT count(*)::int AS n FROM cards WHERE phase_id=$1', [row.id]))[0]?.n).toBe(2);
    // a typo is told what to do, nothing is created
    const bad = await rpc('card.create', draft({ title: 'Card C', phase: 'TOY-P9' }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('unknown phase');
    expect((await q(`SELECT 1 FROM cards WHERE title='Card C'`)).length).toBe(0);
  });

  it('submit creates one desk approval; a second submit supersedes it', async () => {
    const s1 = await rpc('phase.submit', { phase: ref });
    expect(s1.ok).toBe(true);
    const items = await openItems('phase_proposal');
    expect(items).toHaveLength(1);
    const first = items[0]!;
    expect(first).toMatchObject({ kind: 'approval', project_id: w.projectId });
    expect(first.title).toContain('Confirm phase TOY-P1: Autosave (2 cards)');
    expect(first.body).toContain('Card A');
    expect(first.body).toContain('Deploy to local');
    const s2 = await rpc('phase.submit', { phase: ref });
    expect(s2.ok).toBe(true);
    const open = await openItems('phase_proposal');
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(s2.result.deskItemId);
    expect((await q('SELECT status, answer FROM desk_items WHERE id=$1', [first.id]))[0]).toMatchObject({
      status: 'dismissed',
      answer: 'superseded by a newer proposal',
    });
  });

  it('the desk item shows the live phase; any member may confirm: only the listed, still proposed cards are confirmed', async () => {
    const item = await firstOpen('phase_proposal');
    const desk = await ok<any>(asMember('GET', '/api/desk'));
    const dto = desk.items.find((i: any) => i.id === item.id);
    expect(dto).toMatchObject({ canAnswer: true, subkind: 'phase_proposal' });
    expect(dto.phase).toMatchObject({ ref, name: 'Autosave', status: 'proposed' });
    expect(dto.phase.members.map((m: any) => m.assignment)).toEqual(['proposed', 'proposed']);
    // a card the BA proposed after the item was created is not part of what the manager confirmed
    const late = await rpc('card.create', draft({ title: 'Card Late', phase: ref }));
    await ok(asMember('POST', `/api/desk/${item.id}/resolve`, { resolution: 'approved' }));
    const row = await phaseRow(ref);
    expect(row.status).toBe('open');
    const members = await q('SELECT ref, phase_assignment FROM cards WHERE phase_id=$1 ORDER BY number', [
      row.id,
    ]);
    expect(members).toEqual([
      { ref: cardRefs[0], phase_assignment: 'confirmed' },
      { ref: cardRefs[1], phase_assignment: 'confirmed' },
      { ref: late.result.ref, phase_assignment: 'proposed' },
    ]);
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [item.id]))[0]?.status).toBe('answered');
  });

  it('adding cards to a confirmed phase needs a new confirmation; rejecting clears them but keeps the phase', async () => {
    const s = await rpc('phase.submit', { phase: ref });
    expect(s.ok).toBe(true);
    const item = await firstOpen('phase_proposal');
    expect(item.title).toContain('Add 1 card to phase TOY-P1');
    await ok(owner('POST', `/api/desk/${item.id}/resolve`, { resolution: 'rejected', note: 'not now' }));
    const row = await phaseRow(ref);
    expect(row.status).toBe('open');
    expect((await q('SELECT count(*)::int AS n FROM cards WHERE phase_id=$1', [row.id]))[0]?.n).toBe(2);
  });

  it('nothing to submit on a confirmed phase is an error', async () => {
    const s = await rpc('phase.submit', { phase: ref });
    expect(s.ok).toBe(false);
    expect(s.error).toContain('no card is waiting');
  });
});

describe('rejecting a new phase', () => {
  it('discards the phase and clears the proposed assignments', async () => {
    const p = await rpc('phase.propose', { name: 'Rejected one', followups: [] });
    const c = await rpc('card.create', draft({ title: 'Doomed', phase: p.result.ref }));
    await rpc('phase.submit', { phase: p.result.ref });
    const item = await lastOpen('phase_proposal');
    await ok(owner('POST', `/api/desk/${item.id}/resolve`, { resolution: 'rejected' }));
    expect((await phaseRow(p.result.ref)).status).toBe('discarded');
    expect((await q('SELECT phase_id FROM cards WHERE ref=$1', [c.result.ref]))[0]?.phase_id).toBeNull();
    // the name is free again
    expect((await rpc('phase.propose', { name: 'Rejected one', followups: [] })).result.existing).toBe(false);
  });

  it('dismissing a proposal counts as rejecting it', async () => {
    const p = await rpc('phase.propose', { name: 'Dismissed one', followups: [] });
    await rpc('card.create', draft({ title: 'Doomed too', phase: p.result.ref }));
    await rpc('phase.submit', { phase: p.result.ref });
    const item = await lastOpen('phase_proposal');
    await ok(owner('POST', `/api/desk/${item.id}/dismiss`, {}));
    expect((await phaseRow(p.result.ref)).status).toBe('discarded');
  });
});

describe('who can use the BA verbs', () => {
  it('only the BA of the conversation: another conversation has no phase verbs', async () => {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId: randomUUID(), method: 'phase.list', params: {} });
    const res = (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 5000, from)) as any;
    expect(res.ok).toBe(false);
  });
});
