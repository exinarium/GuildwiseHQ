import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BaTaskShift, BUILTIN_ROLES, baTaskBriefOutcomes, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const PHASE = uuidv7();
const reports = (hh: Harness, shiftId: string) =>
  hh.server.of('shift.report').filter((r) => r.shiftId === shiftId);

const followup = (
  position: number,
  over: Partial<BaTaskShift['followups'][number]>,
): BaTaskShift['followups'][number] => ({
  id: uuidv7(),
  position,
  kind: 'custom',
  target: null,
  platform: null,
  instruction: '',
  note: '',
  status: 'queued',
  delegate: null,
  brief: null,
  resultSummary: null,
  evidence: {},
  ...over,
});

/** A `ba_task` shift: no worktree, the brief carries the phase as its card, the task in `baTask`. */
function taskShift(hh: Harness, kind: BaTaskShift['kind'], over: Partial<BaTaskShift> = {}) {
  const base = makeShiftStart({ stage: 'finalize', remoteNormalized: hh.repo.remoteNormalized }) as any;
  const ba = BUILTIN_ROLES.find((r) => r.key === 'ba') as (typeof BUILTIN_ROLES)[number];
  base.kind = 'ba_task';
  base.worktree = null;
  base.agent = { ...base.agent, roleKey: 'ba', permissions: ba.permissions, name: 'Ben' };
  base.brief.agent.name = 'Ben';
  base.brief.card = { ...base.brief.card, ref: 'TOY-P1', title: 'Autosave' };
  base.brief.shift = {
    id: base.shiftId,
    kind: 'ba_task',
    stage: 'ba_task',
    stageLabel: 'Phase task',
    doneCriteria: 'Report it.',
    outcomes: baTaskBriefOutcomes(kind),
    maxShiftMinutes: 30,
  };
  base.brief.role = {
    key: 'ba',
    name: ba.name,
    instructions: ba.instructions,
    coreRules: ba.coreRules,
    skills: [],
  };
  const task: BaTaskShift = {
    taskId: uuidv7(),
    kind,
    phase: {
      id: PHASE,
      ref: 'TOY-P1',
      name: 'Autosave',
      description: 'Save as you type',
      status: 'reporting',
      projectKey: 'TOY',
      workingBranch: 'main',
    },
    cards: [
      {
        cardId: uuidv7(),
        ref: 'TOY-1',
        title: 'Autosave drafts',
        outcome: 'finalized',
        action: 'merge',
        resultRef: { mergeCommit: 'abcdef1234567' },
      },
      { cardId: uuidv7(), ref: 'TOY-2', title: 'Spike', outcome: 'cancelled', reason: 'dropped' },
    ],
    followups: [
      followup(1, {
        kind: 'deploy',
        target: {
          id: uuidv7(),
          name: 'local',
          kind: 'local_docker',
          host: null,
          appUrl: 'http://localhost:4601',
          notes: '',
        },
        note: '[no_report]',
      }),
      followup(2, { kind: 'regression', platform: 'web' }),
      followup(3, { kind: 'custom', instruction: 'Summarise for the newsletter [ba]' }),
      followup(4, { kind: 'custom', instruction: 'Check the logs' }),
    ],
    outstanding: [{ kind: 'suite_failed', text: 'The full E2E suite TOY-9 after TOY-1 failed' }],
    ...over,
  };
  base.baTask = task;
  return base as { shiftId: string; baTask: BaTaskShift; agent: { agentId: string } };
}

async function run(hh: Harness, msg: { shiftId: string }) {
  hh.server.send('shift.start', msg as never);
  return hh.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
}

