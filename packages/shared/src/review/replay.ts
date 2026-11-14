import { z } from 'zod';
import { IsoTime } from '../api/common.ts';
import type { FindingDisposition } from './findings.ts';
import {
  type FindingMark,
  findingView,
  type PostedFindingDto,
  type PostedFindingRow,
  PR_REVIEWER_LABEL,
  reviewerPrecision,
} from './marks.ts';
import { type PrReviewer, PrReviewerSchema, REVIEWER_MODEL } from './pr-review.ts';

/**
 * The 20-PR replay: both reviewers review the 20 most recently merged pull requests of a PR-only repository offline
 * (nothing is posted), the owner marks the findings blind, and the result (precision per reviewer, marking effort) is
 * the baseline for the owner's targets.
 */
export const REPLAY_PR_COUNT = 20;
/** Merged pull requests fetched to find 20 usable ones. */
export const REPLAY_LIST_LIMIT = 50;
/** Both reviewers review every replay pull request. */
export const REPLAY_REVIEWERS = ['first', 'second'] as const satisfies readonly PrReviewer[];
/** Effort counts at most this long per finding, so a break does not count. */
export const REPLAY_IDLE_CAP_MS = 10 * 60_000;
export const REPLAY_STATES = ['listing', 'reviewing', 'marking', 'finished', 'failed', 'cancelled'] as const;
export const ReplayStateSchema = z.enum(REPLAY_STATES);
export type ReplayState = z.infer<typeof ReplayStateSchema>;
export const REPLAY_ACTIVE_STATES = ['listing', 'reviewing', 'marking'] as const;
/** A failed run is retried automatically this many times in all (a timeout: once). */
export const REPLAY_MAX_ATTEMPTS = 3;

export const ReplayFailureReasonSchema = z.enum([
  'not_enough_prs',
  'no_workstation',
  'unsupported',
  'not_connected',
  'error',
]);
export type ReplayFailureReason = z.infer<typeof ReplayFailureReasonSchema>;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/** One merged pull request as the git host reports it. */
export const MergedChangeSchema = z.object({
  id: z.string().min(1).max(40),
  url: z.string().max(500),
  title: z.string().max(300),
  author: z.string().max(100).nullable(),
  head: z.string().max(200),
  base: z.string().max(200),
  headSha: Sha40,
  mergeCommitSha: Sha40,
  mergedAt: z.iso.datetime({ offset: true }),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type MergedChange = z.infer<typeof MergedChangeSchema>;

/** `command.result` of `repo.list_merged_prs`. */
export const RepoListMergedPrsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), changes: z.array(MergedChangeSchema).max(100) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['no_clone', 'unsupported', 'not_connected', 'error']),
    error: z.string().max(400).optional(),
  }),
]);
export type RepoListMergedPrsResult = z.infer<typeof RepoListMergedPrsResultSchema>;

export const ReplayReviewerResultSchema = z.object({
  reviewer: PrReviewerSchema,
  label: z.string(),
  model: z.string(),
  prsReviewed: z.number().int(),
  prsNotReviewed: z.number().int(),
  wouldPost: z.number().int(),
  heldBack: z.number().int(),
  useful: z.number().int(),
  noise: z.number().int(),
  /** useful / wouldPost; null when nothing would have been posted. */
  precision: z.number().min(0).max(1).nullable(),
  /** Marking time on this reviewer's findings. */
  effortMs: z.number().int().nonnegative(),
});
export type ReplayReviewerResult = z.infer<typeof ReplayReviewerResultSchema>;

