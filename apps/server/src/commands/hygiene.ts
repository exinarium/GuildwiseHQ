import { randomUUID } from 'node:crypto';
import {
  branchOptionId,
  type DeskOption,
  type HygieneReport,
  type HygieneRepoSpec,
  type HygieneSpec,
  type HygieneTrigger,
  PHASE_ASSIGNABLE_STATUSES,
  parseBranchName,
  RESEARCH_STAGE_WORKFLOW,
  renderHygieneRequest,
  streamId,
  summarizeSweep,
  WORKING_BRANCH_KEEP_OPTION,
  WORKING_BRANCH_OTHER_OPTION,
  WORKING_BRANCH_SUBKIND,
  type WorkingBranchReason,
  type WorktreeSweepResult,
  WorktreeSweepResultSchema,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR, userActor, userScope } from './common.ts';
import { createDevOpsRequestIn, threadMessage } from './devops.ts';
import { userBy } from './phase-events.ts';

/** Phases whose own working branch the hygiene job uses: the phase is not over (nor discarded). */
const ACTIVE_PHASE = `('open','reporting','awaiting_approval','running_followups','reporting_results')`;
const MAX_REQUEST_REPOS = 60;
const MAX_FINISHED_BRANCHES = 200;
const MAX_OPTIONS = 30;

const HAS_DEVOPS = `EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.is_devops AND a.status = 'active')`;

// ------------------------------------------------------------------------------------------------ the spec

/** The working branch hygiene uses for a repository: the active phase's, else the repository's, else none (unconfirmed). */
export async function effectiveWorkingBranch(
  db: Queryable,
  projectId: string,
  repoBranch: string | null,
): Promise<{ branch: string | null; source: 'phase' | 'repo' | null; phaseRef?: string }> {
  const phase = await one(
    db,
    `SELECT ref, working_branch FROM phases
      WHERE project_id=$1 AND working_branch IS NOT NULL AND status IN ${ACTIVE_PHASE}
      ORDER BY number DESC LIMIT 1`,
    [projectId],
  );
  if (phase) return { branch: phase.working_branch, source: 'phase', phaseRef: phase.ref };
  if (repoBranch) return { branch: repoBranch, source: 'repo' };
  return { branch: null, source: null };
}

/** The repositories of a workstation's projects as the hygiene job receives them (owner decision 1). */
export async function hygieneSpecFor(
  db: Queryable,
  workstationId: string,
  trigger: HygieneTrigger,
): Promise<HygieneSpec> {
  const list = await rows(
    db,
    `SELECT wr.local_path, r.id AS repo_id, r.name, r.remote_url, r.working_branch AS repo_branch,
            p.id AS project_id, p.key AS project_key, p.name AS project_name, p.branch_prefix
       FROM workstation_repos wr
       JOIN project_repos r ON r.id = wr.project_repo_id AND r.removed_at IS NULL
       JOIN projects p ON p.id = r.project_id AND p.status = 'active' AND p.workflow_key <> '${RESEARCH_STAGE_WORKFLOW}'
      WHERE wr.workstation_id = $1 ORDER BY p.key, r.name, r.id LIMIT ${MAX_REQUEST_REPOS}`,
    [workstationId],
  );
  const repos: HygieneRepoSpec[] = [];
  for (const r of list) {
    const eff = await effectiveWorkingBranch(db, r.project_id, r.repo_branch);
    const finished = await rows<{ branch_name: string }>(
      db,
      `SELECT branch_name FROM (
         SELECT branch_name, max(updated_at) AS at FROM cards
          WHERE project_id=$1 AND (repo_id = $2 OR repo_id IS NULL) AND status IN ('done','cancelled')
            AND branch_name IS NOT NULL GROUP BY branch_name) b
        ORDER BY at DESC LIMIT ${MAX_FINISHED_BRANCHES}`,
      [r.project_id, r.repo_id],
    );
    repos.push({
      repoId: r.repo_id,
      projectId: r.project_id,
      projectKey: r.project_key,
      projectName: r.project_name,
      name: r.name,
      localPath: r.local_path,
      remoteUrl: r.remote_url,
      workingBranch: eff.branch,
      branchSource: eff.source,
      ...(eff.phaseRef ? { phaseRef: eff.phaseRef } : {}),
      branchPrefix: r.branch_prefix,
      finishedBranches: finished.map((f) => f.branch_name),
    });
  }
  return { trigger, repos };
}

