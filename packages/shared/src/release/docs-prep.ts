/**
 * Release prep (docs and videos): an optional stage that runs BEFORE the ship -> land -> tag -> publish flow.
 *
 * Not to be confused with the existing "release prep 2/4 ... 4/4" phases (proposal, commit, publish): those keep their
 * names. Everything here is `releaseDocsPrep` / `release_docs_prep` / "Release prep (docs and videos)".
 *
 * Pure: the step registry, the run state machine, the next-action planner and the ship gate. No I/O.
 */

import { VIDEOS_STEP } from './docs-prep-videos.ts';

export type ReleaseDocsPrepStepId = string;

export interface ReleaseDocsPrepStepDef {
  id: ReleaseDocsPrepStepId;
  label: string;
  description: string;
  /** Run order (ascending). Content steps of the sibling cards sit between `analyse` (10) and `commit` (1000). */
  order: number;
  defaultOn: boolean;
  /** True when the step writes files into the repository (they are committed by `commit`). */
  producesFiles: boolean;
  /** Only `commit`: always runs last, and only when every step before it passed in every repo. */
  last?: true;
  /** Steps that must be enabled too (a run that misses one is refused at start). */
  requires?: string[];
  /** Run in this order, each phase in every repo before the next phase. Default: one unnamed phase (''). */
  phases?: readonly string[];
  /** Phases the server runs itself (an agent shift), not a runner command. */
  serverPhases?: readonly string[];
}

export const ANALYSE_STEP: ReleaseDocsPrepStepDef = {
  id: 'analyse',
  label: 'Analyse changes',
  description:
    'Lists the commits, merged cards and changed files on the release branch since the last release tag, for every repository.',
  order: 10,
  defaultOn: true,
  producesFiles: false,
};

export const COMMIT_STEP: ReleaseDocsPrepStepDef = {
  id: 'commit',
  label: 'Commit results',
  description:
    'Commits the files the steps above produced to the release branch of each repository that changed, then pushes.',
  order: 1000,
  defaultOn: true,
  producesFiles: false,
  last: true,
  phases: ['prepare', 'push'],
};

export const CHANGELOG_STEP: ReleaseDocsPrepStepDef = {
  id: 'changelog',
  label: 'Write changelog',
  description:
    "Writes user-facing entries for the analysed changes into the Unreleased section of each repository's CHANGELOG.md.",
  order: 20,
  defaultOn: true,
  producesFiles: true,
  requires: ['analyse'],
};

export const GUIDE_STEP: ReleaseDocsPrepStepDef = {
  id: 'guide',
  label: 'Update user guide',
  description:
    'Updates the user guide sections for the changed features and rebuilds the PDF guide when the text changed. Needs Analyse changes.',
  order: 30,
  defaultOn: true,
  producesFiles: true,
  requires: ['analyse'],
};

/** Sibling steps append one import and one entry here; nothing else in this card changes. */
const STEPS: ReleaseDocsPrepStepDef[] = [ANALYSE_STEP, CHANGELOG_STEP, GUIDE_STEP, VIDEOS_STEP, COMMIT_STEP];

/** The registered steps in run order, with the `last` step forced to the end. */
export const releaseDocsPrepSteps = (): readonly ReleaseDocsPrepStepDef[] => {
  const sorted = [...STEPS].sort((a, b) => a.order - b.order);
  return [...sorted.filter((s) => !s.last), ...sorted.filter((s) => s.last)];
};

export const isReleaseDocsPrepStep = (id: string): boolean => STEPS.some((s) => s.id === id);

export const releaseDocsPrepStep = (id: string): ReleaseDocsPrepStepDef | undefined =>
  STEPS.find((s) => s.id === id);

/** The phases of a step in run order; '' alone for a single-phase step. */
export const stepPhases = (id: string): readonly string[] => releaseDocsPrepStep(id)?.phases ?? [''];

/** Whether the server runs this phase itself (instead of a runner command). */
export const isServerPhase = (id: string, phase: string): boolean =>
  !!phase && (releaseDocsPrepStep(id)?.serverPhases ?? []).includes(phase);

