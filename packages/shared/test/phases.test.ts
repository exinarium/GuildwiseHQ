import { describe, expect, it } from 'vitest';
import {
  type BaTaskShift,
  baTaskBriefOutcomes,
  CodeFieldsSchema,
  commandForOutcome,
  DomainEventSchema,
  FALLBACK_NOTICE,
  FollowupListSchema,
  FollowupSpecSchema,
  type FollowupState,
  memberOutcome,
  nextFollowup,
  outcomeDataSchema,
  type PhaseMemberState,
  parsePhaseRef,
  phaseCompletion,
  phaseRef,
  renderBaTaskInstructions,
  renderBaTaskPrompt,
  renderFollowupBriefFallback,
  renderPhaseReportFallback,
  renderResultsReportFallback,
  ShiftStartSchema,
} from '../src/index.ts';
import { agentSpec, buildBrief, env, TS, U } from './fixtures.ts';

const member = (o: Partial<PhaseMemberState> = {}): PhaseMemberState => ({
  status: 'queued',
  assignment: 'confirmed',
  finalized: false,
  action: null,
  merged: false,
  ...o,
});

describe('phaseCompletion (A1 table, A2 merged-into-working-branch)', () => {
  it('an empty phase and a phase with only proposed members never complete', () => {
    expect(phaseCompletion([])).toBe('incomplete');
    expect(phaseCompletion([member({ status: 'done', assignment: 'proposed' })])).toBe('incomplete');
  });
  it('a proposed assignment blocks completion even when every confirmed member ended', () => {
    expect(
      phaseCompletion([
        member({ status: 'done', finalized: true, action: 'merge' }),
        member({ status: 'draft', assignment: 'proposed' }),
      ]),
    ).toBe('incomplete');
  });
  it('a merge finalize counts at once; a pr or pushed branch counts once merged', () => {
    expect(phaseCompletion([member({ status: 'done', finalized: true, action: 'merge' })])).toBe('complete');
    expect(phaseCompletion([member({ status: 'done', finalized: true, action: 'pr' })])).toBe('incomplete');
    expect(phaseCompletion([member({ status: 'done', finalized: true, action: 'push_branch' })])).toBe(
      'incomplete',
    );
    expect(phaseCompletion([member({ status: 'done', finalized: true, action: 'pr', merged: true })])).toBe(
      'complete',
    );
    expect(
      phaseCompletion([member({ status: 'done', finalized: true, action: 'push_branch', merged: true })]),
    ).toBe('complete');
  });
  it('a card closed by hand and a cancelled card are resolved', () => {
    expect(memberOutcome(member({ status: 'done' }))).toBe('closed_manually');
    expect(memberOutcome(member({ status: 'cancelled' }))).toBe('cancelled');
    expect(phaseCompletion([member({ status: 'done' }), member({ status: 'cancelled' })])).toBe('complete');
  });
  it('a phase whose members were all cancelled still completes (A4)', () => {
    expect(phaseCompletion([member({ status: 'cancelled' }), member({ status: 'cancelled' })])).toBe(
      'complete',
    );
  });
  it('cards still in flight are not resolved, including a running or approval-waiting finalize', () => {
    for (const status of ['draft', 'queued', 'claimed', 'blocked', 'waiting'])
      expect(phaseCompletion([member({ status })])).toBe('incomplete');
    expect(memberOutcome(member({ status: 'waiting' }))).toBeNull();
  });
});

const f = (position: number, status: string): FollowupState => ({ id: `f${position}`, position, status });

