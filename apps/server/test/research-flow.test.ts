import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let h: ReturnType<typeof shiftHelpers>;
let projectId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  h = shiftHelpers(w);
  const proj = await ok<any>(
    w.t.req('POST', '/api/projects', {
      cookie: w.owner.cookie,
      body: {
        key: 'SHOOT',
        name: 'Shooting',
        workflowKey: 'research',
        subCategories: ['hunting'],
      },
    }),
    201,
  );
  projectId = proj.project.id;
  await w.hire('Rhea', 'researcher', 'junior');
  await w.hire('Chuck', 'checker', 'junior');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const cite = (n: number) => ({
  url: `https://source.example.test/${n}`,
  title: `Source ${n}`,
  accessedAt: '2026-10-03T08:00:00.000Z',
});
let from = 0;
async function shift(agent: string) {
  const start = await h.dispatchTo(r, agent, from);
  from = r.received.indexOf(start) + 1;
  await h.startShift(r, start);
  return start;
}
const ended = async (shiftId: string) => {
  r.ended(shiftId, 'reported');
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [shiftId, 'ended']))[0],
    3000,
    'shift ended',
  );
};
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0] as any;

async function newResearchCard(extra: Record<string, unknown> = {}) {
  const res = await ok<any>(
    owner('POST', '/api/cards', {
      projectId,
      title: 'Is 6mm ARC enough for deer?',
      cardType: 'research',
      fields: {
        question: 'Is the 6mm ARC enough for deer at 300 yards?',
        scope: 'Factory loads, ethical shot energy',
        depth: 'standard',
        subCategory: 'hunting',
        preferredSites: ['https://example.test'],
        ...extra,
      },
      specify: true,
    }),
    201,
  );
  return res.card;
}