/** Index of a phase in its step (for ordering); unknown phases sort last. */
export const stepPhaseIndex = (id: string, phase: string): number => {
  const i = stepPhases(id).indexOf(phase);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

export interface ReleaseDocsPrepSettings {
  enabled: boolean;
  steps: Record<string, boolean>;
  /** Repository id to its user guide path (normalised); absent: the default. */
  guidePaths?: Record<string, string>;
}

export const DEFAULT_RELEASE_DOCS_PREP: ReleaseDocsPrepSettings = { enabled: false, steps: {} };

/** The registered steps that are ticked (an unticked-by-default registry entry follows `defaultOn`). */
export const enabledReleaseDocsPrepSteps = (
  settings: Pick<ReleaseDocsPrepSettings, 'steps'>,
): ReleaseDocsPrepStepDef[] => releaseDocsPrepSteps().filter((s) => settings.steps[s.id] ?? s.defaultOn);

/** The first enabled step whose required step is off, with the sentence to show; null when the set is complete. */
export function missingReleaseDocsPrepRequirement(
  steps: readonly ReleaseDocsPrepStepDef[],
): { step: string; requires: string; message: string } | null {
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps)
    for (const r of s.requires ?? [])
      if (!ids.has(r)) {
        const label = releaseDocsPrepStep(r)?.label ?? r;
        return {
          step: s.id,
          requires: r,
          message: `${s.label} needs ${label}. Turn it on in the project settings.`,
        };
      }
  return null;
}

export type ReleaseDocsPrepRunStatus = 'running' | 'passed' | 'failed' | 'skipped';
export type ReleaseDocsPrepStepState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
/** What the Releases page shows. */
export type ReleaseDocsPrepState = 'off' | 'not_run' | ReleaseDocsPrepRunStatus;

const STEP_NEXT: Record<ReleaseDocsPrepStepState, ReleaseDocsPrepStepState[]> = {
  pending: ['running', 'skipped'],
  running: ['passed', 'failed', 'skipped'],
  passed: [],
  failed: [],
  skipped: [],
};

export const canTransitionStep = (from: ReleaseDocsPrepStepState, to: ReleaseDocsPrepStepState): boolean =>
  STEP_NEXT[from].includes(to);

const RUN_NEXT: Record<ReleaseDocsPrepRunStatus | 'not_run', ReleaseDocsPrepRunStatus[]> = {
  not_run: ['running', 'skipped'],
  running: ['passed', 'failed', 'skipped'],
  failed: ['skipped'],
  passed: [],
  skipped: [],
};

export const canTransitionRun = (
  from: ReleaseDocsPrepRunStatus | 'not_run',
  to: ReleaseDocsPrepRunStatus,
): boolean => RUN_NEXT[from].includes(to);

export type CommitPhase = 'prepare' | 'push';

export interface RunSnapshotRepo {
  repoId: string;
  repoName?: string;
  /** `skipped` when the release branch does not exist on origin: skipped for every later step. */
  state: ReleaseDocsPrepStepState;
  /** The steps of this repo by `step` (and `phase` for a step with phases). */
  steps: { step: string; phase?: string; state: ReleaseDocsPrepStepState; error?: string | null }[];
}

export interface RunSnapshot {
  status: ReleaseDocsPrepRunStatus;
  /** Frozen at the start, in registry order. */
  steps: string[];
  repos: RunSnapshotRepo[];
}

export type ReleaseDocsPrepAction =
  | { kind: 'dispatch'; step: string; phase?: string; repoIds: string[]; by?: 'server' }
  /** An earlier phase of this step was skipped in these repos: the later phase is skipped too, with the same note. */
  | { kind: 'skip'; step: string; phase: string; repoIds: string[]; notes: Record<string, string> }
  | { kind: 'wait' }
  | { kind: 'finish'; status: 'passed' }
  | { kind: 'finish'; status: 'failed'; step: string; repoId: string; error: string };

const stepRowOf = (r: RunSnapshotRepo, step: string, phase = '') =>
  r.steps.find((s) => s.step === step && (s.phase ?? '') === phase);

const stepStateOf = (r: RunSnapshotRepo, step: string, phase = ''): ReleaseDocsPrepStepState =>
  stepRowOf(r, step, phase)?.state ?? 'pending';

/**
 * What to do next for a run. The first step (in run order) that is not finished in every active repo is dispatched to
 * the repos that have not started it; any failed repo ends the run as failed (the later steps stay pending, so nothing
 * is committed). A step with phases runs each phase in every repo before the next (`commit`: `prepare`, then `push`).
 * When the first phase of a step was skipped in a repo, its later phases are skipped there too (`skip`), with its note.
 */
