import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, sh } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const reports = (hh: Harness, shiftId: string) =>
  hh.server.of('shift.report').filter((r) => r.shiftId === shiftId);

describe('mock adapter through the real aom CLI', () => {
  it('default script completes build -> review -> test', async () => {
    h = await startHarness();
    const b = await h.runShift({ stage: 'build' });
    expect(b.ended.outcome).toBe('reported');
    expect(b.ended.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
    const [br] = reports(h, b.shiftId);
    expect(br?.report).toMatchObject({ kind: 'outcome', outcomeId: 'handoff' });
    expect(br?.diffStats).toMatchObject({ files: 2 });
    expect(br?.riskTier).toBe('small');
    const wt = worktreeOf(h);
    expect(existsSync(join(wt, 'aom-mock', 'TOY-1.txt'))).toBe(true);
    expect(sh(wt, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-add-greeting');
    expect(sh(wt, 'git', ['log', '-1', '--format=%an'])).toBe('Ada (aom)');
    const started = h.server.of('shift.started').find((m) => m.shiftId === b.shiftId);
    expect(started?.worktree).toMatchObject({ created: true, baseBranch: 'main', path: wt });

    const r = await h.runShift({ stage: 'review' });
    expect(r.ended.outcome).toBe('reported');
    expect(reports(h, r.shiftId)[0]?.report).toMatchObject({ outcomeId: 'approve', data: { score: 4 } });
    const rs = h.server.of('shift.started').find((m) => m.shiftId === r.shiftId);
    expect(rs?.worktree?.created).toBe(false);

    const t = await h.runShift({ stage: 'test' });
    expect(t.ended.outcome).toBe('reported');
    expect(reports(h, t.shiftId)[0]?.report).toMatchObject({ outcomeId: 'pass' });
    expect(h.server.invalid).toEqual([]);
  }, 120_000);

  it('{"review":["changes","ok"]} bounces once then approves', async () => {
    h = await startHarness();
    const mock = { review: ['changes', 'ok'] };
    await h.runShift({ stage: 'build', mock });
    const first = await h.runShift({ stage: 'review', mock });
    const second = await h.runShift({ stage: 'review', mock });
    expect(reports(h, first.shiftId)[0]?.report).toMatchObject({
      outcomeId: 'changes',
      data: { score: 2, reasons: ['missed_requirement'], criteriaMissed: ['mock criterion'] },
    });
    expect(reports(h, second.shiftId)[0]?.report).toMatchObject({ outcomeId: 'approve' });
  }, 120_000);

  it('crash ends as crashed, no_report as no_report', async () => {
    h = await startHarness();
    const crash = await h.runShift({
      stage: 'build',
      mock: { build: ['crash'] },
      ref: 'TOY-2',
      title: 'Crash',
    });
    expect(crash.ended.outcome).toBe('crashed');
    expect(crash.ended.exitCode).toBe(1);
    const none = await h.runShift({
      stage: 'build',
      mock: { build: ['no_report'] },
      ref: 'TOY-3',
      title: 'Silent',
    });
    expect(none.ended.outcome).toBe('no_report');
    expect(reports(h, none.shiftId)).toHaveLength(0);
    // The mock still committed its work, and nothing was left uncommitted.
    expect(sh(worktreeOf(h, 'TOY', 'TOY-3'), 'git', ['status', '--porcelain'])).toBe('');
  }, 120_000);

  it('hang is stopped at maxShiftMinutes and ends as timeout', async () => {
    h = await startHarness({}, { maxShiftMsOverride: 2500 });
    const { ended } = await h.runShift({
      stage: 'build',
      mock: { build: ['hang'] },
      ref: 'TOY-4',
      title: 'Hang',
    });
    expect(ended.outcome).toBe('timeout');
    expect(ended.durationMs).toBeGreaterThanOrEqual(2400);
  }, 120_000);

  it('edit_outside_scope as reviewer triggers reviewer_modified_code and a rejected report', async () => {
    h = await startHarness();
    await h.runShift({ stage: 'build' });
    const { shiftId, ended } = await h.runShift({
      stage: 'review',
      mock: { review: ['edit_outside_scope'] },
    });
    expect(ended.outcome).toBe('no_report');
    expect(ended.guardViolations.map((v) => v.rule)).toContain('reviewer_modified_code');
    expect(reports(h, shiftId)).toHaveLength(0);
    expect(ended.finalText).toContain('reviewer_modified_code');
  }, 120_000);

  it('records agent progress and the raw stream log', async () => {
    h = await startHarness({}, {});
    const { shiftId } = await h.runShift({ stage: 'build' });
    const progress = h.server.of('shift.progress').filter((p) => p.shiftId === shiftId);
    expect(progress.flatMap((p) => p.items).some((i) => i.text.includes('mock TOY-1 build'))).toBe(true);
    const log = readFileSync(join(h.dataDir, 'logs', 'shifts', `${shiftId}.jsonl`), 'utf8');
    expect(log).toContain('"kind":"usage"');
  }, 60_000);
});

describe('shift fixtures', () => {
  it('keep one project id per key so every shift of a card shares its worktree directory', () => {
    const id = (key?: string) =>
      (
        makeShiftStart({ remoteNormalized: 'x', ...(key ? { projectKey: key } : {}) }) as {
          brief: { project: { id: string } };
        }
      ).brief.project.id;
    expect(id()).toBe(id());
    expect(id('OTH')).not.toBe(id());
  });
});