// ----------------------------------------------------------------------------------------------- requests

export interface HygieneRequested {
  requestId: string;
  alreadyRunning: boolean;
}

/**
 * Creates the DevOps request of a hygiene run for a workstation (and queues the runner's worktree sweep). One at a time:
 * while one is queued, running or waiting for approval, that one is returned. Null: the workstation holds no project
 * repository (nothing to do). The caller delivers the runner commands afterwards.
 */
export async function requestHygiene(
  ctx: Ctx,
  tx: Tx,
  input: {
    workstationId: string;
    trigger: HygieneTrigger;
    requestedBy: { kind: 'user' | 'system'; id: string | null; name?: string };
  },
): Promise<HygieneRequested | null> {
  const open = await one(
    tx,
    `SELECT id FROM devops_requests
      WHERE workstation_id=$1 AND hygiene IS NOT NULL AND status IN ('queued','running','needs_approval')
      ORDER BY created_at DESC LIMIT 1`,
    [input.workstationId],
  );
  if (open) return { requestId: open.id, alreadyRunning: true };
  const ws = await one(tx, `SELECT name FROM workstations WHERE id=$1 AND status='active'`, [
    input.workstationId,
  ]);
  if (!ws) throw notFound('workstation not found');
  const spec = await hygieneSpecFor(tx, input.workstationId, input.trigger);
  if (spec.repos.length === 0) return null;
  const { requestId } = await createDevOpsRequestIn(ctx, tx, {
    workstationId: input.workstationId,
    summary: renderHygieneRequest(spec, ws.name),
    requestedBy: input.requestedBy,
    hygiene: spec,
  });
  await enqueueRunnerCommand(tx, input.workstationId, 'worktrees.sweep', { requestId });
  return { requestId, alreadyRunning: false };
}

async function afterRequest(ctx: Ctx, workstationIds: string[]): Promise<void> {
  ctx.services.dispatcher.trigger();
  for (const id of workstationIds) await ctx.services.gateway.deliverPending(id);
}

/** "Run hygiene now" (the workstation's owner). */
export async function runHygieneNow(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<HygieneRequested> {
  const r = await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(
      tx,
      `SELECT w.user_id, ${HAS_DEVOPS} AS has_devops FROM workstations w WHERE w.id=$1 AND w.status='active'`,
      [workstationId],
    );
    if (!ws || ws.user_id !== user.id) throw notFound('workstation not found');
    if (!ws.has_devops) throw conflict('no_devops_agent', 'this workstation has no DevOps engineer');
    const res = await requestHygiene(ctx, tx, {
      workstationId,
      trigger: 'manual',
      requestedBy: { kind: 'user', id: user.id, name: user.displayName },
    });
    if (!res)
      throw conflict(
        'no_repositories',
        'this workstation holds no clone of a project repository, so there is nothing to tidy',
      );
    return res;
  });
  if (!r.alreadyRunning) await afterRequest(ctx, [workstationId]);
  return r;
}

