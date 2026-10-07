import { z } from 'zod';
import { MockScriptSchema } from '../cards/fields.ts';
import { CompletionAction } from '../cards/types.ts';
import { RegressionPlatform } from '../events/testing.ts';
import type { ReporterTaskKind } from '../reporter/index.ts';
import { isReporterTaskKind, ReporterTaskSchema, reporterBriefOutcomes } from '../reporter/index.ts';

/**
 * Named phases with post-phase follow-ups (docs/design/phases.md, Part A): the contract shared by the server, the
 * runner and the web. A phase groups cards of one project; when every member card's work is merged into the working
 * branch the BA reports to the manager, who approves the follow-ups (deploy, regression run, custom instruction) that
 * the server then runs one after the other.
 */

// ------------------------------------------------------------------------------------------ statuses

export const PhaseStatus = z.enum([
  'proposed',
  'open',
  'reporting',
  'awaiting_approval',
  'running_followups',
  'reporting_results',
  'done',
  'done_with_failures',
  'followups_rejected',
  'discarded',
  /** The project was archived: the phase and its pending follow-ups were cancelled. */
  'cancelled',
]);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

/** Statuses a phase never leaves. */
export const PHASE_FINAL_STATUSES: readonly PhaseStatus[] = [
  'done',
  'done_with_failures',
  'followups_rejected',
  'discarded',
  'cancelled',
];
export const isPhaseFinal = (s: string): boolean => (PHASE_FINAL_STATUSES as readonly string[]).includes(s);

/** Statuses in which cards may be assigned to the phase and its follow-ups may be edited. */
export const PHASE_ASSIGNABLE_STATUSES: readonly PhaseStatus[] = ['proposed', 'open'];
export const PHASE_FOLLOWUP_EDITABLE_STATUSES: readonly PhaseStatus[] = [
  'proposed',
  'open',
  'reporting',
  'awaiting_approval',
];

