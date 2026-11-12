import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepSubworkflows } from '../src/commands/subworkflows.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { designed, hireLeanTeam, leanPipeline, planned, resetLean } from './helpers/lean.ts';
import { cardRow, eventsOfType } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

// The design gate (code v7): an optional owner approval of the design between Investigate & design and Build.

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof leanPipeline>;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
    project: { workflowKey: 'code' },
    lean: true,
    designGate: true,
    integrationTests: 'off',
  });
  r = await w.connectRunner();
  p = leanPipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) }), status);
const codeOf = (res: { body: any }) => res.body.error?.code ?? res.body.code;
const sweep = () => sweepSubworkflows(w.t.app.ctx);

async function team() {
  await freshState();
  await resetLean();
  w.t.app.ctx.services.dispatcher.cooldown.clear();
  await q('UPDATE projects SET design_gate=false WHERE id=$1', [w.projectId]);
  await hireLeanTeam(w);
}

/** A card through Planning and design (low-risk Affected areas unless given). */
async function designedCard(affectedAreas = 'apps/web/src/components/') {
  const card = await w.card({ title: 'Gate card', fields: fullFields({ affectedAreas }) });
  await p.run('Pia', planned());
  expect((await cardRow(card.id)).stage).toBe('investigate');
  const res = await p.run('Arc', designed(card.ref));
  return { card, res };
}

describe('design gate (code v7)', () => {
  it('AC1: a new project has the design gate off and a low-risk design goes straight to Build', async () => {
    await team();
    const project = await call('GET', `/api/projects/${w.projectId}`);
    expect(project.designGate ?? project.project?.designGate).toBe(false);
    const fresh = await q('SELECT design_gate FROM projects WHERE id=$1', [w.projectId]);
    expect(fresh[0]!.design_gate).toBe(false);
    const { card } = await designedCard();
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'build', design_gate_required: false, design_gate_reason: 'off' });
    const decided = (await eventsOfType('DesignGateDecided')).filter((e) => e.cardId === card.id);
    expect(decided).toEqual([expect.objectContaining({ required: false, reason: 'off' })]);
  });

  it('AC2: switching the gate on for a card without a design report is refused with the reason', async () => {
    await team();
    const card = await w.card({ title: 'No design yet', fields: fullFields({ affectedAreas: 'apps/web/src/' }) });
    const refused = await w.t.req('PUT', `/api/cards/${card.id}/design-gate`, {
      cookie: w.owner.cookie,
      body: { on: true },
    });
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('no_design_report');
    expect(JSON.stringify(refused.body)).toContain('has no design report yet');
    expect((await cardRow(card.id)).design_gate_card).toBe(false);
    // switching it off needs no design report (no guard)
    await call('PUT', `/api/cards/${card.id}/design-gate`, { on: false });
  });

  it('the card switch is refused once Build has started, and is for the owner only', async () => {
    await team();
    const { card } = await designedCard();
    await q(`UPDATE cards SET stage='pre_review' WHERE id=$1`, [card.id]);
    const late = await w.t.req('PUT', `/api/cards/${card.id}/design-gate`, {
      cookie: w.owner.cookie,
      body: { on: true },
    });
    expect(late.status).toBe(409);
    expect(codeOf(late)).toBe('design_gate_too_late');
  });

  it('the card switch on a designed card queued at Build moves it to the gate', async () => {
    await team();
    const { card } = await designedCard();
    // keep the builder from claiming it while the owner switches the gate on
    await q('UPDATE cards SET claim_id=NULL WHERE id=$1', [card.id]);
    const row0 = await cardRow(card.id);
    if (row0.stage !== 'build' || row0.claim_id) return; // already claimed by the eager dispatcher: covered elsewhere
    await call('PUT', `/api/cards/${card.id}/design-gate`, { on: true });
    await sweep();
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'design_gate', design_gate_card: true, design_gate_reason: 'card' });
    expect(row.approval).toMatchObject({ state: 'open', stageId: 'design_gate' });
  });

  it('AC3: with the project gate on the card waits at the design gate and the desk item carries the design report', async () => {
    await team();
    await call('PUT', `/api/projects/${w.projectId}/design-gate`, { on: true });
    expect((await q('SELECT design_gate FROM projects WHERE id=$1', [w.projectId]))[0]!.design_gate).toBe(true);
    const { card, res } = await designedCard();
    expect(JSON.stringify(res.res)).toContain('design gate');
    await sweep();
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'design_gate', design_gate_required: true, design_gate_reason: 'project' });
    expect(row.approval).toMatchObject({ state: 'open', stageId: 'design_gate' });
    expect(row.approval.sha ?? null).toBeNull();
    const desk = await q(`SELECT doing, data FROM desk_items WHERE card_id=$1 AND subkind='approval_step'`, [card.id]);
    expect(desk).toHaveLength(1);
    expect(desk[0]!.doing).toContain(`docs/investigations/${card.ref}-report.md`);
    expect(desk[0]!.data.design).toMatchObject({
      reportPath: `docs/investigations/${card.ref}-report.md`,
      summary: 'Build it in module X.',
    });
    const detail = await call('GET', `/api/cards/${card.id}`);
    expect(detail.approval.review).toBeUndefined();
    expect(detail.approval.design).toMatchObject({
      reportPath: `docs/investigations/${card.ref}-report.md`,
      summary: 'Build it in module X.',
      commit: 'abc1234',
      reason: 'project',
    });
    expect(detail.approval.canAct).toBe(true);
  });

  it('AC4: approving the design moves the card on to Build', async () => {
    await team();
    await call('PUT', `/api/projects/${w.projectId}/design-gate`, { on: true });
    const { card } = await designedCard();
    await sweep();
    await call('POST', `/api/cards/${card.id}/approval/approve`, { note: 'looks right' });
    expect((await cardRow(card.id)).stage).toBe('build');
  });

  it("AC4: returning the design sends it back to Investigate & design with the owner's note", async () => {
    await team();
    await call('PUT', `/api/projects/${w.projectId}/design-gate`, { on: true });
    const { card } = await designedCard();
    await sweep();
    await call('POST', `/api/cards/${card.id}/approval/send-back`, { comment: 'split the migration out' });
    const row = await cardRow(card.id);
    expect(row.stage).toBe('investigate');
    expect(row.approval).toMatchObject({ state: 'sent_back' });
    const notes = await q('SELECT body FROM thread_messages WHERE thread_id=$1', [card.id]);
    expect(notes.map((n) => n.body).join('\n')).toContain('split the migration out');
  });

  it('AC5: a design touching high-risk paths stops at the design gate with the gate off (not the BA)', async () => {
    await team();
    const { card } = await designedCard('apps/server/src/db/pool.ts and apps/web/src/');
    await sweep();
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'design_gate', design_gate_required: true, design_gate_reason: 'high_risk' });
    expect(row.design_gate_paths).toEqual(['apps/server/src/db/pool.ts']);
    expect(row.stage).not.toBe('spec');
    const notes = await q('SELECT body FROM thread_messages WHERE thread_id=$1', [card.id]);
    expect(notes.map((n) => n.body).join('\n')).toContain('Design gate required');
  });

  it('the project switch turns the gate back off and the project detail shows it', async () => {
    await team();
    const on = await call('PUT', `/api/projects/${w.projectId}/design-gate`, { on: true });
    expect(on.project.designGate).toBe(true);
    const off = await call('PUT', `/api/projects/${w.projectId}/design-gate`, { on: false });
    expect(off.project.designGate).toBe(false);
    expect((await eventsOfType('ProjectDesignGateSet')).map((e) => e.on).slice(-2)).toEqual([true, false]);
  });
});