export async function setHygieneInterval(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  intervalHours: number,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT user_id FROM workstations WHERE id=$1 AND status='active'`, [
      workstationId,
    ]);
    if (!ws || ws.user_id !== user.id) throw notFound('workstation not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(workstationId),
          event: {
            type: 'WorkstationHygieneChanged',
            payload: { workstationId, intervalHours, changedBy: user.id },
          },
          actor: userActor(user.id),
          scope: userScope(user.id),
        },
      ],
      { tx },
    );
  });
}

/**
 * The scheduled job: every active workstation with a DevOps engineer whose last hygiene run (or pairing) is more than its
 * cadence ago gets one hygiene request. Returns the requests it created.
 */
export async function fireDueHygiene(ctx: Ctx): Promise<string[]> {
  const now = ctx.clock.now();
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT w.id FROM workstations w
      WHERE w.status = 'active' AND w.hygiene_interval_hours > 0 AND ${HAS_DEVOPS}
        AND EXISTS (SELECT 1 FROM agents a JOIN organizations o ON o.id = a.org_id AND o.status IN ('trial','active')
                     WHERE a.workstation_id = w.id AND a.is_devops AND a.status = 'active')
        AND COALESCE(w.hygiene_last_at, w.paired_at) + make_interval(hours => w.hygiene_interval_hours) <= $1
      ORDER BY w.id`,
    [now],
  );
  const created: string[] = [];
  const touched: string[] = [];
  for (const w of due) {
    try {
      const r = await withAppendTx(ctx.pool, (tx) =>
        requestHygiene(ctx, tx, {
          workstationId: w.id,
          trigger: 'schedule',
          requestedBy: { kind: 'system', id: null, name: 'Repository hygiene' },
        }),
      );
      if (r && !r.alreadyRunning) {
        created.push(r.requestId);
        touched.push(w.id);
      }
    } catch (err) {
      ctx.log.warn({ err, workstationId: w.id }, 'scheduled hygiene request failed');
    }
  }
  if (touched.length) await afterRequest(ctx, touched);
  return created;
}

// ------------------------------------------------------------------------------- the working-branch question

/** The DevOps engineer that asks the question: the project owner's, on any workstation (none: the system asks). */
async function askerOf(db: Queryable, project: Row, preferAgentId?: string | null) {
  if (preferAgentId) return { kind: 'agent' as const, agentId: preferAgentId, role: 'devops' };
  const a = await one(
    db,
    `SELECT id FROM agents WHERE org_id=$1 AND is_devops AND status='active' ORDER BY hired_at, id LIMIT 1`,
    [project.org_id],
  );
  return a
    ? { kind: 'agent' as const, agentId: a.id as string, role: 'devops' }
    : { kind: 'system' as const };
}

export interface BranchQuestion {
  reason: WorkingBranchReason;
  /** Branches the clone has (hygiene), else the ones the last run saw. */
  branches?: string[];
  /** Paths with uncommitted changes the missing branch is holding back. */
  uncommitted?: string[];
  /** The DevOps agent whose shift found it (default: the project owner's DevOps engineer). */
  agentId?: string | null;
  /** What triggered it, for the explanation ("phase WEB-P2", "a new intake"). */
  because?: string;
  phaseId?: string;
  /**
   * The runner turned a card away because this branch does not exist in the clone: the question is linked to the card
   * and says what is wrong (the system asks and it is pinned, so it reaches the manager without the BA's triage hold);
   * the card stays queued, retried with a growing pause. `defaultBranch` is the repository's own.
   */
  missing?: { base: string; defaultBranch?: string | null; cardId: string; cardRef: string };
}

/**
 * `QuestionRaised` that confirms a repository's working branch, or nothing when one is already open for the repository.
 * Unconfirmed repository: options are its branches plus "another branch". Confirmed: keep it, pick another, or name one.
 * Blocking (pinned, straight to the manager) only when the missing branch holds back a commit; otherwise non-urgent and
 * held for the BA's triage like other non-urgent items (the routing interceptor).
 */