export const FollowupStatus = z.enum([
  'pending',
  'queued',
  'briefed',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type FollowupStatus = z.infer<typeof FollowupStatus>;
export const FOLLOWUP_TERMINAL: readonly FollowupStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];
export const isFollowupTerminal = (s: string): boolean =>
  (FOLLOWUP_TERMINAL as readonly string[]).includes(s);

export const FollowupDelegate = z.enum(['devops', 'tester', 'ba']);
export type FollowupDelegate = z.infer<typeof FollowupDelegate>;

export const FollowupKind = z.enum(['deploy', 'regression', 'custom']);
export type FollowupKind = z.infer<typeof FollowupKind>;

export const PhaseAssignment = z.enum(['proposed', 'confirmed']);
export type PhaseAssignment = z.infer<typeof PhaseAssignment>;

// --------------------------------------------------------------------------------------- follow-up specs

const specBase = <I extends z.ZodType>(id: I) => ({ id, note: z.string().max(4000).default('') });

/**
 * One follow-up as the manager or the BA writes it. Follow-ups run strictly in list order and any failed follow-up
 * stops the ones after it (owner decision A7), so there is no per-item failure policy.
 */
const makeSpec = <I extends z.ZodType>(id: I) =>
  z.discriminatedUnion('kind', [
    z.object({ ...specBase(id), kind: z.literal('deploy'), targetId: z.uuid() }),
    z.object({
      ...specBase(id),
      kind: z.literal('regression'),
      platform: RegressionPlatform.default('web'),
      targetId: z.uuid().optional(),
      /** Mock runtime only (accepted with AOM_MOCK_UI): copied to the regression cards' `fields.mock`. */
      mock: MockScriptSchema.optional(),
    }),
    z.object({ ...specBase(id), kind: z.literal('custom'), instruction: z.string().min(1).max(4000) }),
  ]);

export const FollowupSpecSchema = makeSpec(z.uuid().optional());
export type FollowupSpec = z.infer<typeof FollowupSpecSchema>;
/** The same with its id minted (what events carry). */
export const FollowupSpecWithIdSchema = makeSpec(z.uuid());
export type FollowupSpecWithId = z.infer<typeof FollowupSpecWithIdSchema>;
export const FollowupListSchema = z.array(FollowupSpecSchema).max(10);
export const FollowupListWithIdSchema = z.array(FollowupSpecWithIdSchema).max(10);

/** Platform-less one-line label of a follow-up ("Deploy to staging"); `targetName` is resolved by the caller. */
export function followupLabel(
  f: { kind: FollowupKind; platform?: string | null; instruction?: string | null },
  targetName?: string | null,
): string {
  if (f.kind === 'deploy') return `Deploy to ${targetName ?? 'target'}`;
  if (f.kind === 'regression')
    return `Regression run (${f.platform ?? 'web'})${targetName ? ` against ${targetName}` : ''}`;
  const text = f.instruction ?? '';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** The delegate a follow-up kind must go to (a custom one may go to any). */
export function allowedDelegates(kind: FollowupKind): FollowupDelegate[] {
  if (kind === 'deploy') return ['devops'];
  if (kind === 'regression') return ['tester'];
  return ['devops', 'tester', 'ba'];
}

// ----------------------------------------------------------------------------- deploy targets (DTO shape)

export const DeployTargetKind = z.enum(['local_docker', 'remote_ssh']);
export type DeployTargetKind = z.infer<typeof DeployTargetKind>;

// ---------------------------------------------------------------------------------------- card outcomes

export const PhaseCardOutcomeKind = z.enum(['finalized', 'closed_manually', 'cancelled']);
export type PhaseCardOutcomeKind = z.infer<typeof PhaseCardOutcomeKind>;

export const PhaseCardOutcome = z.object({
  cardId: z.uuid(),
  ref: z.string(),
  title: z.string(),
  outcome: PhaseCardOutcomeKind,
  action: CompletionAction.optional(),
  resultRef: z
    .object({
      mergeCommit: z.string().optional(),
      prUrl: z.string().optional(),
      pushedBranch: z.string().optional(),
    })
    .partial()
    .optional(),
  reason: z.string().optional(),
  /** The card branch when it was not merged (cancelled or closed by hand): kept, and listed in the report. */
  unmergedBranch: z.string().optional(),
});
export type PhaseCardOutcome = z.infer<typeof PhaseCardOutcome>;

export const PhaseOutstandingSchema = z.object({
  kind: z.enum(['pr_open', 'suite_failed', 'suite_running', 'bug', 'unmerged_branch', 'other']),
  text: z.string().max(2000),
  cardId: z.uuid().optional(),
  url: z.string().optional(),
});
export type PhaseOutstanding = z.infer<typeof PhaseOutstandingSchema>;

/** Desk `subkind` values of the phase items. */
export const PHASE_DESK_SUBKIND = {
  proposal: 'phase_proposal',
  done: 'phase_done',
  results: 'phase_results',
} as const;
export const isPhaseDeskSubkind = (s: string | null | undefined): boolean =>
  s === PHASE_DESK_SUBKIND.proposal || s === PHASE_DESK_SUBKIND.done || s === PHASE_DESK_SUBKIND.results;

export const phaseRef = (projectKey: string, n: number): string => `${projectKey}-P${n}`;
export function parsePhaseRef(ref: string): { projectKey: string; number: number } | null {
  const m = /^([A-Z][A-Z0-9]{1,9})-P([1-9][0-9]*)$/.exec(ref);
  return m ? { projectKey: m[1] as string, number: Number(m[2]) } : null;
}

// ------------------------------------------------------------------------------------- completion rule

/** What the completion rule needs to know about one member card. */
export interface PhaseMemberState {
  status: string;
  assignment: PhaseAssignment;
  /** The completion action ran (`CardFinalized`). */
  finalized: boolean;
  action?: string | null;
  /** The card's work is in the working branch (a `merge` finalize, or a verified `pr` / `push_branch` branch). */
  merged: boolean;
}

/**
 * How a member card ended, or `null` while it has not (including a finalized `pr` / `push_branch` card whose branch is
 * not merged into the working branch yet: owner decision A2, `waiting_merge`).
 */
export function memberOutcome(
  c: Pick<PhaseMemberState, 'status' | 'finalized' | 'action' | 'merged'>,
): PhaseCardOutcomeKind | 'waiting_merge' | null {
  if (c.status === 'cancelled') return 'cancelled';
  if (c.status !== 'done') return null;
  if (!c.finalized) return 'closed_manually';
  if (c.action === 'merge' || c.merged) return 'finalized';
  return 'waiting_merge';
}

/**
 * A phase in `open` is complete when it has at least one confirmed member, no member is still only proposed, and
 * every confirmed member ended (finalized and merged into the working branch, closed by hand, or cancelled).
 */
export function phaseCompletion(members: readonly PhaseMemberState[]): 'incomplete' | 'complete' {
  const confirmed = members.filter((m) => m.assignment === 'confirmed');
  if (confirmed.length === 0) return 'incomplete';
  if (members.some((m) => m.assignment === 'proposed')) return 'incomplete';
  return confirmed.every((m) => {
    const o = memberOutcome(m);
    return o !== null && o !== 'waiting_merge';
  })
    ? 'complete'
    : 'incomplete';
}

// ---------------------------------------------------------------------------------------- sequencing

export interface FollowupState {
  id: string;
  position: number;
  status: string;
}

/**
 * What the server does next with a running phase's follow-ups (strict list order, one at a time, a failure stops
 * everything after it). `start`: the next follow-up, when it is briefed; `skip`: ids to mark skipped; `finished`:
 * every follow-up is terminal; `failed`: one of them failed.
 */
export function nextFollowup(list: readonly FollowupState[]): {
  start?: string;
  skip: string[];
  finished: boolean;
  failed: boolean;
} {
  const sorted = [...list].sort((a, b) => a.position - b.position);
  const failed = sorted.some((f) => f.status === 'failed');
  const skip: string[] = [];
  let start: string | undefined;
  let blocked = false;
  let failedBefore = false;
  for (const f of sorted) {
    if (isFollowupTerminal(f.status)) {
      if (f.status === 'failed') failedBefore = true;
      continue;
    }
    if (failedBefore) {
      skip.push(f.id);
      continue;
    }
    if (blocked) continue;
    blocked = true; // the first open follow-up decides; later ones wait for it
    if (f.status === 'briefed') start = f.id;
  }
  return {
    ...(start ? { start } : {}),
    skip,
    finished: sorted.every((f) => isFollowupTerminal(f.status)),
    failed,
  };
}

// ------------------------------------------------------------------------------ BA task outcome data

export const PHASE_OUTCOME = {
  report: 'phase_report',
  ready: 'phase_ready',
  followupDone: 'followup_done',
  followupFailed: 'followup_failed',
  results: 'phase_results',
} as const;

export const PhaseReportDataSchema = z.object({
  report: z.string().min(1).max(40000),
  outstanding: z.array(z.string().min(1).max(2000)).max(50).default([]),
});
export const PhaseReadyDataSchema = z.object({ note: z.string().max(4000).default('') });
export const FollowupDoneDataSchema = z.object({
  position: z.number().int().positive(),
  summary: z.string().min(1).max(20000),
  links: z.array(z.string().max(2000)).max(20).default([]),
});
export const FollowupFailedDataSchema = z.object({
  position: z.number().int().positive(),
  summary: z.string().min(1).max(20000),
});
export const PhaseResultsDataSchema = z.object({ report: z.string().min(1).max(40000) });

export const BaTaskKind = z.enum([
  'phase_report',
  'followups_brief',
  'followup_custom',
  'followups_report',
  // Part B reporter tasks (org level: no phase).
  'desk_triage',
  'urgent_note',
  'floor_alert',
  'floor_report',
  'scheduled_brief',
]);
export type BaTaskKind = z.infer<typeof BaTaskKind>;
export const BaTaskStatus = z.enum(['queued', 'running', 'done', 'failed', 'fallback', 'cancelled']);
export type BaTaskStatus = z.infer<typeof BaTaskStatus>;

/** A BA task that nobody takes within this time is done by the server from a template (owner decision A12). */
export const BA_TASK_STALL_MS = 15 * 60_000;
export const BA_TASK_MAX_ATTEMPTS = 2;
export const BA_TASK_MAX_SHIFT_MINUTES = 30;

/** `phase.followup.brief` RPC. */
export const FollowupBriefParamsSchema = z.object({
  position: z.number().int().positive(),
  to: FollowupDelegate,
  text: z.string().min(1).max(20000),
});

// ------------------------------------------------------------------------- BA task shift (shift.start)

export const DeployTargetBriefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: DeployTargetKind,
  host: z.string().nullable(),
  appUrl: z.string().nullable(),
  notes: z.string(),
});
export type DeployTargetBrief = z.infer<typeof DeployTargetBriefSchema>;