export const ReplayResultSchema = z.object({
  prCount: z.number().int(),
  reviewers: z.array(ReplayReviewerResultSchema),
  effort: z.object({
    activeMs: z.number().int().nonnegative(),
    perPrMs: z.number().int().nonnegative(),
    perFindingMs: z.number().int().nonnegative().nullable(),
    findingsMarked: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    idleCapMs: z.number().int(),
    prsPerWeek: z.number(),
    hoursPerWeekEstimate: z.number(),
  }),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

const MS_PER_WEEK = 7 * 24 * 3_600_000;

/**
 * Pure. Precision reuses `reviewerPrecision` on { reviewer, model, disposition, mark }.
 * Do NOT pass `posted`: replay rows keep posted = false and `reviewerPrecision` drops those.
 */
export function replayResult(
  input: {
    prs: { id: string; mergedAt: string }[];
    runs: { replayPrId: string; reviewer: PrReviewer; model: string; state: string }[];
    findings: {
      id: string;
      reviewer: PrReviewer;
      model: string;
      disposition: FindingDisposition;
      mark: FindingMark | null;
    }[];
    /** `shownAt`: the last time the finding was shown before its first mark. */
    views: { findingId: string; shownAt: string; markedAt: string }[];
  },
  opts: { idleCapMs?: number } = {},
): ReplayResult {
  const cap = opts.idleCapMs ?? REPLAY_IDLE_CAP_MS;
  const prCount = input.prs.length;
  const precision = reviewerPrecision(
    input.findings.map((f) => ({
      reviewer: f.reviewer,
      model: f.model,
      disposition: f.disposition,
      mark: f.mark,
    })),
  );
  const byFinding = new Map(input.findings.map((f) => [f.id, f]));
  const durations = new Map<string, number>();
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const v of input.views) {
    const f = byFinding.get(v.findingId);
    if (!f || f.disposition !== 'posted') continue;
    const s = Date.parse(v.shownAt);
    const m = Date.parse(v.markedAt);
    if (!Number.isFinite(s) || !Number.isFinite(m)) continue;
    durations.set(v.findingId, Math.min(cap, Math.max(0, m - s)));
    first = Math.min(first, s);
    last = Math.max(last, m);
  }
  let activeMs = 0;
  for (const d of durations.values()) activeMs += d;

  const reviewers = ([...REPLAY_REVIEWERS] as PrReviewer[]).map((reviewer): ReplayReviewerResult => {
    const mine = input.findings.filter((f) => f.reviewer === reviewer);
    const p = precision.find((x) => x.reviewer === reviewer);
    const reviewed = new Set(
      input.runs
        .filter((r) => r.reviewer === reviewer && r.state === 'offline_completed')
        .map((r) => r.replayPrId),
    ).size;
    let effortMs = 0;
    for (const f of mine) effortMs += durations.get(f.id) ?? 0;
    return {
      reviewer,
      label: PR_REVIEWER_LABEL[reviewer],
      model: REVIEWER_MODEL[reviewer].model,
      prsReviewed: reviewed,
      prsNotReviewed: Math.max(0, prCount - reviewed),
      wouldPost: p?.posted ?? 0,
      heldBack: mine.filter((f) => f.disposition === 'held_back').length,
      useful: p?.useful ?? 0,
      noise: p?.noise ?? 0,
      precision: p?.precision ?? null,
      effortMs,
    };
  });

  const merged = input.prs.map((p) => Date.parse(p.mergedAt)).filter(Number.isFinite);
  const spanWeeks = merged.length ? (Math.max(...merged) - Math.min(...merged)) / MS_PER_WEEK : 0;
  const prsPerWeek = prCount ? prCount / Math.max(1, spanWeeks) : 0;
  const perPrMs = prCount ? Math.round(activeMs / prCount) : 0;
  const hours = (perPrMs / 3_600_000) * prsPerWeek;
  return {
    prCount,
    reviewers,
    effort: {
      activeMs,
      perPrMs,
      perFindingMs: durations.size ? Math.round(activeMs / durations.size) : null,
      findingsMarked: durations.size,
      wallClockMs: durations.size ? Math.max(0, last - first) : 0,
      idleCapMs: cap,
      prsPerWeek: Math.round(prsPerWeek * 100) / 100,
      hoursPerWeekEstimate: Math.round(hours * 100) / 100,
    },
  };
}

/**
 * Blind view for replay findings: the reviewers only once the whole replay is finished. `findingView` reveals as soon as
 * a finding is marked, so this overrides reviewers to null until `revealed`.
 */
export function replayFindingView(
  row: PostedFindingRow,
  o: { revealed: boolean; canMark: boolean },
): PostedFindingDto {
  const v = findingView(row, { canMark: o.canMark });
  return o.revealed ? v : { ...v, reviewers: null };
}

/** FNV-1a, 32 bit, as 8 hex digits. */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Reviewer-independent marking order: PR order, then a hash of the finding id (never the id itself). */
export function replayOrderKey(f: { prIdx: number; id: string }): string {
  return `${String(f.prIdx).padStart(4, '0')}:${hash32(f.id)}:${f.id}`;
}

const Pct = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
const Tenth = (v: number): boolean => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;

export const StartReplayRequestSchema = z.object({ repoId: z.uuid() }).strict();
export type StartReplayRequest = z.infer<typeof StartReplayRequestSchema>;

export const SetReviewTargetsRequestSchema = z
  .object({
    precisionTarget: z.number().min(0).max(1).refine(Pct, 'at most two decimals'),
    effortTargetHoursPerWeek: z.number().min(0).max(168).refine(Tenth, 'at most one decimal'),
  })
  .strict();
export type SetReviewTargetsRequest = z.infer<typeof SetReviewTargetsRequestSchema>;

export const ReviewTargetsDtoSchema = z.object({
  precisionTarget: z.number().nullable(),
  effortTargetHoursPerWeek: z.number().nullable(),
  replayId: z.uuid().nullable(),
  setAt: IsoTime.nullable(),
});
export type ReviewTargetsDto = z.infer<typeof ReviewTargetsDtoSchema>;

export const ReplayDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  repoId: z.uuid(),
  repoName: z.string(),
  state: ReplayStateSchema,
  startedAt: IsoTime,
  finishedAt: IsoTime.nullable(),
  failure: z
    .object({
      reason: ReplayFailureReasonSchema,
      found: z.number().int().nullable(),
      detail: z.string().nullable(),
    })
    .nullable(),
  prs: z.array(
    z.object({
      id: z.uuid(),
      changeId: z.string(),
      url: z.string(),
      title: z.string(),
      mergedAt: IsoTime,
    }),
  ),
  /** Blind before finished: totals only, never per reviewer. */
  progress: z.object({
    runsTotal: z.number().int(),
    runsDone: z.number().int(),
    runsFailed: z.number().int(),
    findingsToMark: z.number().int(),
    findingsMarked: z.number().int(),
  }),
  /** Null until finished. */
  result: ReplayResultSchema.nullable(),
  canManage: z.boolean(),
});
export type ReplayDto = z.infer<typeof ReplayDtoSchema>;

export const ReplayFindingStepSchema = z.object({
  finding: z.custom<PostedFindingDto>(),
  pr: z.object({ changeId: z.string(), url: z.string(), title: z.string() }),
  position: z.number().int(),
  total: z.number().int(),
});
export type ReplayFindingStep = {
  finding: PostedFindingDto;
  pr: { changeId: string; url: string; title: string };
  position: number;
  total: number;
};

/** What the owner is told when a replay failed. */
export function replayFailureText(f: { reason: ReplayFailureReason; found: number | null }): string {
  switch (f.reason) {
    case 'not_enough_prs':
      return `This repository has ${f.found ?? 0} merged pull requests that can be replayed; the replay needs ${REPLAY_PR_COUNT}.`;
    case 'no_workstation':
      return 'No workstation with a clone of this repository is available.';
    case 'unsupported':
      return 'The git host of this repository is not supported for the replay.';
    case 'not_connected':
      return 'The workstation is not signed in to the git host.';
    default:
      return 'The merged pull requests could not be listed.';
  }
}