export function nextReleaseDocsPrepAction(run: RunSnapshot): ReleaseDocsPrepAction {
  if (run.status !== 'running') return { kind: 'wait' };
  const active = run.repos.filter((r) => r.state !== 'skipped');
  for (const r of active) {
    const failed = r.steps.find((s) => s.state === 'failed');
    if (failed)
      return {
        kind: 'finish',
        status: 'failed',
        step: failed.step,
        repoId: r.repoId,
        error: failed.error?.trim() || `${failed.step} failed`,
      };
  }
  for (const step of run.steps) {
    const phases = stepPhases(step);
    for (const [k, phase] of phases.entries()) {
      const states = active.map((r) => stepStateOf(r, step, phase));
      if (states.some((s) => s === 'running')) return { kind: 'wait' };
      const todo = active.filter((r) => stepStateOf(r, step, phase) === 'pending');
      if (todo.length === 0) continue;
      const notes: Record<string, string> = {};
      // Only the first phase decides that a step does not apply to a repo (videos: no harness). A later phase that had
      // nothing to do (videos author: no new videos) is skipped on its own and does not skip the phases after it.
      const first = phases[0] ?? '';
      if (k > 0)
        for (const r of todo) {
          const row = stepRowOf(r, step, first);
          if (row?.state === 'skipped') notes[r.repoId] = row.error?.trim() || `${step} skipped`;
        }
      const skipIds = Object.keys(notes);
      if (skipIds.length > 0) return { kind: 'skip', step, phase, repoIds: skipIds, notes };
      return {
        kind: 'dispatch',
        step,
        ...(phase ? { phase } : {}),
        repoIds: todo.map((r) => r.repoId),
        ...(isServerPhase(step, phase) ? { by: 'server' as const } : {}),
      };
    }
  }
  return { kind: 'finish', status: 'passed' };
}

const RELEASE_DOCS_PREP_NAME = 'Release prep (docs and videos)';

export interface ReleaseDocsPrepGateInput {
  enabled: boolean;
  releaseBranch: string;
  /** The latest run for (project, release branch). */
  run: {
    id: string;
    status: ReleaseDocsPrepRunStatus;
    startedAt: string;
    failedStep?: string | null;
    failedRepoName?: string | null;
  } | null;
  repo: { inRun: boolean; baseTag: string | null; commitSha: string | null; analysed?: boolean } | null;
  /** Newest published ship of this repository. */
  lastPublishedAt: string | null;
  proposalLastTag: string | null;
  facts: { headSha: string; commitShas: string[]; truncated: boolean } | null;
}

export type ReleaseDocsPrepGateResult =
  | { allowed: true }
  | { allowed: false; code: 'release_docs_prep_required'; message: string };

const refuse = (message: string): ReleaseDocsPrepGateResult => ({
  allowed: false,
  code: 'release_docs_prep_required',
  message,
});

/**
 * The ship gate. Off: allowed. On: a run for this release must have passed (with its commit in the facts read) or have
 * been skipped by the owner or an admin.
 */
export function releaseDocsPrepGate(i: ReleaseDocsPrepGateInput): ReleaseDocsPrepGateResult {
  if (!i.enabled) return { allowed: true };
  const b = i.releaseBranch;
  const name = RELEASE_DOCS_PREP_NAME;
  const stale =
    i.run && i.lastPublishedAt && new Date(i.run.startedAt).getTime() < new Date(i.lastPublishedAt).getTime();
  if (!i.run || stale) return refuse(`${name} has not run for ${b}. Run it on the Releases page first.`);
  if (i.run.status === 'running')
    return refuse(`${name} is still running for ${b}. Wait for it to finish on the Releases page.`);
  if (i.run.status === 'failed')
    return refuse(
      `${name} failed${i.run.failedStep ? ` at ${i.run.failedStep}` : ''}${i.run.failedRepoName ? ` in ${i.run.failedRepoName}` : ''}: Retry or Skip it on the Releases page.`,
    );
  if (i.run.status === 'skipped') return { allowed: true };
  // passed
  if (!i.repo?.inRun)
    return refuse(`${name} ran for ${b} without this repository. Run it again on the Releases page.`);
  // The base tag is recorded by the analyse step only; without it the staleness rule above is what ties the run to this release.
  if (i.repo.analysed !== false && i.repo.baseTag !== i.proposalLastTag)
    return refuse(`${name} ran for an earlier release of ${b}. Run it again on the Releases page.`);
  const sha = i.repo.commitSha;
  if (sha) {
    const f = i.facts;
    const seen = !!f && (f.headSha === sha || f.commitShas.includes(sha) || f.truncated);
    if (!seen)
      return refuse(
        `${name} committed to ${b}, but its commit is not in the repository read yet: press Refresh on the Ship release item.`,
      );
  }
  return { allowed: true };
}