describe('nextFollowup (A7: any failure stops the rest)', () => {
  it('starts the first follow-up when it is briefed, and nothing while it is only queued', () => {
    expect(nextFollowup([f(1, 'queued'), f(2, 'queued')])).toMatchObject({ skip: [], finished: false });
    expect(nextFollowup([f(1, 'queued')]).start).toBeUndefined();
    expect(nextFollowup([f(1, 'briefed'), f(2, 'briefed')]).start).toBe('f1');
  });
  it('waits while one runs and starts the next after a success', () => {
    expect(nextFollowup([f(1, 'running'), f(2, 'briefed')]).start).toBeUndefined();
    expect(nextFollowup([f(1, 'succeeded'), f(2, 'briefed')]).start).toBe('f2');
    expect(nextFollowup([f(2, 'briefed'), f(1, 'succeeded')]).start).toBe('f2');
  });
  it('a failed follow-up skips every later one, whatever the kind', () => {
    const r = nextFollowup([f(1, 'succeeded'), f(2, 'failed'), f(3, 'briefed'), f(4, 'queued')]);
    expect(r).toMatchObject({ skip: ['f3', 'f4'], failed: true, finished: false });
    expect(r.start).toBeUndefined();
  });
  it('is finished when every follow-up is terminal, and flags failures', () => {
    expect(nextFollowup([f(1, 'succeeded'), f(2, 'succeeded')])).toMatchObject({
      finished: true,
      failed: false,
    });
    expect(nextFollowup([f(1, 'failed'), f(2, 'skipped')])).toMatchObject({ finished: true, failed: true });
    expect(nextFollowup([])).toMatchObject({ finished: true, failed: false, skip: [] });
  });
});