export async function workingBranchQuestionEvents(
  ctx: Ctx,
  tx: Queryable,
  project: Row,
  repo: Row,
  q: BranchQuestion,
): Promise<AppendInput[]> {
  const open = await one(
    tx,
    `SELECT 1 FROM desk_items WHERE subkind=$1 AND status='open' AND data->>'repoId' = $2 LIMIT 1`,
    [WORKING_BRANCH_SUBKIND, repo.id],
  );
  if (open) return [];
  const current: string | null = repo.working_branch ?? null;
  const known: string[] = q.branches?.length ? q.branches : (repo.known_branches ?? []);
  // "Keep" makes no sense for a branch that does not exist.
  const keep = current && !q.missing ? current : null;
  const branches = [...new Set(known)].filter((b) => b !== keep).slice(0, MAX_OPTIONS);
  // The suggested answer: the repository's default branch when known, else the only branch there is.
  const defaultBranch = q.missing?.defaultBranch ?? null;
  const suggested = defaultBranch ?? (branches.length === 1 ? (branches[0] as string) : null);
  if (suggested && suggested !== keep && !branches.includes(suggested)) branches.unshift(suggested);
  const options: DeskOption[] = [
    ...(keep ? [{ id: WORKING_BRANCH_KEEP_OPTION, label: `Keep ${keep}`, description: 'No change.' }] : []),
    ...branches.map((b) => ({
      id: branchOptionId(b),
      label: b,
      ...(b === suggested
        ? { description: defaultBranch === b ? "The repository's default branch." : 'The only branch.' }
        : {}),
    })),
    {
      id: WORKING_BRANCH_OTHER_OPTION,
      label: 'Another branch',
      description: 'Name it when you answer.',
    },
  ];
  const uncommitted = q.uncommitted ?? [];
  const blocking = !current && uncommitted.length > 0;
  const where = `${repo.name} (${project.key})`;
  const title = q.missing
    ? `Working branch '${q.missing.base}' does not exist in ${where}${defaultBranch ? ` (its default branch is ${defaultBranch})` : ''}: which branch should it be?`
    : current
      ? `Keep ${current} as the working branch of ${where}${q.because ? ` for ${q.because}` : ''}, or use another branch?`
      : `Which branch is the working branch of ${where}?`;
  const doing = q.missing
    ? `The runner could not start ${q.missing.cardRef}: working branch '${q.missing.base}' does not exist in this repo${defaultBranch ? `; its default branch is '${defaultBranch}'` : ''}. Cards on this repository are retried with a growing pause until the branch is set.`
    : current
      ? `Confirming the working branch of ${where}${q.because ? ` because of ${q.because}` : ''}. Hygiene commits and pushes unsaved work to this branch and agents merge their cards into it.${q.reason === 'phase' ? ' A branch you name here applies to this phase only; the repository keeps its default and uses it again when the phase is done.' : ''}`
      : `Repository hygiene found no confirmed working branch for ${where}, so it did not commit or push anything. ${
          uncommitted.length
            ? `${uncommitted.length} file(s) have uncommitted changes (${uncommitted.slice(0, 8).join(', ')}${uncommitted.length > 8 ? ', ...' : ''}); they stay untouched until you answer.`
            : 'Nothing is waiting to be committed.'
        } Pick the branch hygiene should commit to and push, or name another one.`;
  const deskItemId = randomUUID();
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId,
          projectId: project.id,
          askedBy: q.missing ? { kind: 'system' as const } : await askerOf(tx, project, q.agentId),
          doing,
          question: title,
          options,
          ...(keep
            ? { recommendation: WORKING_BRANCH_KEEP_OPTION }
            : suggested
              ? { recommendation: branchOptionId(suggested) }
              : {}),
          ...(q.missing ? { cardId: q.missing.cardId } : {}),
          blocking,
          routedTo: 'manager',
          chainLevel: 'desk',
          dedupLedgerIds: [],
          affectedCardIds: q.missing ? [q.missing.cardId] : [],
          pinned: blocking || !!q.missing,
          subkind: WORKING_BRANCH_SUBKIND,
          data: {
            repoId: repo.id,
            reason: q.reason,
            ...(current ? { current } : {}),
            ...(q.phaseId ? { phaseId: q.phaseId } : {}),
          },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(project.org_id, project.id),
    },
  ];
}

/** The event that stores the confirmed branch (command side of the projection). */
export function workingBranchSetEvent(
  project: Row,
  repo: Row,
  branch: string,
  reason: WorkingBranchReason,
  userId: string,
  deskItemId?: string,
): AppendInput {
  return {
    streamId: streamId.project(project.id),
    event: {
      type: 'ProjectRepoWorkingBranchSet',
      payload: {
        projectId: project.id,
        repoId: repo.id,
        workingBranch: branch,
        previousBranch: repo.working_branch ?? null,
        reason,
        setBy: userId,
        ...(deskItemId ? { deskItemId } : {}),
      },
    },
    actor: userActor(userId),
    scope: projectScope(project.org_id, project.id),
  };
}