describe('research flow: question -> research -> fact-check -> published note', () => {
  it('a card flows to the researcher, the checker, and ends published with its citations', async () => {
    const c = await newResearchCard();
    expect(c).toMatchObject({ stage: 'research', status: 'queued', cardType: 'research' });

    const rs = await shift('Rhea');
    expect(rs.brief.shift.stage).toBe('research');
    expect(rs.brief.card.fields).toMatchObject({
      question: expect.stringContaining('6mm ARC'),
      depth: 'standard',
    });
    expect(rs.worktree).toBeNull();
    const draft =
      '# Draft\n\n- 6mm ARC delivers about 1500 ft-lb at 300 yards [1]\n\n1. https://source.example.test/1';
    const handoff = await h.report(r, rs.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: draft,
      data: {},
    });
    expect(handoff.accepted).toBe(true);
    await ended(rs.shiftId);
    expect(await cardRow(c.id)).toMatchObject({ stage: 'factcheck', status: 'queued' });

    // the checker sees the researcher's draft and publishes it
    const cs = await shift('Chuck');
    expect(cs.brief.shift.stage).toBe('factcheck');
    expect(cs.brief.handoffs.at(-1)).toMatchObject({ stage: 'research', agentName: 'Rhea', note: draft });
    expect(cs.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['published', 'unsupported']);
    const pub = await h.report(r, cs.shiftId, {
      kind: 'outcome',
      outcomeId: 'published',
      note: 'verified',
      data: {
        vaultPath: 'projects/shoot/hunting/is-6mm-arc-enough-for-deer.md',
        title: 'Is 6mm ARC enough for deer?',
        citations: [cite(1), cite(1), cite(2)],
        excerpt: 'Short answer: yes within limits.',
      },
    });
    expect(pub).toMatchObject({ accepted: true });
    expect(pub.message).toMatch(
      /Published "Is 6mm ARC enough for deer\?" to projects\/shoot\/hunting\/.* with 2 citations/,
    );
    await ended(cs.shiftId);

    expect(await cardRow(c.id)).toMatchObject({ stage: 'done', status: 'done', claim_id: null });
    const events = await q(
      `SELECT type FROM events WHERE payload->>'cardId'=$1 AND type='ResearchPublished'`,
      [c.id],
    );
    expect(events).toHaveLength(1);
    const row = (await q('SELECT * FROM research_publications WHERE card_id=$1', [c.id]))[0] as any;
    expect(row).toMatchObject({
      vault_path: 'projects/shoot/hunting/is-6mm-arc-enough-for-deer.md',
      title: 'Is 6mm ARC enough for deer?',
      excerpt: 'Short answer: yes within limits.',
    });
    expect(row.citations.map((x: any) => x.url)).toEqual([cite(1).url, cite(2).url]);

    const detail = await ok<any>(owner('GET', `/api/cards/${c.ref}`));
    expect(detail.publication).toMatchObject({
      cardRef: c.ref,
      citations: [{ url: cite(1).url }, { url: cite(2).url }],
    });
    const list = await ok<any>(owner('GET', `/api/research/publications?projectId=${projectId}`));
    expect(list.publications).toHaveLength(1);
    const thread = await q('SELECT body FROM thread_messages WHERE thread_id=$1', [c.id]);
    expect(thread.some((m) => /Published/.test(m.body))).toBe(true);
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    expect(
      (await w.t.req('GET', `/api/research/publications?projectId=${projectId}`, { cookie: stranger.cookie }))
        .body.publications,
    ).toEqual([]);
  });

  it("a fact-check failure returns the card to the researcher as rework with the checker's comments", async () => {
    const c = await newResearchCard({ question: 'What is the legal minimum caliber for elk in Montana?' });
    const rs = await shift('Rhea');
    await h.report(r, rs.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'draft with claim A and claim B',
      data: {},
    });
    await ended(rs.shiftId);

    const cs = await shift('Chuck');
    const bad = await h.report(r, cs.shiftId, {
      kind: 'outcome',
      outcomeId: 'unsupported',
      note: 'Claim B is not on the cited page.',
      data: {},
    });
    expect(bad.accepted).toBe(true);
    await ended(cs.shiftId);

    expect(await cardRow(c.id)).toMatchObject({ stage: 'research', status: 'queued', rework_round: 1 });
    expect(await q('SELECT 1 FROM research_publications WHERE card_id=$1', [c.id])).toHaveLength(0);

    const again = await shift('Rhea');
    expect(again.brief.card.reworkRound).toBe(1);
    expect(again.brief.reviewComments[0]).toMatchObject({ comments: 'Claim B is not on the cited page.' });
    expect(again.brief.handoffs.map((x: any) => `${x.stage}:${x.outcome}`)).toEqual([
      'research:handoff',
      'factcheck:unsupported',
    ]);
    await h.report(r, again.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'revised draft without claim B',
      data: {},
    });
    await ended(again.shiftId);
    expect(await cardRow(c.id)).toMatchObject({ stage: 'factcheck', status: 'queued', rework_round: 1 });
    // leave it for the next test's fleet: the checker approves
    const cs2 = await shift('Chuck');
    await h.report(r, cs2.shiftId, {
      kind: 'outcome',
      outcomeId: 'published',
      note: 'ok now',
      data: { vaultPath: 'projects/shoot/hunting/elk.md', title: 'Elk', citations: [cite(3)] },
    });
    await ended(cs2.shiftId);
    expect((await cardRow(c.id)).status).toBe('done');
  });

  it('refuses a publication without citations, outside the project vault folder, or sent as a raw note', async () => {
    const c = await newResearchCard({ question: 'Uncited?' });
    const rs = await shift('Rhea');
    await h.report(r, rs.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'draft', data: {} });
    await ended(rs.shiftId);
    const cs = await shift('Chuck');
    const publish = (data: Record<string, unknown>) =>
      h.report(r, cs.shiftId, { kind: 'outcome', outcomeId: 'published', note: 'n', data });

    const none = await publish({ vaultPath: 'projects/shoot/hunting/x.md', title: 'X', citations: [] });
    expect(none).toMatchObject({ accepted: false });
    expect(none.error).toMatch(/at least one citation/);
    const outside = await publish({ vaultPath: 'projects/other/x.md', title: 'X', citations: [cite(1)] });
    expect(outside.error).toMatch(/under projects\/shoot\//);
    const traversal = await publish({
      vaultPath: 'projects/shoot/../../x.md',
      title: 'X',
      citations: [cite(1)],
    });
    expect(traversal.accepted).toBe(false);
    const raw = await publish({ content: '# raw note', citations: [] });
    expect(raw.error).toMatch(/aom publish/);
    expect((await cardRow(c.id)).stage).toBe('factcheck');
    // the same shift can still do it properly
    const okRes = await publish({
      vaultPath: 'projects/shoot/hunting/x.md',
      title: 'X',
      citations: [cite(1)],
    });
    expect(okRes.accepted).toBe(true);
    await ended(cs.shiftId);
  });

  it('open questions from the researcher go to the desk like any card and unblock it when answered', async () => {
    const c = await newResearchCard({ question: 'Which state?' });
    const rs = await shift('Rhea');
    const asked = await h.report(r, rs.shiftId, {
      kind: 'question',
      text: 'Which state laws should the note cover?',
      options: ['Montana', 'Texas'],
      recommend: 0,
      doing: 'scoping the research',
      blocking: true,
    });
    expect(asked.accepted).toBe(true);
    await ended(rs.shiftId);
    expect(await cardRow(c.id)).toMatchObject({ status: 'blocked', stage: 'research' });
    const desk = await ok<any>(owner('GET', '/api/desk'));
    const item = desk.items.find((i: any) => i.card?.ref === c.ref);
    expect(item).toMatchObject({
      kind: 'question',
      blocking: true,
      askedBy: { agentName: 'Rhea', role: 'researcher' },
    });
    await ok(owner('POST', `/api/desk/${item.id}/answer`, { answer: 'Montana', optionId: 'o1' }));
    expect(await cardRow(c.id)).toMatchObject({ status: 'queued', stage: 'research' });
    const next = await shift('Rhea');
    expect(next.brief.ledger.map((l: any) => l.body).join(' ')).toContain('Montana');
  });

  it('rebuilds the publications identically from the event log', async () => {
    const snap = async () => ({
      pubs: await q(
        'SELECT id, card_id, vault_path, title, citations, excerpt FROM research_publications ORDER BY event_seq',
      ),
      cards: await q(
        `SELECT ref, stage, status, rework_round FROM cards WHERE project_id=$1 ORDER BY number`,
        [projectId],
      ),
    });
    const before = await snap();
    expect(before.pubs.length).toBeGreaterThanOrEqual(3);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});