describe('FollowupSpecSchema', () => {
  it('round trips each kind and applies defaults', () => {
    const list = FollowupListSchema.parse([
      { kind: 'deploy', targetId: U.a },
      { kind: 'regression' },
      { kind: 'custom', instruction: 'Tell the team', note: 'n' },
    ]);
    expect(list[0]).toMatchObject({ kind: 'deploy', note: '' });
    expect(list[1]).toMatchObject({ kind: 'regression', platform: 'web' });
    expect(FollowupListSchema.parse(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });
  it('rejects a deploy without a target, a custom without an instruction and more than ten', () => {
    expect(FollowupSpecSchema.safeParse({ kind: 'deploy' }).success).toBe(false);
    expect(FollowupSpecSchema.safeParse({ kind: 'custom', instruction: '' }).success).toBe(false);
    expect(
      FollowupListSchema.safeParse(Array.from({ length: 11 }, () => ({ kind: 'regression' }))).success,
    ).toBe(false);
  });
  it('ignores a per-item failure policy: any failure stops the rest', () => {
    const r = FollowupSpecSchema.parse({ kind: 'regression', onFailure: 'continue' });
    expect('onFailure' in r).toBe(false);
  });
});

describe('phase refs', () => {
  it('formats and parses', () => {
    expect(phaseRef('WEB', 2)).toBe('WEB-P2');
    expect(parsePhaseRef('WEB-P2')).toEqual({ projectKey: 'WEB', number: 2 });
    expect(parsePhaseRef('WEB-2')).toBeNull();
  });
});

const ids = { phaseId: U.a, followupId: U.b, taskId: U.c, deskItemId: U.d };
const actor = { kind: 'agent' as const, agentId: U.b, role: 'ba' };

describe('phase events', () => {
  const samples: Array<{ type: string; payload: Record<string, unknown> }> = [
    {
      type: 'PhaseCreated',
      payload: {
        phaseId: U.a,
        projectId: U.b,
        number: 1,
        ref: 'WEB-P1',
        name: 'Phase 1',
        status: 'proposed',
        createdBy: actor,
        followups: [{ id: U.c, kind: 'deploy', targetId: U.d }],
      },
    },
    { type: 'PhaseUpdated', payload: { phaseId: U.a, changes: { name: 'x' }, by: actor } },
    { type: 'PhaseFollowupsSet', payload: { phaseId: U.a, followups: [], by: actor } },
    {
      type: 'CardPhaseChanged',
      payload: { cardId: U.a, phaseId: U.b, assignment: 'proposed', by: actor, cause: 'bug_filed' },
    },
    { type: 'CardMergeVerified', payload: { cardId: U.a, workingBranch: 'main' } },
    {
      type: 'PhaseProposalSubmitted',
      payload: { phaseId: U.a, deskItemId: U.d, proposedCardIds: [U.b], newPhase: true },
    },
    { type: 'PhaseConfirmed', payload: { phaseId: U.a, by: actor, confirmedCardIds: [] } },
    {
      type: 'PhaseProposalRejected',
      payload: { phaseId: U.a, by: actor, clearedCardIds: [], discard: true },
    },
    {
      type: 'PhaseCompleted',
      payload: {
        phaseId: U.a,
        baTaskId: U.c,
        cardOutcomes: [{ cardId: U.b, ref: 'WEB-1', title: 't', outcome: 'finalized', action: 'merge' }],
      },
    },
    { type: 'PhaseReportPosted', payload: { phaseId: U.a, deskItemId: U.d, report: 'r', by: actor } },
    { type: 'PhaseReopened', payload: { phaseId: U.a, by: actor, reason: 'more work' } },
    { type: 'PhaseFollowupsApproved', payload: { phaseId: U.a, by: actor, followups: [], baTaskId: U.c } },
    { type: 'PhaseFollowupsRejected', payload: { phaseId: U.a, by: actor } },
    {
      type: 'PhaseFollowupBriefed',
      payload: { phaseId: U.a, followupId: U.b, delegate: 'devops', brief: 'b', by: actor },
    },
    {
      type: 'PhaseFollowupStarted',
      payload: { phaseId: U.a, followupId: U.b, delegate: 'devops', devopsRequestIds: [U.c, U.d] },
    },
    {
      type: 'PhaseFollowupFinished',
      payload: { phaseId: U.a, followupId: U.b, status: 'succeeded', summary: 's' },
    },
    { type: 'PhaseFollowupsFinished', payload: { phaseId: U.a, status: 'done_with_failures' } },
    {
      type: 'PhaseResultsReported',
      payload: { phaseId: U.a, deskItemId: U.d, report: 'r', finalStatus: 'done', by: actor },
    },
    { type: 'PhaseCancelled', payload: { phaseId: U.a, reason: 'archived' } },
    { type: 'ProjectFollowupDefaultsSet', payload: { projectId: U.a, followups: [], changedBy: U.b } },
    {
      type: 'DeployTargetAdded',
      payload: {
        targetId: U.a,
        projectId: U.b,
        name: 'local',
        kind: 'local_docker',
        workstationId: null,
        notes: '',
        createdBy: U.c,
      },
    },
    { type: 'DeployTargetUpdated', payload: { targetId: U.a, changes: { appUrl: null } } },
    { type: 'DeployTargetRemoved', payload: { targetId: U.a } },
    { type: 'BaTaskQueued', payload: { taskId: U.c, kind: 'phase_report', phaseId: U.a } },
    {
      type: 'BaTaskDispatched',
      payload: { taskId: U.c, shiftId: U.a, agentId: U.b, workstationId: U.d },
    },
    { type: 'BaTaskRequeued', payload: { taskId: U.c, reason: 'no_report' } },
    { type: 'BaTaskCompleted', payload: { taskId: U.c, status: 'fallback' } },
  ];
  it.each(samples)('$type parses and survives a JSON round trip', (e) => {
    const parsed = DomainEventSchema.parse(e);
    expect(DomainEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
  it('rejects a BaTaskCompleted with a non-final status', () => {
    expect(
      DomainEventSchema.safeParse({ type: 'BaTaskCompleted', payload: { taskId: U.c, status: 'running' } })
        .success,
    ).toBe(false);
  });
  it('CardCreated carries the home workstation and the follow-up of a regression card', () => {
    const r = DomainEventSchema.parse({
      type: 'CardCreated',
      payload: {
        cardId: U.a,
        projectId: U.b,
        number: 1,
        ref: 'WEB-1',
        title: 'T',
        cardType: 'regression',
        workflowVersionId: U.c,
        stage: 'test',
        status: 'queued',
        fields: {},
        ownerUserId: U.d,
        origin: 'regression',
        homeWorkstationId: U.e,
        phaseFollowupId: U.b,
      },
    });
    expect(r.type === 'CardCreated' && r.payload.homeWorkstationId).toBe(U.e);
  });
  it('ids are unused fixtures guard', () => {
    expect(Object.keys(ids)).toHaveLength(4);
  });
});

describe('card fields for regression cards', () => {
  it('accept an http(s) target URL and the target name, and refuse other schemes', () => {
    const schema = CodeFieldsSchema;
    expect(schema.safeParse({ targetUrl: 'http://localhost:4601', deployTarget: 'local' }).success).toBe(
      true,
    );
    expect(schema.safeParse({ targetUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
});

const task = (kind: BaTaskShift['kind']): BaTaskShift => ({
  taskId: U.c,
  kind,
  phase: {
    id: U.a,
    ref: 'WEB-P1',
    name: 'Autosave',
    description: 'Save as you type',
    status: kind === 'phase_report' ? 'reporting' : 'running_followups',
    projectKey: 'WEB',
    workingBranch: 'main',
  },
  cards: [
    {
      cardId: U.b,
      ref: 'WEB-1',
      title: 'Autosave',
      outcome: 'finalized',
      action: 'merge',
      resultRef: { mergeCommit: 'abcdef1234567890' },
      suite: { ref: 'WEB-9', status: 'done', result: 'failed', bugRefs: ['WEB-10'] },
    },
    {
      cardId: U.d,
      ref: 'WEB-2',
      title: 'Spike',
      outcome: 'cancelled',
      reason: 'dropped',
      unmergedBranch: 'aom/web-2',
    },
  ],
  followups: [
    {
      id: U.b,
      position: 1,
      kind: 'deploy',
      target: {
        id: U.d,
        name: 'staging',
        kind: 'remote_ssh',
        host: 'stg',
        appUrl: 'https://stg.example',
        notes: 'compose up',
      },
      platform: null,
      instruction: '',
      note: 'be careful',
      status: kind === 'followups_report' ? 'succeeded' : 'queued',
      delegate: null,
      brief: null,
      resultSummary: 'deployed abc123',
      evidence: { requests: 1 },
    },
    {
      id: U.e,
      position: 2,
      kind: 'custom',
      target: null,
      platform: null,
      instruction: 'Write the release notes',
      note: '',
      status: 'queued',
      delegate: null,
      brief: null,
      resultSummary: null,
      evidence: {},
    },
  ],
  followupId: kind === 'followup_custom' ? U.e : undefined,
  outstanding: [{ kind: 'pr_open', text: 'WEB-3: PR not merged' }],
});

describe('BA task prompts', () => {
  const brief = () => {
    const b = buildBrief();
    return { ...b, shift: { ...b.shift, kind: 'ba_task' as const } };
  };
  const kinds = ['phase_report', 'followups_brief', 'followup_custom', 'followups_report'] as const;
  it.each(kinds)('renders the %s prompt with the cards, follow-ups and the job', (kind) => {
    const p = renderBaTaskPrompt(task(kind));
    expect(p).toContain('WEB-P1');
    expect(p).toContain('WEB-1 Autosave: finalized (merge) abcdef1234');
    expect(p).toContain('WEB-2 Spike: cancelled: dropped; branch aom/web-2 kept, not merged');
    expect(p).toContain('1. deploy to staging');
    expect(p).toContain('PR not merged');
    if (kind === 'followups_brief') expect(p).toContain('compose up');
    if (kind === 'followups_report') expect(p).toContain('deployed abc123');
    if (kind === 'followup_custom') expect(p).toContain('Follow-up 2: Write the release notes');
  });
  it.each(kinds)('renders %s instructions that name the terminal command and forbid questions', (kind) => {
    const b = { ...brief(), shift: { ...brief().shift, outcomes: baTaskBriefOutcomes(kind) } };
    const text = renderBaTaskInstructions(b, task(kind));
    expect(text).toContain('Never ask questions');
    for (const o of baTaskBriefOutcomes(kind)) expect(text).toContain(commandForOutcome(o));
  });
});

describe('phase outcomes', () => {
  it('maps the new outcome ids to commands and data schemas', () => {
    expect(
      commandForOutcome({ id: 'phase_report', label: '', kind: 'success', data: 'phaseReport' }),
    ).toContain('aom phase report');
    expect(
      commandForOutcome({ id: 'phase_ready', label: '', kind: 'success', data: 'phaseReady' }),
    ).toContain('aom phase ready');
    expect(
      commandForOutcome({ id: 'followup_done', label: '', kind: 'success', data: 'followupDone' }),
    ).toContain('aom phase followup done');
    expect(
      commandForOutcome({ id: 'followup_failed', label: '', kind: 'failure', data: 'followupFailed' }),
    ).toContain('aom phase followup fail');
    expect(
      commandForOutcome({ id: 'phase_results', label: '', kind: 'success', data: 'phaseResults' }),
    ).toContain('aom phase results');
    expect(outcomeDataSchema('phaseReport').safeParse({ report: 'x' }).success).toBe(true);
    expect(outcomeDataSchema('phaseReport').safeParse({ outstanding: [] }).success).toBe(false);
    expect(outcomeDataSchema('followupDone').safeParse({ position: 1, summary: 's' }).success).toBe(true);
  });
});

describe('fallback renderers (A12)', () => {
  const cards = task('phase_report').cards;
  it('the report starts with the not-available notice and lists cards, outstanding and the follow-ups', () => {
    const r = renderPhaseReportFallback({
      phaseRef: 'WEB-P1',
      phaseName: 'Autosave',
      cards,
      outstanding: [{ kind: 'pr_open', text: 'WEB-3: PR not merged' }],
      followups: [{ position: 1, kind: 'deploy', label: 'Deploy to staging', status: 'pending' }],
    });
    expect(r.startsWith(FALLBACK_NOTICE)).toBe(true);
    expect(r).toContain('WEB-1 Autosave: merged (abcdef1234)');
    expect(r).toContain('1. Deploy to staging');
    expect(r).toContain('PR not merged');
  });
  it('recommends rejecting when everything was cancelled', () => {
    const r = renderPhaseReportFallback({
      phaseRef: 'WEB-P1',
      phaseName: 'x',
      cards: [{ cardId: U.a, ref: 'WEB-1', title: 't', outcome: 'cancelled' }],
      outstanding: [],
      followups: [],
    });
    expect(r).toContain('Nothing was delivered');
  });
  it('briefs name the target, the notes and what to report', () => {
    const t = task('followups_brief').followups[0]?.target;
    const brief = renderFollowupBriefFallback({
      phaseRef: 'WEB-P1',
      phaseName: 'Autosave',
      workingBranch: 'main',
      kind: 'deploy',
      note: 'be careful',
      instruction: '',
      target: t,
      cards,
    });
    expect(brief).toContain('staging');
    expect(brief).toContain('stg');
    expect(brief).toContain('compose up');
    expect(brief).toContain('aom devops-done');
    expect(brief).toContain('be careful');
  });
  it('the results report counts successes and failures', () => {
    const r = renderResultsReportFallback({
      phaseRef: 'WEB-P1',
      phaseName: 'x',
      followups: [
        { position: 1, kind: 'deploy', label: 'Deploy', status: 'failed', resultSummary: 'boom' },
        { position: 2, kind: 'regression', label: 'Regression', status: 'skipped' },
      ],
    });
    expect(r).toContain('0 succeeded, 1 failed');
    expect(r).toContain('boom');
  });
});

describe('shift.start for a BA task', () => {
  it('accepts kind ba_task with its task', () => {
    const b = buildBrief();
    const r = ShiftStartSchema.safeParse({
      ...env('shift.start'),
      shiftId: U.a,
      claimId: U.b,
      kind: 'ba_task',
      agent: agentSpec,
      brief: b,
      worktree: null,
      prepare: { rebase: false },
      maxShiftMinutes: 30,
      baTask: task('phase_report'),
    });
    expect(r.success).toBe(true);
    void TS;
  });
});
