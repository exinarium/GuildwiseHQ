import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BaTaskShift, BUILTIN_ROLES, baTaskBriefOutcomes, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalAdapters } from '../src/external/index.ts';
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

    it('scheduled_brief (the CEO-BA review): one report; the instructions are the review ones, not the retired reporter ones', async () => {
      h = await startHarness();
      const msg = reporterShift(h, 'scheduled_brief', {
        brief: {
          scheduleName: 'CEO decision review',
          instructions: 'Analyse the correction.',
          deliver: 'desk_notice',
          projectKey: 'TOY',
        },
      });
      const ended = await run(h, msg);
      expect(ended.outcome).toBe('reported');
      const rep = reports(h, msg.shiftId)[0]?.report as any;
      expect(rep).toMatchObject({ kind: 'outcome', outcomeId: 'scheduled_brief' });
      expect(rep.data.report).toContain('Analyse the correction.');
      const md = readFileSync(join(h.dataDir, 'agents', msg.agent.agentId, 'claude', 'CLAUDE.md'), 'utf8');
      expect(md).toContain('The CEO asks you for an analysis');
      expect(md).not.toContain('aom report triage');
      expect(h.server.invalid).toEqual([]);
    }, 60_000);

    it('[ba_no_report] in the instructions ends the shift without a report', async () => {
      h = await startHarness();
      const msg = reporterShift(h, 'scheduled_brief', {
        brief: { scheduleName: 'Review', instructions: 'Slow [ba_no_report]', deliver: 'desk_notice' },
      });
      const ended = await run(h, msg);
      expect(ended.outcome).toBe('no_report');
      expect(reports(h, msg.shiftId)).toEqual([]);
    }, 60_000);
  });
});