describe('ba_task shifts on the mock runtime', () => {
  it('phase_report: reports the cards and the outstanding items; no worktree is made; the BA instructions are the task ones', async () => {
    h = await startHarness();
    const msg = taskShift(h, 'phase_report');
    const ended = await run(h, msg);
    expect(ended.outcome).toBe('reported');
    const rep = reports(h, msg.shiftId)[0]?.report as any;
    expect(rep).toMatchObject({ kind: 'outcome', outcomeId: 'phase_report' });
    expect(rep.data.report).toContain('TOY-1 Autosave drafts: finalized (abcdef1234)');
    expect(rep.data.report).toContain('TOY-2 Spike: cancelled');
    expect(rep.data.outstanding).toEqual(['The full E2E suite TOY-9 after TOY-1 failed']);
    expect(existsSync(worktreeOf(h))).toBe(false);
    expect(h.server.of('shift.started').find((m) => m.shiftId === msg.shiftId)?.worktree).toBeUndefined();
    const md = readFileSync(join(h.dataDir, 'agents', msg.agent.agentId, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('working for the manager in the background on phase TOY-P1');
    expect(md).toContain('aom phase report');
    expect(h.server.invalid).toEqual([]);
  }, 60_000);

  it('followups_brief: briefs every follow-up for the right delegate (the note travels into the brief), then says ready', async () => {
    const briefs: any[] = [];
    h = await startHarness({
      rpc: (m) => {
        if (m.method === 'phase.followup.brief') briefs.push(m.params);
        return { ok: true, result: { message: 'Briefed.' } };
      },
    });
    const msg = taskShift(h, 'followups_brief', {
      phase: {
        id: PHASE,
        ref: 'TOY-P1',
        name: 'Autosave',
        description: '',
        status: 'running_followups',
        projectKey: 'TOY',
        workingBranch: 'main',
      },
    });
    await run(h, msg);
    expect(briefs.map((b) => [b.position, b.to])).toEqual([
      [1, 'devops'],
      [2, 'tester'],
      [3, 'ba'],
      [4, 'devops'],
    ]);
    expect(briefs[0].text).toContain('deploy local http://localhost:4601');
    expect(briefs[0].text).toContain('[no_report]');
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({ kind: 'outcome', outcomeId: 'phase_ready' });
  }, 60_000);

  it('followup_custom: does it, or fails when the instruction says [fail]', async () => {
    h = await startHarness();
    const ok = taskShift(h, 'followup_custom');
    ok.baTask.followupId = ok.baTask.followups[2]?.id as string;
    await run(h, ok);
    expect(reports(h, ok.shiftId)[0]?.report).toMatchObject({
      outcomeId: 'followup_done',
      data: { position: 3, summary: expect.stringContaining('did Summarise') },
    });
    const bad = taskShift(h, 'followup_custom', {
      followups: [followup(1, { kind: 'custom', instruction: 'Do the thing [fail]' })],
    });
    bad.baTask.followupId = bad.baTask.followups[0]?.id as string;
    await run(h, bad);
    expect(reports(h, bad.shiftId)[0]?.report).toMatchObject({
      outcomeId: 'followup_failed',
      data: { position: 1 },
    });
  }, 60_000);

  it('followups_report: one line per follow-up; [ba_no_report] ends the shift without a report', async () => {
    h = await startHarness();
    const res = taskShift(h, 'followups_report', {
      followups: [
        followup(1, { status: 'succeeded', resultSummary: 'deployed abc' }),
        followup(2, { status: 'failed', resultSummary: 'suite failed' }),
      ],
    });
    await run(h, res);
    const rep = reports(h, res.shiftId)[0]?.report as any;
    expect(rep.outcomeId).toBe('phase_results');
    expect(rep.data.report).toContain('1. custom: succeeded - deployed abc');
    expect(rep.data.report).toContain('2. custom: failed - suite failed');

    const silent = taskShift(h, 'phase_report', {
      phase: {
        id: PHASE,
        ref: 'TOY-P1',
        name: 'Autosave',
        description: '[ba_no_report]',
        status: 'reporting',
        projectKey: 'TOY',
        workingBranch: 'main',
      },
    });
    const ended = await run(h, silent);
    expect(ended.outcome).toBe('no_report');
    expect(reports(h, silent.shiftId)).toEqual([]);
  }, 60_000);

  describe('reporter tasks (Part B)', () => {
    /** A reporter task: no phase, the data in `reporter`. */
    function reporterShift(hh: Harness, kind: BaTaskShift['kind'], reporter: Record<string, unknown>) {
      const msg = taskShift(hh, kind);
      const { phase: _phase, ...rest } = msg.baTask;
      (msg as { baTask: unknown }).baTask = {
        ...rest,
        kind,
        cards: [],
        followups: [],
        outstanding: [],
        reporter: { items: [], signals: [], openItems: [], triageWindowMinutes: 10, ...reporter },
      };
      return msg;
    }
    const id = () => uuidv7();

    it('desk_triage: dismisses, merges, passes; the instructions are the reporter ones', async () => {
      h = await startHarness();
      const [a, b, c, open] = [id(), id(), id(), id()];
      const item = (itemId: string, title: string) => ({
        id: itemId,
        kind: 'alert',
        subkind: 'bug_reported',
        title,
        body: '',
        projectKey: 'TOY',
        cardRef: null,
        blocking: false,
        askedBy: 'system',
        createdAt: new Date().toISOString(),
        held: true,
      });
      const msg = reporterShift(h, 'desk_triage', {
        items: [item(a, 'Bug [dismiss] noise'), item(b, 'Bug [merge] same'), item(c, 'Real bug')],
        openItems: [{ id: open, title: 'Existing' }],
      });
      const ended = await run(h, msg);
      expect(ended.outcome).toBe('reported');
      const rep = reports(h, msg.shiftId)[0]?.report as any;
      expect(rep).toMatchObject({ kind: 'outcome', outcomeId: 'triage_done' });
      expect(rep.data.decisions).toEqual([
        expect.objectContaining({ itemId: a, action: 'dismiss' }),
        expect.objectContaining({ itemId: b, action: 'merge', into: open }),
        expect.objectContaining({ itemId: c, action: 'pass' }),
      ]);
      const md = readFileSync(join(h.dataDir, 'agents', msg.agent.agentId, 'claude', 'CLAUDE.md'), 'utf8');
      expect(md).toContain('reporting to the manager in the background');
      expect(md).toContain('aom report triage');
      expect(h.server.invalid).toEqual([]);
    }, 60_000);

    it("urgent_note and floor_alert: a note per item, an analysis per signal (on the signal's own item)", async () => {
      h = await startHarness();
      const [i1, s1, alert] = [id(), id(), id()];
      const notes = reporterShift(h, 'urgent_note', {
        items: [
          {
            id: i1,
            kind: 'approval',
            subkind: 'devops',
            title: 'Approve docker',
            body: '',
            projectKey: 'TOY',
            cardRef: null,
            blocking: true,
            askedBy: 'Atlas',
            createdAt: new Date().toISOString(),
            held: false,
          },
        ],
      });
      await run(h, notes);
      expect(reports(h, notes.shiftId)[0]?.report).toMatchObject({
        outcomeId: 'notes_done',
        data: { notes: [{ itemId: i1, note: expect.stringContaining('Approve docker') }] },
      });
      const sig = reporterShift(h, 'floor_alert', {
        signals: [
          {
            id: s1,
            kind: 'loop',
            urgency: 'urgent',
            fingerprint: 'loop:card:x',
            count: 3,
            status: 'open',
            firstSeenAt: 'a',
            lastSeenAt: 'b',
            subject: { title: 'TOY-1 keeps failing', detail: '3 shifts', deskItemId: alert },
            evidence: {},
          },
        ],
      });
      await run(h, sig);
      expect(reports(h, sig.shiftId)[0]?.report).toMatchObject({
        outcomeId: 'signal_report',
        data: { reports: [{ signalId: s1, annotateItemId: alert }] },
      });
    }, 60_000);

    it('floor_report: the eight sections from the digest (spend included)', async () => {
      h = await startHarness();
      const msg = reporterShift(h, 'floor_report', {
        digest: {
          generatedAt: new Date().toISOString(),
          localDate: '2026-11-10',
          since: null,
          phases: [
            { ref: 'TOY-P1', name: 'Autosave', status: 'open', projectKey: 'TOY', lateBugs: ['TOY-9'] },
          ],
          signals: [],
          backingOff: [{ ref: 'TOY-2', title: 'x', failures: 4, until: 'later' }],
          devopsOpen: [{ id: id(), summary: 'Deploy staging', status: 'needs_approval', workstation: 'WS' }],
          resolvedByBa: [{ id: id(), title: 'Noise', how: 'dismissed', note: null }],
          failures: [],
          interests: {
            count: 2,
            active: 2,
            runs: 3,
            delivered: 2,
            unrated: 1,
            highlights: [
              {
                interest: 'Rust async',
                items: [
                  { title: 'Tokio 2.0', kind: 'article', source: 'tokio.rs', url: 'https://tokio.rs/x' },
                ],
                more: 0,
              },
            ],
            failing: [],
          },
          spend: {
            currency: 'USD',
            sinceMicros: 1_000_000,
            monthMicros: 12_340_000,
            overheadMonthMicros: 0,
            projects: [
              {
                key: 'TOY',
                name: 'Toy',
                monthMicros: 12_340_000,
                budgetMicros: 20_000_000,
                percent: 61,
                state: 'ok',
              },
            ],
          },
        },
      });
      await run(h, msg);
      const rep = reports(h, msg.shiftId)[0]?.report as any;
      const text = rep.data.report as string;
      expect((text.match(/^## /gm) ?? []).length).toBe(8);
      expect(text).toContain('## Spend');
      expect(text).toContain('This month USD 12.34');
      expect(text).toContain('- TOY: 12.34 of 20.00 (ok)');
      expect(text).toContain('## Interests highlights');
      expect(text).toContain('Interests: 2 active of 2, 2 items delivered, 1 unrated');
      expect(text).toContain('Tokio 2.0 (article)');
      expect(text).toContain('TOY-P1 Autosave: open (late bugs TOY-9)');
      expect(text).toContain('TOY-2 backing off after 4 failed shifts');
      expect(text).toContain('Deploy staging: needs_approval');
      expect(text).toContain('Noise (dismissed)');
    }, 60_000);

    it('[ba_no_report] in an item ends the shift without a report', async () => {
      h = await startHarness();
      const msg = reporterShift(h, 'desk_triage', {
        items: [
          {
            id: id(),
            kind: 'alert',
            subkind: null,
            title: 'Slow [ba_no_report]',
            body: '',
            projectKey: null,
            cardRef: null,
            blocking: false,
            askedBy: 'system',
            createdAt: new Date().toISOString(),
            held: true,
          },
        ],
      });
      const ended = await run(h, msg);
      expect(ended.outcome).toBe('no_report');
      expect(reports(h, msg.shiftId)).toEqual([]);
    }, 60_000);
  });
});