export const BaTaskShiftSchema = z.object({
  taskId: z.uuid(),
  kind: BaTaskKind,
  /** Phase tasks. Reporter tasks (Part B) have no phase and carry `reporter` instead. */
  phase: z
    .object({
      id: z.uuid(),
      ref: z.string(),
      name: z.string(),
      description: z.string(),
      status: PhaseStatus,
      projectKey: z.string(),
      workingBranch: z.string(),
    })
    .optional(),
  reporter: ReporterTaskSchema.optional(),
  cards: z
    .array(
      PhaseCardOutcome.extend({
        suite: z
          .object({
            ref: z.string(),
            status: z.string(),
            result: z.enum(['passed', 'failed', 'running']).optional(),
            bugRefs: z.array(z.string()).default([]),
          })
          .optional(),
      }),
    )
    .default([]),
  followups: z
    .array(
      z.object({
        id: z.uuid(),
        position: z.number().int().positive(),
        kind: FollowupKind,
        target: DeployTargetBriefSchema.nullable(),
        platform: z.string().nullable(),
        instruction: z.string(),
        note: z.string(),
        status: FollowupStatus,
        delegate: FollowupDelegate.nullable(),
        brief: z.string().nullable(),
        resultSummary: z.string().nullable(),
        evidence: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
  /** `followup_custom`: the follow-up the BA carries out itself. */
  followupId: z.uuid().optional(),
  outstanding: z.array(PhaseOutstandingSchema).default([]),
});
export type BaTaskShift = z.infer<typeof BaTaskShiftSchema>;

// ---------------------------------------------------------------------------------- fallback renderers

export interface FallbackFollowup {
  position: number;
  kind: FollowupKind;
  label: string;
  status: string;
  resultSummary?: string | null;
}

const cardLine = (c: PhaseCardOutcome): string => {
  if (c.outcome === 'cancelled')
    return `- ${c.ref} ${c.title}: cancelled${c.reason ? ` (${c.reason})` : ''}${c.unmergedBranch ? `; branch ${c.unmergedBranch} kept, not merged` : ''}`;
  if (c.outcome === 'closed_manually')
    return `- ${c.ref} ${c.title}: closed by hand, no completion action ran${c.unmergedBranch ? `; branch ${c.unmergedBranch} kept` : ''}`;
  const how =
    c.action === 'merge'
      ? `merged${c.resultRef?.mergeCommit ? ` (${c.resultRef.mergeCommit.slice(0, 10)})` : ''}`
      : c.action === 'pr'
        ? `PR${c.resultRef?.prUrl ? ` ${c.resultRef.prUrl}` : ''}, now merged into the working branch`
        : `branch ${c.resultRef?.pushedBranch ?? ''} pushed, now merged into the working branch`;
  return `- ${c.ref} ${c.title}: ${how}`;
};

export const FALLBACK_NOTICE = 'Your BA was not available; this summary was generated.';

/** Template `phase_report` (the server posts it when no BA takes the task). */
export function renderPhaseReportFallback(input: {
  phaseRef: string;
  phaseName: string;
  cards: readonly PhaseCardOutcome[];
  outstanding: readonly PhaseOutstanding[];
  followups: readonly FallbackFollowup[];
}): string {
  const delivered = input.cards.filter((c) => c.outcome !== 'cancelled');
  const out: string[] = [FALLBACK_NOTICE, '', `## ${input.phaseRef} ${input.phaseName} is done`, ''];
  if (delivered.length === 0)
    out.push('Nothing was delivered: every card was cancelled. Rejecting the follow-ups is recommended.', '');
  out.push('### Cards', ...input.cards.map(cardLine), '');
  out.push(
    '### Outstanding',
    ...(input.outstanding.length ? input.outstanding.map((o) => `- ${o.text}`) : ['- nothing']),
    '',
  );
  out.push(
    '### Follow-ups that run if you approve (in order)',
    ...(input.followups.length ? input.followups.map((f) => `${f.position}. ${f.label}`) : ['- none']),
  );
  return out.join('\n');
}

/** Template delegation brief for a follow-up (the server writes it when no BA is available). */
export function renderFollowupBriefFallback(input: {
  phaseRef: string;
  phaseName: string;
  workingBranch: string;
  kind: FollowupKind;
  note: string;
  instruction: string;
  platform?: string | null;
  target?: DeployTargetBrief | null;
  cards: readonly PhaseCardOutcome[];
}): string {
  const commits = input.cards
    .filter((c) => c.outcome === 'finalized')
    .map(
      (c) =>
        `${c.ref} ${c.title}${c.resultRef?.mergeCommit ? ` (${c.resultRef.mergeCommit.slice(0, 10)})` : ''}`,
    );
  const t = input.target;
  const targetLines = t
    ? [
        `Target: ${t.name} (${t.kind === 'local_docker' ? 'local Docker stack on this workstation' : `remote host ${t.host ?? '(see notes)'} over SSH`})`,
        ...(t.appUrl ? [`App URL: ${t.appUrl}`] : []),
        ...(t.notes.trim() ? [`How to deploy: ${t.notes.trim()}`] : []),
      ]
    : [];
  const note = input.note.trim() ? [`Notes from the manager: ${input.note.trim()}`] : [];
  const cards = commits.length ? ['Delivered in this phase:', ...commits.map((c) => `- ${c}`)] : [];
  if (input.kind === 'deploy')
    return [
      `Deploy phase ${input.phaseRef} (${input.phaseName}) from the working branch ${input.workingBranch}.`,
      ...targetLines,
      ...cards,
      ...note,
      'Pull the working branch, rebuild and restart as the notes say, then check the app answers.',
      'Finish with `aom devops-done --summary` stating the deployed commit and the URL you verified.',
    ].join('\n');
  if (input.kind === 'regression')
    return [
      `Run the full ${input.platform ?? 'web'} regression suite for phase ${input.phaseRef} (${input.phaseName}).`,
      ...targetLines,
      ...cards,
      ...note,
      'Report failures as bugs with evidence.',
    ].join('\n');
  return [`Phase ${input.phaseRef} (${input.phaseName}): ${input.instruction}`, ...note, ...cards].join('\n');
}

/** Template `followups_report`. */
export function renderResultsReportFallback(input: {
  phaseRef: string;
  phaseName: string;
  followups: readonly FallbackFollowup[];
}): string {
  const failed = input.followups.filter((f) => f.status === 'failed').length;
  const ok = input.followups.filter((f) => f.status === 'succeeded').length;
  return [
    FALLBACK_NOTICE,
    '',
    `## ${input.phaseRef} ${input.phaseName}: follow-ups finished (${ok} succeeded, ${failed} failed)`,
    '',
    ...input.followups.map(
      (f) =>
        `${f.position}. ${f.label}: ${f.status}${f.resultSummary ? `\n   ${f.resultSummary.replace(/\n/g, '\n   ')}` : ''}`,
    ),
  ].join('\n');
}

// ------------------------------------------------------------------ branch merge check (runner command)

/**
 * `branch.check_merged` (owner decision A2): is the card branch's head an ancestor of the working branch? Run by the
 * runner of the card's home workstation with git; no GitHub status is needed. A merged branch is deleted (locally and,
 * for `push_branch`, on the remote), so the same check also cleans up.
 */
export const BranchCheckMergedPayloadSchema = z.object({
  cardId: z.uuid(),
  ref: z.string(),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  branchName: z.string(),
  workingBranch: z.string(),
  action: z.enum(['pr', 'push_branch']),
});
export type BranchCheckMergedPayload = z.infer<typeof BranchCheckMergedPayloadSchema>;

export const BranchCheckMergedResultSchema = z.object({
  merged: z.boolean(),
  /** Why it could not be decided or is not merged yet (no clone, branch missing, ...). */
  reason: z.string().optional(),
  branchDeleted: z.boolean().default(false),
  remoteBranchDeleted: z.boolean().default(false),
});
export type BranchCheckMergedResult = z.infer<typeof BranchCheckMergedResultSchema>;

/** Outcomes placed in the synthetic brief of a `ba_task` shift (the runner validates reports against them). */
export function baTaskBriefOutcomes(kind: BaTaskKind) {
  if (isReporterTaskKind(kind)) return reporterBriefOutcomes(kind as ReporterTaskKind);
  const o = (id: string, label: string, data: string) => ({ id, label, kind: 'success' as const, data });
  switch (kind) {
    case 'phase_report':
      return [o(PHASE_OUTCOME.report, 'Report the finished phase to the manager', 'phaseReport')];
    case 'followups_brief':
      return [o(PHASE_OUTCOME.ready, 'Every follow-up is briefed', 'phaseReady')];
    case 'followup_custom':
      return [
        o(PHASE_OUTCOME.followupDone, 'The follow-up was carried out', 'followupDone'),
        {
          ...o(PHASE_OUTCOME.followupFailed, 'The follow-up could not be carried out', 'followupFailed'),
          kind: 'failure' as const,
        },
      ];
    case 'followups_report':
      return [o(PHASE_OUTCOME.results, 'Report the follow-up results to the manager', 'phaseResults')];
    default:
      return [];
  }
}