/** Project settings: the owner names the working branch of one repository ("Change"). */
export async function setRepoWorkingBranch(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  branch: string,
): Promise<void> {
  const name = parseBranchName(branch);
  if (!name) throw badRequest('invalid_branch', 'not a valid git branch name');
  const toDeliver = await withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, projectId);
    if (project.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const repo = await one(tx, 'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2 FOR UPDATE', [
      repoId,
      projectId,
    ]);
    if (!repo || repo.removed_at) throw notFound('repository not found');
    if (repo.working_branch === name) return [];
    await ctx.store.append([workingBranchSetEvent(project, repo, name, 'manual', user.id)], { tx });
    // The question about this repository (if one is open) is settled by the same answer.
    await settleOpenBranchQuestions(ctx, tx, repoId, user.id, `Set to ${name} in the project settings.`);
    return confirmedHygieneWorkstations(ctx, tx, repoId, !repo.working_branch);
  });
  if (toDeliver.length) await afterRequest(ctx, toDeliver);
}

/** Closes the open working-branch questions of a repository (the branch was set another way). */
async function settleOpenBranchQuestions(
  ctx: Ctx,
  tx: Tx,
  repoId: string,
  userId: string,
  note: string,
): Promise<void> {
  const items = await rows(
    tx,
    `SELECT id, org_id, project_id FROM desk_items WHERE subkind=$1 AND status='open' AND data->>'repoId' = $2 FOR UPDATE`,
    [WORKING_BRANCH_SUBKIND, repoId],
  );
  for (const item of items)
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(item.id),
          event: {
            type: 'DeskItemResolved',
            payload: { deskItemId: item.id, resolution: 'acknowledged', note, by: { kind: 'user', userId } },
          },
          actor: userActor(userId),
          scope: projectScope(item.org_id, item.project_id),
        },
      ],
      { tx },
    );
}

/**
 * After the answer committed: a branch was just confirmed for a repository that had none, so the workstations holding a clone run hygiene now, so the
 * work that was held back is committed and pushed without waiting for the next scheduled run.
 */
export async function runHygieneForConfirmedRepo(ctx: Ctx, repoId: string): Promise<void> {
  const ids = await withAppendTx(ctx.pool, (tx) => confirmedHygieneWorkstations(ctx, tx, repoId, true));
  if (ids.length) await afterRequest(ctx, ids);
}

async function confirmedHygieneWorkstations(
  ctx: Ctx,
  tx: Tx,
  repoId: string,
  wasUnconfirmed: boolean,
): Promise<string[]> {
  if (!wasUnconfirmed) return [];
  const ws = await rows<{ id: string; has_devops: boolean }>(
    tx,
    `SELECT w.id, ${HAS_DEVOPS} AS has_devops FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
      WHERE wr.project_repo_id=$1 AND w.status='active' ORDER BY w.id`,
    [repoId],
  );
  const out: string[] = [];
  for (const w of ws) {
    if (!w.has_devops) continue;
    const r = await requestHygiene(ctx, tx, {
      workstationId: w.id,
      trigger: 'branch_confirmed',
      requestedBy: { kind: 'system', id: null, name: 'Repository hygiene' },
    });
    if (r && !r.alreadyRunning) out.push(w.id);
  }
  return out;
}

/**
 * The answer to a working-branch question (called from `answerDeskItem`): the branch of the chosen option or the typed
 * name. Returns the event that stores it, and the workstations to run hygiene on right away.
 */
