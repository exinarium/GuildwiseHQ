import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, appoint, blockingQuestion, ceo, ledgerEntry, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let shiftId: string;
let signalId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Ben', 'ba', 'senior');
  await w.hire('Bea', 'builder', 'junior');
  await appoint(w);
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
  signalId = randomUUID();
  await q(
    `INSERT INTO ba_signals (id, org_id, project_id, kind, fingerprint, urgency, subject, count, status, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,'unclaimed','fp-1','normal','{"title":"Builder queue is long"}',3,'open',now(),now())`,
    [signalId, w.owner.id, w.projectId],
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const declineOpen = async () => {
  for (const row of await q(`SELECT id FROM desk_items WHERE subkind='ceo_recommendation' AND status='open'`))
    await ok(owner('POST', `/api/desk/${row.id}/resolve`, { resolution: 'rejected' }));
};
const result = (resp: any) => {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  return resp.result;
};
const status = () => ok<any>(owner('GET', '/api/ceo/status'));
const hireParams = (over: Record<string, unknown> = {}) => ({
  role: 'builder',
  seniority: 'junior',
  workstation: 'Desk',
  projects: 'TOY',
  ...over,
});
const reviewer = (over: Record<string, unknown> = {}) =>
  hireParams({ role: 'reviewer', seniority: 'senior', ...over });

describe('the training period', () => {
  it('forces staffing and model changes to recommendations, whatever the policy table says', async () => {
    expect((await status()).training).toMatchObject({ on: true, daysLeft: 14 });
    // the table says decide for hiring: training wins
    expect((await ok<any>(owner('GET', '/api/ceo/policy'))).policy.classes['agent.hire'].mode).toBe('decide');
    const hire = result(await act(r, shiftId, 'hire', hireParams(), { evidence: [`signal:${signalId}`] }));
    expect(hire.status).toBe('recommended');
    expect(hire.message).toContain('training period');
    expect(await q(`SELECT 1 FROM agents WHERE role_key='builder' AND name <> 'Bea'`)).toHaveLength(0);
    const bea = result(await act(r, shiftId, 'model', { agent: 'Bea', to: 'opus' }));
    expect(bea.status).toBe('recommended');
    expect(result(await act(r, shiftId, 'bench', { agent: 'Bea' })).status).toBe('recommended');
    expect(result(await act(r, shiftId, 'seniority', { agent: 'Bea', to: 'senior' })).status).toBe(
      'recommended',
    );
    expect(
      result(
        await act(
          r,
          shiftId,
          'scale',
          { role: 'builder', project: 'TOY', to: 2 },
          { evidence: [`signal:${signalId}`] },
        ),
      ).status,
    ).toBe('recommended');
    // operational actions are not staffing: they still run
    const card = await w.card({ title: 'During training' });
    expect(result(await act(r, shiftId, 'priority', { card: card.ref, to: 2 })).status).toBe('executed');
    expect(result(await act(r, shiftId, 'pause-agent', { agent: 'Bea' })).status).toBe('executed');
    result(await act(r, shiftId, 'resume-agent', { agent: 'Bea' }));
    const rows = await q(
      `SELECT class, cause FROM ceo_actions WHERE mode='recommended' AND cause='training'`,
    );
    expect(rows.map((x) => x.class).sort()).toEqual([
      'agent.bench',
      'agent.change_model',
      'agent.change_seniority',
      'agent.hire',
      'agent.scale',
    ]);
  });

  it('the recommendation is a desk item the owner can accept: it runs, and the response is recorded as agreement', async () => {
    const rec = (await q(`SELECT * FROM ceo_actions WHERE class='agent.hire' AND mode='recommended'`))[0]!;
    const itemId = rec.desk_item_id;
    const desk = await ok<any>(owner('GET', '/api/desk'));
    const item = desk.items.find((i: any) => i.id === itemId);
    expect(item.title).toContain('recommends');
    expect(item.subkind).toBe('ceo_recommendation');
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
    const hired = await q(`SELECT * FROM agents WHERE role_key='builder' AND name <> 'Bea'`);
    expect(hired).toHaveLength(1);
    const taken = (await q(`SELECT * FROM ceo_actions WHERE accepted_from=$1`, [rec.id]))[0]!;
    expect(taken).toMatchObject({ mode: 'decided', class: 'agent.hire' });
    expect((await q(`SELECT response FROM ceo_actions WHERE id=$1`, [rec.id]))[0]!.response).toBe('accepted');
    // the hired agent is the CEO's: undo retires it again (it never worked)
    const s = await status();
    expect(s.scores.find((x: any) => x.class === 'agent.hire')).toEqual({
      class: 'agent.hire',
      agreed: 1,
      total: 1,
    });
    await ok(owner('POST', `/api/ceo/actions/${taken.id}/undo`));
    expect((await q(`SELECT status FROM agents WHERE id=$1`, [hired[0]!.id]))[0]!.status).toBe('retired');
  });

  it('a declined recommendation is a disagreement and becomes a pattern candidate the owner can review', async () => {
    const rec = (
      await q(`SELECT * FROM ceo_actions WHERE class='agent.change_model' AND mode='recommended'`)
    )[0]!;
    await ok(
      owner('POST', `/api/desk/${rec.desk_item_id}/resolve`, {
        resolution: 'rejected',
        note: 'Bea is fine on sonnet',
      }),
    );
    expect(
      (await q(`SELECT response, response_note FROM ceo_actions WHERE id=$1`, [rec.id]))[0],
    ).toMatchObject({ response: 'rejected', response_note: 'Bea is fine on sonnet' });
    const s = await status();
    expect(s.totals).toEqual({ agreed: 1, total: 2 });
    const mem = await ok<any>(owner('GET', '/api/ceo/memories'));
    const cand = mem.memories.find((m: any) => m.status === 'candidate');
    expect(cand).toBeDefined();
    expect(cand.text).toContain('declined');
    expect(cand.source).toBe('owner_training');
    expect(
      await q(`SELECT 1 FROM agents WHERE id=$1 AND model='mock'`, [
        (await q(`SELECT id FROM agents WHERE name='Bea'`))[0]!.id,
      ]),
    ).toHaveLength(1);
  });

  it('answering a desk question differently from the recommendation is recorded as "different"', async () => {
    const { id } = await blockingQuestion(w, { title: 'Which cache?', options: ['Redis', 'In memory'] });
    const rec = result(
      await ceo(r, shiftId, {
        op: 'recommend',
        item: id,
        option: 'o1',
        reason: 'we already run Redis',
        confidence: 0.7,
        evidence: [],
      }),
    );
    expect(rec.status).toBe('recommended');
    const dto = (await ok<any>(owner('GET', '/api/desk'))).items.find((i: any) => i.id === id);
    expect(dto.ceo.recommendation).toMatchObject({ option: 'o1', reason: 'we already run Redis' });
    await ok(
      owner('POST', `/api/desk/${id}/answer`, { answer: 'In memory', optionId: 'o2', remember: true }),
    );
    const a = (await q(`SELECT response, response_choice FROM ceo_actions WHERE id=$1`, [rec.actionId]))[0]!;
    expect(a).toMatchObject({ response: 'different', response_choice: 'In memory' });
    // "remember this" kept the owner's own answer as a rule, with the quote
    const mem = (await ok<any>(owner('GET', '/api/ceo/memories'))).memories;
    expect(
      mem.some(
        (m: any) => m.kind === 'rule' && m.source === 'owner_desk_answer' && m.text.includes('In memory'),
      ),
    ).toBe(true);
    // and agreeing counts as agreement
    const { id: id2 } = await blockingQuestion(w, { title: 'Which queue?', options: ['SQS', 'Rabbit'] });
    const rec2 = result(
      await ceo(r, shiftId, {
        op: 'recommend',
        item: id2,
        option: 'o2',
        reason: 'self hosted',
        confidence: 0.8,
        evidence: [],
      }),
    );
    await ok(owner('POST', `/api/desk/${id2}/answer`, { answer: 'Rabbit', optionId: 'o2' }));
    expect((await q(`SELECT response FROM ceo_actions WHERE id=$1`, [rec2.actionId]))[0]!.response).toBe(
      'accepted',
    );
  });

  it('the daily review brief carries the training facts', async () => {
    const { buildCeoBrief } = await import('../src/ceo/brief.ts');
    const { loadCeo } = await import('../src/ceo/state.ts');
    const ceoState = (await loadCeo(w.t.app.ctx.pool, w.owner.id))!;
    const agent = (await q(`SELECT * FROM agents WHERE role_key='ceo'`))[0]!;
    const b = await buildCeoBrief(w.t.app.ctx, ceoState, agent, [], 'review', '2026-10-14');
    expect(b.text).toContain('Training facts');
    expect(b.text).toMatch(/Agreement so far: \d+ of \d+/);
    expect(b.text).toContain('TRAINING: you are in your training period');
  });
});

describe('graduating', () => {
  it('shows the scores, ends training and unlocks the policy table within the guard rails', async () => {
    // the owner declines whatever the CEO still recommends
    for (const row of await q(
      `SELECT desk_item_id FROM ceo_actions WHERE mode='recommended' AND response IS NULL AND desk_item_id IN (SELECT id FROM desk_items WHERE subkind='ceo_recommendation' AND status='open')`,
    ))
      await ok(owner('POST', `/api/desk/${row.desk_item_id}/resolve`, { resolution: 'rejected' }));
    const t = await ok<any>(owner('POST', '/api/ceo/training', { action: 'graduate' }));
    expect(t.training).toMatchObject({ on: false });
    expect(t.training.graduatedAt).not.toBeNull();
    expect((await status()).training.on).toBe(false);
    // no evidence: refused
    const noEv = result(await act(r, shiftId, 'hire', reviewer(), { key: 'no-evidence' }));
    expect(noEv.status).toBe('refused');
    expect(noEv.message).toContain('evidence');
    // with a cited signal: decided
    const first = result(
      await act(r, shiftId, 'hire', reviewer({ name: 'Cleo' }), { evidence: [`signal:${signalId}`] }),
    );
    expect(first, JSON.stringify(first)).toMatchObject({ status: 'executed' });
    expect(first.message).toContain('Cleo');
    const cleo = (await q(`SELECT * FROM agents WHERE name='Cleo'`))[0]!;
    expect(cleo).toMatchObject({ role_key: 'reviewer', seniority: 'senior' });
    expect(cleo.allowed_project_ids).toEqual([w.projectId]);
    // the model may not be above the role default
    const dear = result(
      await act(r, shiftId, 'hire', hireParams({ name: 'Dora', model: 'opus' }), {
        evidence: [`signal:${signalId}`],
      }),
    );
    expect(dear.status).toBe('refused');
  });

  it('caps hires per day and agents per role per project, and holds a hire back when the forecast would pass the budget', async () => {
    const second = result(
      await act(r, shiftId, 'hire', reviewer({ name: 'Dan' }), { evidence: [`signal:${signalId}`] }),
    );
    expect(second, JSON.stringify(second)).toMatchObject({ status: 'executed' });
    const third = result(
      await act(r, shiftId, 'hire', reviewer({ name: 'Eve' }), { evidence: [`signal:${signalId}`] }),
    );
    expect(third.status).toBe('recommended');
    expect(third.message).toContain('limit reached');
    // raise the day limit: now the per-project cap (2 reviewers: Cleo, Dan) holds
    const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
    pol.limits.maxHiresPerDay = 10;
    pol.limits.maxAgentsPerRolePerProject = 2;
    await ok(owner('PUT', '/api/ceo/policy', { policy: pol }));
    await declineOpen();
    const capped = result(
      await act(r, shiftId, 'hire', reviewer({ name: 'Fay' }), { evidence: [`signal:${signalId}`] }),
    );
    expect(capped.status).toBe('recommended');
    expect(capped.message).toMatch(/reviewer agents per project/);
    // room again, then the budget guard: spent a lot, tiny budget
    pol.limits.maxAgentsPerRolePerProject = 5;
    await ok(owner('PUT', '/api/ceo/policy', { policy: pol }));
    await ok(owner('PUT', `/api/projects/${w.projectId}/budget`, { monthly: 1 }));
    await q(
      `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd_micros, ended_at, cost_stamped)
       VALUES (gen_random_uuid(), $1, (SELECT id FROM agents WHERE name='Bea'), $2, 'card', 'mock', 1,1,0,0, 900000, now(), true)`,
      [w.owner.id, w.projectId],
    );
    await declineOpen();
    const broke = result(
      await act(r, shiftId, 'hire', reviewer({ name: 'Gil' }), { evidence: [`signal:${signalId}`] }),
    );
    expect(broke.status).toBe('recommended');
    expect(broke.message).toContain('budget');
  });

  it('training can be restarted: the staffing gate is back', async () => {
    const t = await ok<any>(owner('POST', '/api/ceo/training', { action: 'restart' }));
    expect(t.training.on).toBe(true);
    const res = result(await act(r, shiftId, 'bench', { agent: 'Bea' }, { key: 'bench-again' }));
    expect(res.status).toBe('recommended');
    expect(res.message).toContain('training');
    const ext = await ok<any>(owner('POST', '/api/ceo/training', { action: 'extend' }));
    expect(ext.training.extensions).toBeGreaterThan(0);
  });
});

describe('only the Owner trains the CEO', () => {
  it('an Admin cannot graduate it or accept a recommendation', async () => {
    const admin = await w.t.userSession(`admin-${Date.now()}@example.test`);
    await q(
      `INSERT INTO org_members (org_id, user_id, role, status, joined_at) VALUES ($1,$2,'admin','active',now())`,
      [w.owner.id, admin.id],
    );
    const h = { 'x-aom-org': w.owner.id };
    expect(
      (
        await w.t.req('POST', '/api/ceo/training', {
          cookie: admin.cookie,
          headers: h,
          body: { action: 'graduate' },
        })
      ).status,
    ).toBe(403);
    const rec = (
      await q(
        `SELECT desk_item_id FROM ceo_actions WHERE mode='recommended' AND response IS NULL AND desk_item_id IS NOT NULL LIMIT 1`,
      )
    )[0];
    if (rec)
      expect(
        (
          await w.t.req('POST', `/api/desk/${rec.desk_item_id}/resolve`, {
            cookie: admin.cookie,
            headers: h,
            body: { resolution: 'approved' },
          })
        ).status,
      ).toBe(403);
    // Admins see the log and the status, never the memory text
    expect((await w.t.req('GET', '/api/ceo/actions', { cookie: admin.cookie, headers: h })).status).toBe(200);
    const mem = await w.t.req('GET', '/api/ceo/memories', { cookie: admin.cookie, headers: h });
    expect(mem.body.canView).toBe(false);
    expect(mem.body.memories.every((m: any) => m.text === '')).toBe(true);
  });
});

void ledgerEntry;
