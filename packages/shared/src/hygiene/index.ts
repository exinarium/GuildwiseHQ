import { z } from 'zod';
import { isSafeGitRef } from '../safe.ts';

/**
 * Repository hygiene and the working branch (docs/design/phases.md, "DevOps repository hygiene and the working branch"
 * and "Worktree and branch cleanup once work is merged"). Contract shared by the server, the runner and the web app:
 * the sweep of stale worktrees, the hygiene request a workstation's DevOps engineer receives, its structured report,
 * and the desk question that confirms a repository's working branch.
 */

// ------------------------------------------------------------------------------------------- runner-owned branches

/** Branch name prefixes the runner creates for itself (saved work, conflict attempts, integration branches). */
export const RUNNER_OWNED_BRANCH_PREFIXES = ['guildwise/saved-work/', 'conflict/', 'aom-integration/'] as const;
/** Agent card branches (the default branch prefix; a project can choose another one). */
export const CARD_BRANCH_PREFIX = 'aom/';

/** A branch the runner owns: never the agent's doing, never a candidate working branch. */
export const isRunnerOwnedBranch = (name: string): boolean =>
  RUNNER_OWNED_BRANCH_PREFIXES.some((p) => name.startsWith(p));

/** A branch that is not a sensible working branch: runner-owned, or an agent card branch (`aom/`). */
export const isNotWorkingBranchCandidate = (name: string): boolean =>
  isRunnerOwnedBranch(name) || name.startsWith(CARD_BRANCH_PREFIX);

// ------------------------------------------------------------------------------------------- cadence

/** Hours between two scheduled hygiene runs of a workstation; 0 turns the schedule off. Owner decision 1: daily. */
export const HYGIENE_CADENCES_HOURS = [0, 1, 6, 12, 24, 168] as const;
export const DEFAULT_HYGIENE_HOURS = 24;
export const HygieneHoursSchema = z
  .number()
  .int()
  .refine((n) => (HYGIENE_CADENCES_HOURS as readonly number[]).includes(n), {
    message: `hours between runs: one of ${HYGIENE_CADENCES_HOURS.join(', ')} (0 = off)`,
  });

export const hygieneCadenceLabel = (hours: number): string =>
  hours === 0
    ? 'Off'
    : hours === 1
      ? 'Every hour'
      : hours === 24
        ? 'Daily'
        : hours === 168
          ? 'Weekly'
          : `Every ${hours} hours`;

export const UpdateHygieneRequestSchema = z.object({ intervalHours: HygieneHoursSchema });
export type UpdateHygieneRequest = z.infer<typeof UpdateHygieneRequestSchema>;

/** `POST /api/workstations/:id/hygiene/run` */
export const RunHygieneResponseSchema = z.object({
  requestId: z.uuid(),
  /** True when a hygiene run of this workstation was already queued or running (no second one is started). */
  alreadyRunning: z.boolean(),
});
export type RunHygieneResponse = z.infer<typeof RunHygieneResponseSchema>;

// -------------------------------------------------------------------------------------- worktree sweep

/** Runner -> server (`worktrees.query`): which of these card worktrees still belong to a live card? */
export const SWEEP_QUERY_MAX_PATHS = 2000;

export const WorktreeSweepResultSchema = z.object({
  /** Why nothing was swept (server unreachable, messages still in the outbox, ...). */
  skipped: z.string().optional(),
  scanned: z.number().int().nonnegative().default(0),
  /** Worktrees of live cards (or of a running shift), left alone. */
  kept: z.number().int().nonnegative().default(0),
  removed: z.array(z.string()).default([]),
  /** Dead card, uncommitted changes: reported and not deleted. */
  dirty: z
    .array(z.object({ path: z.string(), branch: z.string().nullable(), files: z.array(z.string()) }))
    .default([]),
  emptyDirsRemoved: z.array(z.string()).default([]),
  /** Repositories `git worktree prune` ran in. */
  pruned: z.number().int().nonnegative().default(0),
});
export type WorktreeSweepResult = z.infer<typeof WorktreeSweepResultSchema>;

export const WorktreesSweepPayloadSchema = z.object({
  /** The hygiene request the sweep belongs to (its result is posted on the request's thread). */
  requestId: z.uuid().optional(),
});
export type WorktreesSweepPayload = z.infer<typeof WorktreesSweepPayloadSchema>;