export async function workingBranchAnsweredEvents(
  tx: Tx,
  item: Row,
  user: AuthSession['user'],
  req: { answer: string; optionId?: string | undefined },
): Promise<{ events: AppendInput[]; hygieneForRepo: string | null }> {
  const data = (item.data ?? {}) as { repoId?: string; reason?: WorkingBranchReason; phaseId?: string };
  const repo = data.repoId
    ? await one(tx, 'SELECT * FROM project_repos WHERE id=$1 FOR UPDATE', [data.repoId])
    : undefined;
  const project = item.project_id
    ? await one(tx, 'SELECT * FROM projects WHERE id=$1', [item.project_id])
    : undefined;
  if (!repo || repo.removed_at || !project)
    throw conflict('repo_gone', 'the repository of this question no longer exists; dismiss the question');
  let branch: string | null = null;
  if (req.optionId?.startsWith('branch:')) branch = parseBranchName(req.optionId.slice('branch:'.length));
  else if (req.optionId === WORKING_BRANCH_KEEP_OPTION) branch = repo.working_branch ?? null;
  else if (req.optionId === WORKING_BRANCH_OTHER_OPTION || !req.optionId)
    branch = parseBranchName(req.answer);
  if (!branch)
    throw badRequest(
      'invalid_branch',
      req.optionId === WORKING_BRANCH_KEEP_OPTION
        ? 'there is no branch to keep: pick one or name one'
        : 'type the name of the branch (a valid git branch name)',
    );
  // A branch named while re-confirming for a phase belongs to that phase: the repository keeps its default, which
  // applies again once the phase is done. A repository with no default yet gets it set (hygiene needs one).
  const phase =
    data.reason === 'phase' && data.phaseId && repo.working_branch
      ? await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [data.phaseId])
      : undefined;
  if (phase) {
    const open = PHASE_ASSIGNABLE_STATUSES.includes(phase.status);
    const events: AppendInput[] =
      !open || branch === phase.working_branch || branch === repo.working_branch
        ? []
        : [
            {
              streamId: streamId.phase(phase.id),
              event: {
                type: 'PhaseUpdated',
                payload: { phaseId: phase.id, changes: { workingBranch: branch }, by: userBy(user.id) },
              },
              actor: userActor(user.id),
              scope: projectScope(project.org_id, project.id),
            },
          ];
    return { events, hygieneForRepo: null };
  }
  const events =
    branch === repo.working_branch
      ? []
      : [workingBranchSetEvent(project, repo, branch, data.reason ?? 'manual', user.id, item.id)];
  // A branch confirmed for a repository that had none: hygiene runs once the answer is committed.
  return { events, hygieneForRepo: events.length > 0 && !repo.working_branch ? (repo.id as string) : null };
}

// -------------------------------------------------------------------------------- applying a hygiene report

/**
 * `aom devops-done` of a hygiene request carried the structured report: store the findings (the BA reporter turns them
 * into signals) and ask the manager about every repository whose working branch is not confirmed.
 */
export async function hygieneReportEvents(
  ctx: Ctx,
  tx: Tx,
  req: Row,
  agentId: string,
  report: HygieneReport,
): Promise<AppendInput[]> {
  const spec = req.hygiene as HygieneSpec | null;
  if (!spec) return [];
  const byRepo = new Map(spec.repos.map((r) => [r.repoId, r]));
  const events: AppendInput[] = [];
  const reported = report.repos.filter((r) => byRepo.has(r.repoId));
  events.push({
    streamId: streamId.workstation(req.workstation_id),
    event: {
      type: 'HygieneRepoReported',
      payload: {
        requestId: req.id,
        workstationId: req.workstation_id,
        repos: reported.map((r) => ({
          repoId: r.repoId,
          projectId: (byRepo.get(r.repoId) as HygieneRepoSpec).projectId,
          name: (byRepo.get(r.repoId) as HygieneRepoSpec).name,
          problem: r.problem,
          files: r.uncommitted,
          branches: r.branches.slice(0, 200),
        })),
      },
    },
    actor: agentActor(agentId),
    scope: orgScope(req.org_id),
  });
  for (const r of reported) {
    if (r.problem?.kind !== 'needs_branch') continue;
    const repo = await one(tx, 'SELECT * FROM project_repos WHERE id=$1 AND removed_at IS NULL', [r.repoId]);
    const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [
      (byRepo.get(r.repoId) as HygieneRepoSpec).projectId,
    ]);
    // Confirmed in the meantime (or a phase names a branch now): nothing to ask.
    if (!repo || !project || repo.working_branch) continue;
    events.push(
      ...(await workingBranchQuestionEvents(ctx, tx, project, repo, {
        reason: 'unconfirmed',
        branches: r.branches,
        uncommitted: r.uncommitted,
        agentId,
      })),
    );
  }
  return events;
}