describe('batch_intake shifts (#63)', () => {
  const batchShift = (
    hh: Harness,
    note?: string,
    answers: Array<{ question: string; answer: string | null }> = [],
  ) =>
    taskShift(hh, 'batch_intake', {
      phase: undefined as never,
      cards: [],
      followups: [],
      outstanding: [],
      batch: {
        batchId: uuidv7(),
        itemId: uuidv7(),
        system: 'jira',
        ticketKey: 'ABC-7',
        ...(note ? { note } : {}),
        projects: [{ key: 'TOY', name: 'Toy', repos: ['toy'] }],
        cards: [],
        answers,
      },
    });

  it('reads the ticket through the runner, creates the card with the intake verbs and reports done', async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const external = new ExternalAdapters([
      {
        system: 'jira',
        readSource: async (ref) => ({ ref, title: 'Dark mode', body: 'Please', labels: [], comments: [] }),
        postApproved: async () => ({}),
      },
    ]);
    h = await startHarness(
      {
        rpc: (m) => {
          calls.push({ method: m.method, params: m.params });
          return { ok: true, result: m.method === 'card.create' ? { ref: 'TOY-9', missing: [] } : {} };
        },
      },
      { external },
    );
    const msg = batchShift(h);
    const ended = await run(h, msg);
    expect(ended.outcome).toBe('reported');
    expect(calls.map((c) => c.method)).toEqual(['intake.map', 'card.create', 'card.specify']);
    expect(calls[0]?.params).toEqual({ project: 'TOY' });
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({
      kind: 'outcome',
      outcomeId: 'batch_done',
      note: 'Created TOY-9 from ABC-7: Dark mode',
    });
    const md = readFileSync(join(h.dataDir, 'agents', msg.agent.agentId, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('one ticket of a batch intake');
    expect(md).toContain('aom batch ask');
    expect(existsSync(worktreeOf(h))).toBe(false);
  }, 60_000);

  it('asks one question when it cannot go on, and carries on once it has an answer', async () => {
    h = await startHarness({
      rpc: (m) => ({ ok: true, result: m.method === 'card.create' ? { ref: 'TOY-9', missing: [] } : {} }),
    });
    const asked = batchShift(h, 'please [ask]');
    await run(h, asked);
    expect(reports(h, asked.shiftId)[0]?.report).toMatchObject({
      kind: 'outcome',
      outcomeId: 'batch_ask',
      data: { question: 'Which project does this belong to?', options: ['first', 'second'] },
    });
    const answered = batchShift(h, 'please [ask]', [
      { question: 'Which project does this belong to?', answer: 'first' },
    ]);
    await run(h, answered);
    expect(reports(h, answered.shiftId)[0]?.report).toMatchObject({ outcomeId: 'batch_done' });
  }, 60_000);

  it('can fail a ticket', async () => {
    h = await startHarness();
    const msg = batchShift(h, '[fail]');
    await run(h, msg);
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({ outcomeId: 'batch_fail' });
  }, 60_000);
});

describe('mail_reply_draft shifts (#67 D)', () => {
  const draftShift = (hh: Harness, text = 'Where is my invoice for September?') =>
    taskShift(hh, 'mail_reply_draft', {
      phase: undefined as never,
      cards: [],
      followups: [],
      outstanding: [],
      mailDraft: {
        draftId: uuidv7(),
        orgName: 'Acme Ltd',
        senderName: 'Pat Jones',
        to: 'ana@customer.test',
        subject: 'Invoice',
        messages: [
          { direction: 'in', from: 'ana@customer.test', fromName: 'Ana', at: '2026-10-14T08:00:00Z', text },
        ],
      },
    });

  it('writes the draft to a file and reports it; the instructions say to write as the organisation and never reveal', async () => {
    h = await startHarness();
    const msg = draftShift(h);
    const ended = await run(h, msg);
    expect(ended.outcome).toBe('reported');
    const rep = reports(h, msg.shiftId)[0]?.report as any;
    expect(rep).toMatchObject({ kind: 'outcome', outcomeId: 'mail_draft_done' });
    expect(rep.data.text).toContain('Where is my invoice for September?');
    expect(rep.data.text).toContain('Pat');
    const md = readFileSync(join(h.dataDir, 'agents', msg.agent.agentId, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain("Write as Acme Ltd's own person");
    expect(md).toContain('Never mention agents, AI');
    expect(md).toContain('aom report mail-draft --text-file');
    expect(md).toContain('aom report mail-draft-fail');
    expect(existsSync(worktreeOf(h))).toBe(false);
    expect(h.server.invalid).toEqual([]);
  }, 60_000);

  it('can report that no reply can be written', async () => {
    h = await startHarness();
    const msg = draftShift(h, 'nothing here [draft_fail]');
    await run(h, msg);
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({ outcomeId: 'mail_draft_fail' });
  }, 60_000);
});

describe('spec_card shifts (docs/design/ceo-front-door.md 2.4)', () => {
  const specShift = (hh: Harness, title = 'Password reset is blank') =>
    taskShift(hh, 'spec_card', {
      phase: undefined as never,
      cards: [],
      followups: [],
      outstanding: [],
      specCard: {
        cardId: uuidv7(),
        ref: 'TOY-7',
        title,
        cardType: 'bug',
        projectKey: 'TOY',
        fields: { context: 'The link opens a blank page.' },
        missing: ['requirements', 'acceptanceCriteria'],
        listFields: ['acceptanceCriteria'],
      },
    });

  it('writes the missing fields (a list as an array) and reports them; the prompt names the fields and fences the card text', async () => {
    h = await startHarness();
    const msg = specShift(h);
    const ended = await run(h, msg);
    expect(ended.outcome).toBe('reported');
    const rep = reports(h, msg.shiftId)[0]?.report as any;
    expect(rep).toMatchObject({ kind: 'outcome', outcomeId: 'spec_card_done' });
    expect(Object.keys(rep.data.fields).sort()).toEqual(['acceptanceCriteria', 'requirements']);
    expect(Array.isArray(rep.data.fields.acceptanceCriteria)).toBe(true);
    expect(typeof rep.data.fields.requirements).toBe('string');
    const md = readFileSync(join(h.dataDir, 'agents', msg.agent.agentId, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('TOY-7');
    expect(md).toContain('aom report spec-card --file');
    expect(md).toContain('aom report spec-card-fail');
    expect(existsSync(worktreeOf(h))).toBe(false);
    expect(h.server.invalid).toEqual([]);
  }, 60_000);

  it('can report that the card cannot be specified', async () => {
    h = await startHarness();
    const msg = specShift(h, 'Vague [spec_fail]');
    await run(h, msg);
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({ outcomeId: 'spec_card_fail' });
  }, 60_000);
});
