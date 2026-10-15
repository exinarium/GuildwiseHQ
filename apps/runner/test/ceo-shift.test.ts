import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const SNAPSHOT = [
  '## Cards needing attention',
  `TOY-7 id=${uuidv7()} why=backoff status=queued stage=build prio=5 rework=0`,
  '',
  '## Open desk items',
  'item=11111111-1111-4111-8111-111111111111 question BLOCKING age=3m your_mode=decide',
  'item=22222222-2222-4222-8222-222222222222 alert age=1h your_mode=decide',
].join('\n');

/** A CEO shift: no worktree, the brief carries a placeholder card and the rendered brief in `ceo`. */
function ceoShift(hh: Harness, purpose: 'wake' | 'review', roleKey = 'ceo') {
  const base = makeShiftStart({ stage: 'finalize', remoteNormalized: hh.repo.remoteNormalized }) as any;
  const role = BUILTIN_ROLES.find((r) => r.key === 'ceo') as (typeof BUILTIN_ROLES)[number];
  base.kind = 'ceo';
  base.worktree = null;
  base.agent = { ...base.agent, roleKey, permissions: role.permissions, name: 'Ada Prime', isDevops: false };
  base.brief.agent.name = 'Ada Prime';
  base.brief.card = {
    ...base.brief.card,
    ref: 'CEO',
    title: purpose === 'review' ? 'Daily review' : 'Management wake',
  };
  base.brief.shift = {
    id: base.shiftId,
    kind: 'ceo',
    stage: 'ceo',
    stageLabel: purpose === 'review' ? 'Daily review' : 'Wake',
    doneCriteria: 'Handled.',
    outcomes:
      purpose === 'review'
        ? [{ id: 'ceo_report', label: 'The daily report', kind: 'success', data: 'ceoReport' }]
        : [{ id: 'ceo_done', label: 'The wake is handled', kind: 'success', data: 'ceoDone' }],
    maxShiftMinutes: 15,
  };
  base.brief.role = {
    key: 'ceo',
    name: role.name,
    instructions: role.instructions,
    coreRules: role.coreRules,
    skills: [],
  };
  base.ceo = {
    purpose,
    batchId: uuidv7(),
    wakeIds: [uuidv7()],
    reasons: [{ reason: 'desk_item', urgency: 'urgent', subject: 'desk:1', at: new Date().toISOString() }],
    brief: '## Why you were woken\n- [urgent] desk_item',
  };
  return base as { shiftId: string; agent: { agentId: string } };
}

async function run(hh: Harness, msg: { shiftId: string }) {
  hh.server.send('shift.start', msg as never);
  return hh.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
}

const reports = (hh: Harness, shiftId: string) =>
  hh.server.of('shift.report').filter((r) => r.shiftId === shiftId);

describe('ceo shifts on the mock runtime', () => {
  it('a wake: no worktree, the CEO instructions, snapshot -> act -> recommend -> done through the real aom verbs', async () => {
    const seen: any[] = [];
    h = await startHarness({
      rpc: (m) => {
        seen.push(m.params);
        const op = (m.params as any).op;
        if (m.method !== 'ceo') return { ok: false, error: 'unexpected' };
        if (op === 'snapshot') return { ok: true, result: { text: SNAPSHOT } };
        return { ok: true, result: { status: 'executed', message: 'ok' } };
      },
    });
    const msg = ceoShift(h, 'wake');
    const ended = await run(h, msg);
    expect(ended.outcome).toBe('reported');
    expect(seen.map((p) => p.op)).toEqual(['snapshot', 'act', 'recommend']);
    expect(seen[1]).toMatchObject({ action: 'release-backoff', params: { card: 'TOY-7' } });
    expect(seen[2]).toMatchObject({ item: '11111111-1111-4111-8111-111111111111', option: 'o1' });
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({ kind: 'outcome', outcomeId: 'ceo_done' });
    expect(existsSync(worktreeOf(h))).toBe(false);
    expect(h.server.of('shift.started').find((m) => m.shiftId === msg.shiftId)?.worktree).toBeUndefined();
    const md = readFileSync(join(h.dataDir, 'agents', msg.agent.agentId, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('chief executive');
    expect(md).toContain('aom ceo act');
    expect(md).toContain('aom ceo done');
    expect(h.server.invalid).toEqual([]);
  }, 60_000);

  it('the daily review ends with the report', async () => {
    h = await startHarness({
      rpc: (m) =>
        (m.params as any).op === 'snapshot'
          ? { ok: true, result: { text: SNAPSHOT } }
          : { ok: true, result: { status: 'executed', message: 'ok' } },
    });
    const msg = ceoShift(h, 'review');
    await run(h, msg);
    const rep = reports(h, msg.shiftId)[0]?.report as any;
    expect(rep).toMatchObject({ kind: 'outcome', outcomeId: 'ceo_report' });
    expect(rep.data.report).toContain('## Needs you');
  }, 60_000);

  it('only the CEO may use aom ceo: any other agent in a ceo shift is refused by the runner', async () => {
    const seen: string[] = [];
    h = await startHarness({
      rpc: (m) => {
        seen.push(m.method);
        return { ok: true, result: { text: SNAPSHOT } };
      },
    });
    const msg = ceoShift(h, 'wake', 'builder');
    await run(h, msg);
    expect(seen).not.toContain('ceo');
    expect(reports(h, msg.shiftId)).toHaveLength(0);
  }, 60_000);

  // Backlog #79: a workstation running its limit of card shifts refused every CEO shift as "busy", silently, so the CEO
  // never ran (production, 2026-10-15). The CEO has a slot of its own, and every rejection says why.
  it('a CEO shift runs even when the workstation is full of card shifts; a second CEO shift is refused with a reason', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = new ScriptedAdapter(async () => {
      await gate;
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    (h.runner as any).maxConcurrent = 1;
    const card = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, ref: 'TOY-1', title: 'one' });
    h.server.send('shift.start', card);
    await h.server.waitFor('shift.started', (m) => m.shiftId === card.shiftId);

    const ceo1 = ceoShift(h, 'wake');
    h.server.send('shift.start', ceo1 as never);
    await h.server.waitFor('shift.started', (m) => m.shiftId === ceo1.shiftId);

    const ceo2 = ceoShift(h, 'wake');
    h.server.send('shift.start', ceo2 as never);
    const refused = await h.server.waitFor('shift.rejected', (m) => m.shiftId === ceo2.shiftId);
    expect(refused.reason).toBe('busy');
    expect(refused.detail).toBe('a CEO shift is already running');

    const card2 = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, ref: 'TOY-2', title: 'two' });
    h.server.send('shift.start', card2);
    const full = await h.server.waitFor('shift.rejected', (m) => m.shiftId === card2.shiftId);
    expect(full.detail).toMatch(/1 shifts already running \(limit 1\)/);
    release();
    await h.server.waitFor('shift.ended', (m) => m.shiftId === ceo1.shiftId);
  }, 60_000);
});
