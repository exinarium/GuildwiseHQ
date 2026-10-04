import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, responderRole, triagerRole, workflowInput } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, REPO_URL, until, type World } from './helpers/world.ts';

// Custom stages are routed to custom roles by the dispatcher, and a card in flight stays on the workflow version it
// started on when the workflow changes (docs/SPEC.md "Changing a workflow never changes cards already in flight").
let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
let d: ReturnType<typeof designer>;
let projectId: string;
let v1: string;
let v2: string;

const outcome = (id: string, note = id) => ({ kind: 'outcome', outcomeId: id, note, data: {} });
const ticket = async (customer = 'Acme', title = `Ticket ${customer}`) =>
  (
    await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: { projectId, title, cardType: 'support', fields: { customer }, specify: true },
      }),
      201,
    )
  ).card;

beforeAll(async () => {
  w = await createWorld();
  d = designer(w);
  await ok(w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'support' } }), 201);
  await d.publish('roles', triagerRole());
  await d.publish('roles', responderRole());
  v1 = await d.publish('workflows', workflowInput('support'));
  const proj = await ok<any>(
    w.t.req('POST', '/api/projects', {
      cookie: w.owner.cookie,
      body: { key: 'SUP', name: 'Support', workflowKey: 'support' },
    }),
    201,
  );
  projectId = proj.project.id;
  await ok(
    w.t.req('POST', `/api/projects/${projectId}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'toy', remoteUrl: REPO_URL },
    }),
    201,
  );
  r = await w.connectRunner();
  p = pipeline(w, r);
  await w.hire('Tara', 'triager', 'junior');
  await w.hire('Rhea', 'responder', 'senior');
  await w.hire('Bea', 'builder', 'junior');
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('a project whose type is a custom workflow', () => {
  it('shows the workflow as the project type and takes its cards through the custom stages', async () => {
    expect(
      (await ok<any>(w.t.req('GET', '/api/projects', { cookie: w.owner.cookie }))).projects.find(
        (p: any) => p.key === 'SUP',
      ),
    ).toMatchObject({ workflowKey: 'support', department: 'support' });
    const card = await ticket('Acme');
    expect(card).toMatchObject({ stage: 'triage', status: 'queued' });
    expect((await cardRow(card.id)).workflow_version_id).toBe(v1);
    // The dispatcher routes each custom stage to its custom role: the builder never sees these cards.
    const { start } = await p.run('Tara', outcome('triaged'));
    expect(start.brief.shift.stage).toBe('triage');
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['triaged']);
    expect(start.brief.shift.doneCriteria).toBe('The ticket has a category and a priority.');
    expect(start.brief.role.key).toBe('triager');
    expect(start.brief.role.coreRules).toEqual(['Never promise refunds.']);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'resolve', status: 'queued' });
    const second = await p.run('Rhea', outcome('resolved'));
    expect(second.start.brief.shift.stageLabel).toBe('Resolve');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done', status: 'done' });
    const stages = (
      await q(`SELECT to_stage FROM card_transitions WHERE card_id=$1 ORDER BY id`, [card.id])
    ).map((t) => t.to_stage);
    expect(stages).toEqual(expect.arrayContaining(['triage', 'resolve', 'done']));
  });

  it('a failure route sends the card back (rework) and the right role picks it up', async () => {
    const card = await ticket('Globex');
    await p.run('Tara', outcome('triaged'));
    await p.run('Rhea', outcome('escalate', 'needs a closer look'));
    await until(
      async () => (await cardRow(card.id)).rework_round === 1 && (await cardRow(card.id)).stage === 'triage',
    );
    await p.run('Tara', outcome('triaged'));
    await p.run('Rhea', outcome('resolved'));
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done' });
  });

  it('required fields gate entering a stage, and cards need a field the workflow defines', async () => {
    const res = await w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: { projectId, title: 'No customer', cardType: 'support', fields: {}, specify: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.missing ?? res.body.card?.missing).toBeTruthy();
    expect(res.body.card.status).toBe('draft');
    const bad = await w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: { projectId, title: 'Wrong type', cardType: 'refactor', fields: { customer: 'x' } },
    });
    expect(bad.status).toBe(400);
  });
});

describe('workflow pinning', () => {
  it('a card in flight finishes on v1 while new cards start on v2', async () => {
    const inFlight = await ticket('Initech');
    await p.run('Tara', outcome('triaged')); // in flight: now waiting in 'resolve' (v1)
    expect(await cardRow(inFlight.id)).toMatchObject({ stage: 'resolve', workflow_version_id: v1 });

    // v2: triage gains a 'spam' route to done and the resolve stage a new done criterion.
    const wf2 = workflowInput('support') as any;
    wf2.stages[1].outcomes.push({
      id: 'spam',
      label: 'Spam',
      kind: 'success',
      to: 'done',
      event: 'StageCompleted',
    });
    wf2.stages[2].doneCriteria = 'The customer has an answer and a satisfaction survey.';
    const draft = await d.draft('workflows', wf2);
    expect(draft.version).toBe(2);
    v2 = draft.id;
    const sub = await d.submit('workflows', v2);
    // Until approved, nothing changes for anybody.
    expect((await q(`SELECT status FROM workflow_versions WHERE id=$1`, [v1]))[0]!.status).toBe('active');
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
    expect(
      (await q(`SELECT id, status FROM workflow_versions WHERE key='support' ORDER BY version`)).map(
        (x) => x.status,
      ),
    ).toEqual(['superseded', 'active']);
    const cat = (
      await ok<any>(w.t.req('GET', '/api/org/catalogue', { cookie: w.owner.cookie }))
    ).workflows.find((x: any) => x.key === 'support');
    expect(cat.versions.map((v: any) => [v.version, v.status, v.cardsInFlight])).toEqual([
      [2, 'active', 0],
      [1, 'superseded', 2], // the in-flight card and the earlier incomplete draft
    ]);

    // The in-flight card is untouched: same version, same stage, and its shift sees the v1 definition.
    expect(await cardRow(inFlight.id)).toMatchObject({ stage: 'resolve', workflow_version_id: v1 });
    const fresh = await ticket('Hooli');
    expect((await cardRow(fresh.id)).workflow_version_id).toBe(v2);
    const second = await p.run('Rhea', outcome('resolved'));
    expect(second.start.brief.card.ref).toBe(inFlight.ref);
    expect(second.start.brief.shift.doneCriteria).toBe('The customer has an answer.');
    expect(await cardRow(inFlight.id)).toMatchObject({
      stage: 'done',
      status: 'done',
      workflow_version_id: v1,
    });

    // The new card follows v2: it has the new outcome; a v1 card would have refused it.
    const third = await p.next('Tara');
    expect(third.brief.card.ref).toBe(fresh.ref);
    expect(third.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['triaged', 'spam']);
    const h = p;
    await h.startShift(r, third);
    const res = (await h.report(r, third.shiftId, outcome('spam'))) as any;
    expect(res.accepted).toBe(true);
    expect(await cardRow(fresh.id)).toMatchObject({ stage: 'done', workflow_version_id: v2 });
  });

  it('a v1 card cannot report an outcome that only exists in v2', async () => {
    // Re-point: this card is created now (v2), so make a v1 one by pinning the row back to v1 for the check.
    const c = await ticket('Umbrella');
    await q('UPDATE cards SET workflow_version_id=$2 WHERE id=$1', [c.id, v1]);
    const start = await p.next('Tara');
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['triaged']);
    await p.startShift(r, start);
    const res = (await p.report(r, start.shiftId, outcome('spam'))) as any;
    expect(res.accepted).toBe(false);
    expect(res.error ?? res.message).toMatch(/not available on stage 'triage'/);
    r.ended(start.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    );
  });
});