export function summarizeSweep(r: WorktreeSweepResult): string {
  if (r.skipped) return `Worktree sweep skipped: ${r.skipped}.`;
  const parts = [
    `${r.removed.length} stale worktree${r.removed.length === 1 ? '' : 's'} removed`,
    `${r.kept} kept`,
    ...(r.emptyDirsRemoved.length ? [`${r.emptyDirsRemoved.length} empty folder(s) removed`] : []),
    ...(r.dirty.length ? [`${r.dirty.length} with uncommitted changes left in place`] : []),
  ];
  return `Worktree sweep: ${parts.join(', ')}.`;
}

// ------------------------------------------------------------------------------------- hygiene request

/** `branch_confirmed`: the manager just named the working branch of a repository with uncommitted changes. */
export const HygieneTrigger = z.enum(['schedule', 'manual', 'branch_confirmed']);
export type HygieneTrigger = z.infer<typeof HygieneTrigger>;

/** One project repository on the workstation, as the DevOps engineer receives it. */
export const HygieneRepoSpecSchema = z.object({
  /** `project_repos.id`. */
  repoId: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  name: z.string(),
  localPath: z.string(),
  remoteUrl: z.string(),
  /** The confirmed working branch; null while nobody confirmed one (nothing is committed or pushed then). */
  workingBranch: z.string().nullable(),
  /** Where `workingBranch` came from: the active phase, or the repository. */
  branchSource: z.enum(['phase', 'repo']).nullable(),
  phaseRef: z.string().optional(),
  /** The project's agent-branch prefix (`aom/`): only branches under it are ever deleted. */
  branchPrefix: z.string().default('aom/'),
  /** Branches of finished or cancelled cards: deleted locally when merged into the working branch. */
  finishedBranches: z.array(z.string()).default([]),
  /** The repository's main branch when the project named one (a branch whose patches are all there counts as migrated). */
  mainBranch: z.string().nullable().default(null),
  /**
   * Cards that are done or cancelled and whose branch hygiene may remove (empty when the project turned "Remove
   * finished card branches" off): from origin, the clone and the card's worktree, once the work is in the working
   * branch (merged or rebased/cherry-picked) or its pull request is merged (a declined one keeps a branch with unmerged commits).
   */
  finishedCards: z
    .array(
      z.object({
        cardId: z.uuid(),
        ref: z.string(),
        branch: z.string(),
        /** The pull request the card was finalized with, when it was one. */
        prUrl: z.string().optional(),
      }),
    )
    .default([]),
});
export type HygieneRepoSpec = z.infer<typeof HygieneRepoSpecSchema>;

export const HygieneSpecSchema = z.object({
  trigger: HygieneTrigger,
  repos: z.array(HygieneRepoSpecSchema),
});
export type HygieneSpec = z.infer<typeof HygieneSpecSchema>;

// -------------------------------------------------------------------------------------- hygiene report

export const HygieneProblemKind = z.enum([
  'needs_branch',
  'dirty_other_branch',
  'conflict',
  'auth_failed',
  'missing',
  'branch_missing',
  'error',
]);
export type HygieneProblemKind = z.infer<typeof HygieneProblemKind>;

export const HYGIENE_PROBLEM_LABEL: Record<HygieneProblemKind, string> = {
  needs_branch: 'Working branch not confirmed',
  dirty_other_branch: 'Uncommitted changes on another branch',
  conflict: 'Conflict while updating',
  auth_failed: 'Authentication failed',
  missing: 'Clone not found',
  branch_missing: 'Working branch not found',
  error: 'Git error',
};