/** `command.result` of `worktrees.sweep`: what the runner removed, and the dead cards' worktrees it left alone. */
export async function applyWorktreeSweepResult(
  ctx: Ctx,
  workstationId: string,
  payload: { requestId?: string },
  ok: boolean,
  result: unknown,
): Promise<void> {
  const parsed = ok ? WorktreeSweepResultSchema.safeParse(result) : undefined;
  if (!parsed?.success) return;
  const r: WorktreeSweepResult = parsed.data;
  if (r.skipped) {
    // Nothing was swept; leave earlier findings as they are.
    await postSweepNote(ctx, workstationId, payload.requestId, r);
    return;
  }
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
  if (!ws) return;
  // The findings belong to the organization of the request that asked for the sweep, else to the machine owner's own.
  const asked = payload.requestId
    ? await one<{ org_id: string }>(ctx.pool, 'SELECT org_id FROM devops_requests WHERE id=$1', [
        payload.requestId,
      ])
    : undefined;
  const orgId =
    asked?.org_id ??
    (
      await one<{ org_id: string }>(
        ctx.pool,
        `SELECT org_id FROM org_members WHERE user_id=$1 AND status='active' ORDER BY joined_at LIMIT 1`,
        [ws.user_id],
      )
    )?.org_id;
  if (!orgId) return;
  await ctx.store.append([
    {
      streamId: streamId.workstation(workstationId),
      event: {
        type: 'WorktreeSweepReported',
        payload: {
          workstationId,
          ...(payload.requestId ? { requestId: payload.requestId } : {}),
          removed: r.removed.length,
          kept: r.kept,
          dirty: r.dirty,
        },
      },
      actor: { kind: 'runner', id: workstationId },
      scope: orgScope(orgId),
    },
  ]);
  await postSweepNote(ctx, workstationId, payload.requestId, r);
}

async function postSweepNote(
  ctx: Ctx,
  workstationId: string,
  requestId: string | undefined,
  r: WorktreeSweepResult,
): Promise<void> {
  if (!requestId) return;
  const req = await one(ctx.pool, 'SELECT org_id, thread_id FROM devops_requests WHERE id=$1', [requestId]);
  if (!req) return;
  const lines = [
    summarizeSweep(r),
    ...r.dirty.map(
      (d) => `- Not deleted (uncommitted changes): ${d.path}${d.branch ? ` on ${d.branch}` : ''}`,
    ),
  ];
  await ctx.store.append([
    threadMessage(req.thread_id, req.org_id, { kind: 'system' }, 'system', lines.join('\n'), {
      workstationId,
    }),
  ]);
}

// ----------------------------------------------------------------------------------------------- dto

export interface WorkstationHygieneDto {
  intervalHours: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRequestId: string | null;
  lastStatus: string | null;
  openFindings: number;
}

export async function hygieneDtos(
  db: Queryable,
  list: Array<{ id: string; hygiene_interval_hours: number; hygiene_last_at: Date | null; paired_at: Date }>,
): Promise<Map<string, WorkstationHygieneDto>> {
  const ids = list.map((w) => w.id);
  const last = await rows(
    db,
    `SELECT DISTINCT ON (workstation_id) workstation_id, id, status FROM devops_requests
      WHERE workstation_id = ANY($1::uuid[]) AND hygiene IS NOT NULL ORDER BY workstation_id, created_at DESC`,
    [ids],
  );
  const findings = await rows(
    db,
    `SELECT workstation_id, count(*)::int AS n FROM hygiene_findings
      WHERE workstation_id = ANY($1::uuid[]) AND status='open' GROUP BY workstation_id`,
    [ids],
  );
  const out = new Map<string, WorkstationHygieneDto>();
  for (const w of list) {
    const hours = w.hygiene_interval_hours;
    const base = w.hygiene_last_at ?? w.paired_at;
    out.set(w.id, {
      intervalHours: hours,
      lastRunAt: iso(w.hygiene_last_at),
      nextRunAt: hours > 0 ? new Date(base.getTime() + hours * 3600_000).toISOString() : null,
      lastRequestId: last.find((l) => l.workstation_id === w.id)?.id ?? null,
      lastStatus: last.find((l) => l.workstation_id === w.id)?.status ?? null,
      openFindings: findings.find((f) => f.workstation_id === w.id)?.n ?? 0,
    });
  }
  return out;
}
