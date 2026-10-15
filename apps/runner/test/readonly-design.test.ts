import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShiftBrief } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

// Backlog #80: the architect designs before the card's dependencies landed. No card branch is made: the shift reads a
// detached checkout of the working branch, which is removed after the shift.

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const REPORT = 'docs/investigations/TOY-1-add-greeting.md';
const investigation = (over: Partial<NonNullable<ShiftBrief['investigation']>> = {}) => ({
  reportPath: REPORT,
  location: 'repo' as const,
  folder: 'docs/investigations',
  investigationOnly: false,
  mergeMainFirst: false,
  readOnly: true,
  unlandedDependencies: [{ ref: 'TOY-0', title: 'Base', status: 'queued' }],
  ...over,
});
const handoff = (data: Record<string, unknown>) => ({
  report: { kind: 'outcome', outcomeId: 'handoff', note: 'done', data },
});
const data = (over: Record<string, unknown> = {}) => ({
  reportPath: REPORT,
  summary: 'Build it in the greeting module.',
  location: 'repo',
  ...over,
});
const ASSUMPTIONS = [{ assumption: 'TOY-0 exports greet()', dependency: 'TOY-0', ifWrong: 'call the API' }];

async function start(script: ConstructorParameters<typeof ScriptedAdapter>[0]) {
  const adapter = new ScriptedAdapter(script);
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
  return adapter;
}
const branches = (repoPath: string) => sh(repoPath, 'git', ['branch', '--list']);

describe('architect shift without a card branch', () => {
  it('works in a read-only checkout of the working branch, creates no branch, and removes the checkout afterwards', async () => {
    const seen: any = {};
    const adapter = await start(async (i, ctl) => {
      seen.cwd = i.cwd;
      seen.readDirs = i.readDirs;
      const checkout = (i.readDirs ?? []).find((d) => existsSync(join(d, '.git')));
      seen.checkout = checkout;
      seen.hasReadme = checkout ? existsSync(join(checkout, 'README.md')) : false;
      seen.headDetached = checkout ? sh(checkout, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']) : undefined;
      writeFileSync(join(i.sandbox.tmp, 'report.md'), '# design\n\nUses greet().\n');
      seen.r = await ctl.post(
        '/v1/report',
        handoff(data({ reportPath: 'report.md', assumptions: ASSUMPTIONS })),
      );
    });
    const { shiftId, ended } = await h!.runShift({
      stage: 'investigate',
      mode: 'readonly',
      briefExtra: { investigation: investigation() },
    });
    expect(ended.outcome).toBe('reported');
    expect(seen.r.status).toBe(200);
    // no worktree reported, no card branch in the clone
    const started = h!.server.of('shift.started').find((m) => m.shiftId === shiftId);
    expect(started?.worktree).toBeUndefined();
    expect(branches(h!.repo.clone)).not.toContain('aom/');
    // the agent read a detached checkout of the working branch, outside its scratch directory
    expect(seen.checkout).toBeTruthy();
    expect(seen.hasReadme).toBe(true);
    expect(seen.headDetached).toBe('HEAD');
    expect(seen.cwd).not.toBe(seen.checkout);
    // the report text travels with the report; the path is the brief's, not the scratch file
    const rep = h!.server.of('shift.report').find((m) => m.shiftId === shiftId);
    expect(rep?.report).toMatchObject({
      kind: 'outcome',
      data: {
        reportPath: REPORT,
        location: 'repo',
        body: '# design\n\nUses greet().\n',
        assumptions: ASSUMPTIONS,
      },
    });
    // the checkout is gone afterwards, and git no longer lists it
    expect(existsSync(seen.checkout)).toBe(false);
    expect(sh(h!.repo.clone, 'git', ['worktree', 'list'])).not.toContain('-design');
    expect(adapter.inputs).toHaveLength(1);
  });

  it('refuses a design without assumptions, then accepts it with --no-assumptions', async () => {
    const seen: any = {};
    await start(async (i, ctl) => {
      writeFileSync(join(i.sandbox.tmp, 'report.md'), '# design\n');
      seen.first = await ctl.post('/v1/report', handoff(data({ reportPath: 'report.md' })));
      seen.second = await ctl.post(
        '/v1/report',
        handoff(data({ reportPath: 'report.md', noAssumptions: 'self-contained' })),
      );
    });
    await h!.runShift({
      stage: 'investigate',
      mode: 'readonly',
      briefExtra: { investigation: investigation() },
    });
    expect(seen.first.status).toBe(422);
    expect(seen.first.json.error).toMatch(/assumptions/);
    expect(seen.second.status).toBe(200);
  });

  it('a report with a secret is refused', async () => {
    const seen: any = {};
    await start(async (i, ctl) => {
      writeFileSync(join(i.sandbox.tmp, 'report.md'), `token = ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}\n`);
      seen.r = await ctl.post(
        '/v1/report',
        handoff(data({ reportPath: 'report.md', assumptions: ASSUMPTIONS })),
      );
      writeFileSync(join(i.sandbox.tmp, 'report.md'), '# fine\n');
      seen.again = await ctl.post(
        '/v1/report',
        handoff(data({ reportPath: 'report.md', assumptions: ASSUMPTIONS })),
      );
    });
    await h!.runShift({
      stage: 'investigate',
      mode: 'readonly',
      briefExtra: { investigation: investigation() },
    });
    expect(seen.r.status).toBe(422);
    expect(seen.r.json.error).toContain('GitHub token');
    expect(seen.again.status).toBe(200);
  });
});

describe('the assumption review', () => {
  it('confirm needs no report: it carries the recorded one and the review', async () => {
    const seen: any = {};
    await start(async (_i, ctl) => {
      seen.r = await ctl.post(
        '/v1/report',
        handoff(
          data({
            reportPath: 'existing',
            review: { decision: 'confirm', revised: [], note: 'checked' },
          }),
        ),
      );
    });
    const { shiftId } = await h!.runShift({
      stage: 'investigate',
      briefExtra: {
        investigation: investigation({
          readOnly: undefined,
          unlandedDependencies: undefined,
          review: { assumptions: ASSUMPTIONS, dependencies: ['TOY-0'] },
          report: { reportPath: REPORT, location: 'repo', summary: 'old', body: '# design\n' },
        }),
      },
    });
    expect(seen.r.status).toBe(200);
    const rep = h!.server.of('shift.report').find((m) => m.shiftId === shiftId);
    expect(rep?.report).toMatchObject({
      data: { reportPath: REPORT, location: 'repo', review: { decision: 'confirm', note: 'checked' } },
    });
  });
});