export const HygieneRepoResultSchema = z.object({
  repoId: z.uuid(),
  /** What was done, one line each ("fetched", "committed 3 files on main (abc1234)", "pushed main"). */
  actions: z.array(z.string()).default([]),
  /** What could not be resolved; null: the repository is in order. */
  problem: z.object({ kind: HygieneProblemKind, detail: z.string() }).nullable().default(null),
  /** The branches that exist in the clone (local and origin, agent branches left out): the question's options. */
  branches: z.array(z.string()).default([]),
  /** Paths with uncommitted changes that were reported and not committed (first 50). */
  uncommitted: z.array(z.string()).default([]),
  commit: z.string().optional(),
  pushed: z.boolean().default(false),
  removedBranches: z.array(z.string()).default([]),
  /** Card branches removed because the card is finished and its work is elsewhere; one entry per branch. */
  cleaned: z
    .array(
      z.object({
        cardId: z.uuid(),
        ref: z.string(),
        branch: z.string(),
        /** Why it was safe: "merged into pieter/dev", "all commits already in ...", "pull request merged". */
        reason: z.string(),
        origin: z.boolean().default(false),
        local: z.boolean().default(false),
        worktree: z.boolean().default(false),
      }),
    )
    .default([]),
  /** The user's uncommitted edits were stored on this branch (and pushed when `pushed`); their checkout is untouched. */
  savedWork: z
    .object({
      branch: z.string(),
      files: z.array(z.string()).default([]),
      /** Left out because they look like secrets (`.env*`, `*.pem`, `*key*` ...). */
      skipped: z.array(z.string()).default([]),
      pushed: z.boolean().default(false),
    })
    .optional(),
  /**
   * The remote force-updated the working branch (commits were dropped) and the local branch was realigned to it.
   * `commits` are local commits that were never on the remote ("<sha> <subject>"), kept on `savedBranch`.
   */
  rewritten: z
    .object({
      branch: z.string(),
      realigned: z.boolean().default(true),
      savedBranch: z.string().optional(),
      commits: z.array(z.string()).default([]),
      pushed: z.boolean().default(false),
    })
    .optional(),
});
export type HygieneRepoResult = z.infer<typeof HygieneRepoResultSchema>;

export const HygieneReportSchema = z.object({ repos: z.array(HygieneRepoResultSchema) });
export type HygieneReport = z.infer<typeof HygieneReportSchema>;

/** The request text a hygiene run shows on its thread and to the DevOps engineer. */
export function renderHygieneRequest(spec: HygieneSpec, workstationName: string): string {
  const lines = [
    `Repository hygiene on ${workstationName} (${spec.trigger === 'schedule' ? 'scheduled' : spec.trigger === 'branch_confirmed' ? 'the working branch was just confirmed' : 'started by the manager'}).`,
    '',
    'For each repository below: fetch and pull, store uncommitted edits on a saved-work branch and push that (secret-looking files are skipped; nothing lands on the working branch), push unpushed commits, and remove merged branches of finished cards. Run `aom hygiene run`: it does exactly that, refuses to commit or push to a repository whose working branch is not confirmed, logs what it did and ends this request.',
    '',
    ...spec.repos.map(
      (r) =>
        `- ${r.projectKey} ${r.name}: ${r.localPath} (remote ${r.remoteUrl}), working branch ${r.workingBranch ?? 'NOT CONFIRMED'}${r.branchSource === 'phase' ? ` (phase ${r.phaseRef ?? ''})` : ''}`,
    ),
  ];
  return lines.join('\n');
}

// -------------------------------------------------------------------------------- working-branch question

export const WORKING_BRANCH_SUBKIND = 'working_branch';
/** The "name another branch" option of the question; the answer text is then the branch name. */
export const WORKING_BRANCH_OTHER_OPTION = 'other';
export const WORKING_BRANCH_KEEP_OPTION = 'keep';
export const branchOptionId = (branch: string): string => `branch:${branch}`;

/** `repo.working_branch` is changed by this event's command; why the question was asked. */
export const WorkingBranchReason = z.enum(['unconfirmed', 'phase', 'intake', 'manual', 'conversion']);
export type WorkingBranchReason = z.infer<typeof WorkingBranchReason>;

/** A working branch name the manager typed or picked: a safe git ref. */
export function parseBranchName(raw: string): string | null {
  const b = raw.trim();
  return b && isSafeGitRef(b) ? b : null;
}

/** `PUT /api/projects/:id/repos/:repoId/working-branch` */
export const SetWorkingBranchRequestSchema = z.object({
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((b) => isSafeGitRef(b), { message: 'not a valid branch name' }),
});
export type SetWorkingBranchRequest = z.infer<typeof SetWorkingBranchRequestSchema>;

export const hygieneProblemTitle = (kind: HygieneProblemKind, repo: string): string =>
  `${HYGIENE_PROBLEM_LABEL[kind]}: ${repo}`;
