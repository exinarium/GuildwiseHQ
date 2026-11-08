import { randomUUID } from 'node:crypto';
import {
  authorFailure,
  ChangelogProposalSchema,
  checkChangelogProposal,
  GuideProposalSchema,
  MAIN_ACCOUNT,
  PREP_OUTCOME,
  PREP_TASK_KINDS,
  type PrepWriterFailureCode,
  prepWriterUnavailable,
  RELEASE_PREP_MAX_SHIFT_MINUTES,
  type ReleasePrepTask,
  ReleaseDocsPrepSummarySchema,
  ReleasePrepTaskSchema,
  type RunnerToServerOf,
  releasePrepBriefOutcomes,
  type ServerToRunnerOf,
  type ShiftBrief,
  streamId,
  VideoStepReportSchema,
  withClientRefs,
  writableFilesFor,
} from '@aom/shared';
import { publicText } from '../blog/releases.ts';
import { effectiveAgentSkills } from '../capabilities/agent-skills.ts';
import { loadRole } from '../catalogue/loader.ts';
import { orgScope, projectScope, runnerActor, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { accountForAgent, loadProjectAccounts } from '../dispatcher/accounts.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { standingOrdersFor } from '../queries/ledger.ts';
import { accountOf, agentSpecFor, briefAgent } from '../runner-gateway/brief.ts';
import { changelogDenyList } from './docs-prep-changelog.ts';
import { changeListFor, changelogWriterInput, storedChangelogResult } from './docs-prep-writer.ts';

/**
 * Release prep tasks (design GWP-92 5.4/5.7, GWP-134): work inside a prep step that an agent does in a `release_prep`
 * shift. The server phase queues the tasks, `releasePrepTaskPass` gives them, one at a time per repository, to an agent
 * on the repository's workstation (the roles per task kind are in PREP_TASK_KINDS: this is the only place a writer is
 * chosen), and the shift's `aom prep done|fail` finishes them. A files task (videos) is checked and committed to the work
 * ref by the runner; a proposal task (changelog entries, guide edits) is checked by the runner and again by the server,
 * which stores the accepted proposal on the task. When the last task of a phase is finished the phase row is finished
 * and the run goes on.
 */

const ONLINE_WINDOW_MS = 45_000;
/** A task nobody could take within this time fails (the run must not wait forever on a busy or absent builder). */
export const RELEASE_PREP_QUEUE_LIMIT_MS = 2 * 3_600_000;
/** A shift that crashed or ended without a report counts; after this many the task fails. */
export const RELEASE_PREP_MAX_ATTEMPTS = 2;
/** Starts the workstation refused (or did not accept); after this many the task fails with the last reason. */
export const RELEASE_PREP_MAX_REJECTIONS = 3;
/** Rejections that say nothing about the task (the agent or its account is busy for now): requeued, never counted. */
const PASSING_REJECTIONS: ReadonlySet<string> = new Set(['busy', 'auth_expired', 'usage_limited']);

const runScope = (run: Row) => projectScope(run.org_id, run.project_id);
const runStream = (runId: string) => streamId.releaseDocsPrep(runId);

export const taskLabel = (task: ReleasePrepTask): string =>
  task.kind === 'new_video' ? task.slug : PREP_TASK_KINDS[task.kind].what(task);

/** The largest proposal stored on a task (serialised JSON). */
export const PROPOSAL_MAX_BYTES = 256 * 1024;

const WRITER_CODES: ReadonlySet<string> = new Set(['no_writer', 'writer_unreachable']);

/**
 * The error a phase row shows for a failed task: the one text of `prepWriterUnavailable`, whatever the step. A task that
 * failed because no agent could write it already carries that text in its note; a failure of the writer itself is worded here.
 */
export function taskFailureText(task: Row): string {
  const note = String(task.note ?? '').trim();
  if (WRITER_CODES.has(task.code)) return note;
  const parsed = ReleasePrepTaskSchema.safeParse(task.task);
  if (!parsed.success) return note || 'the task cannot be read';
  const t = parsed.data;
  if (t.kind === 'new_video') return authorFailure(t.slug, note || 'the agent gave no reason');
  return prepWriterUnavailable('writer_failed', t.kind, { reason: note || 'the agent gave no reason' });
}

/** Queue one task per entry (in order); the dispatcher pass gives them out. */
export async function queueReleasePrepTasks(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
  step: string,
  phase: string,
  attempt: number,
  tasks: ReleasePrepTask[],
): Promise<void> {
  const repo = await one(
    tx,
    'SELECT workstation_id FROM release_docs_prep_repos WHERE run_id=$1 AND repo_id=$2',
    [run.id, repoId],
  );
  if (!repo) return;
  await ctx.store.append(
    tasks.map((task, position) => ({
      streamId: runStream(run.id),
      event: {
        type: 'ReleaseDocsPrepTaskQueued' as const,
        payload: {
          taskId: randomUUID(),
          runId: run.id as string,
          repoId,
          step,
          phase,
          position,
          attempt,
          task,
          workstationId: repo.workstation_id as string,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: runScope(run),
    })),
    { tx },
  );
}

/** The tasks of one phase round. */
export async function phaseTasks(
  db: Queryable,
  runId: string,
  repoId: string,
  step: string,
  phase: string,
  attempt?: number,
): Promise<Row[]> {
  return rows(
    db,
    `SELECT * FROM release_docs_prep_tasks WHERE run_id=$1 AND repo_id=$2 AND step=$3 AND phase=$4
       AND ($5::int IS NULL OR attempt=$5) ORDER BY attempt, position, id`,
    [runId, repoId, step, phase, attempt ?? null],
  );
}

/** What finishing the last task of a phase writes on its row; the step module decides (videos: the authored slugs). */
export type PhaseTasksOutcome = {
  state: 'passed' | 'failed';
  error?: string;
  report?: Record<string, unknown>;
};
export type PhaseTasksFinisher = (
  tx: Queryable,
  run: Row,
  repoId: string,
  tasks: Row[],
) => Promise<PhaseTasksOutcome>;

const finishers = new Map<string, PhaseTasksFinisher>();
/** Registered by the step modules (`videos/author`). */
export function registerPhaseTasksFinisher(key: string, f: PhaseTasksFinisher): void {
  finishers.set(key, f);
}

/** The phase's row finishes once none of its tasks is open; then the run goes on. */
async function afterTaskFinished(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1 FOR UPDATE', [task.run_id]);
  if (!run || run.status !== 'running') return;
  const round = await phaseTasks(tx, task.run_id, task.repo_id, task.step, task.phase, task.attempt);
  if (round.some((t) => t.status === 'queued' || t.status === 'running')) return;
  const row = await one(
    tx,
    `SELECT state FROM release_docs_prep_steps WHERE run_id=$1 AND repo_id=$2 AND step=$3 AND phase=$4`,
    [task.run_id, task.repo_id, task.step, task.phase],
  );
  if (row?.state !== 'running') return;
  const finisher = finishers.get(`${task.step}/${task.phase}`);
  const out: PhaseTasksOutcome = finisher
    ? await finisher(tx, run, task.repo_id, round)
    : round.every((t) => t.status === 'done')
      ? { state: 'passed' }
      : { state: 'failed', error: round.map((t) => t.note).join('; ') };
  await ctx.store.append(
    [
      {
        streamId: runStream(run.id),
        event: {
          type: 'ReleaseDocsPrepStepFinished',
          payload: {
            runId: run.id,
            repoId: task.repo_id,
            step: task.step,
            ...(task.phase ? { phase: task.phase } : {}),
            state: out.state,
            ...(out.error ? { error: out.error.slice(0, 4000) } : {}),
            files: [],
            ...(out.report ? { report: out.report } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: runScope(run),
      },
    ],
    { tx },
  );
  const { advance } = await import('./docs-prep.ts');
  scheduleDelivery(ctx, await advance(ctx, tx, run.id));
}

/** Commands queued inside a transaction are delivered once it has committed (the pass flushes too). */
const toDeliver = new Set<string>();
function scheduleDelivery(ctx: Ctx, workstations: string[]): void {
  for (const w of workstations) toDeliver.add(w);
  if (workstations.length > 0) setTimeout(() => flushDelivery(ctx), 250).unref?.();
}
function flushDelivery(ctx: Ctx): void {
  const ws = [...toDeliver];
  toDeliver.clear();
  for (const w of ws) void Promise.resolve(ctx.services.gateway.deliverPending(w)).catch(() => undefined);
}

function taskFinished(
  run: Row,
  taskId: string,
  ok: boolean,
  note: string,
  extra: { commit?: string; files?: string[]; code?: PrepWriterFailureCode; result?: unknown } = {},
): AppendInput {
  return {
    streamId: runStream(run.id),
    event: {
      type: 'ReleaseDocsPrepTaskFinished',
      payload: {
        taskId,
        ok,
        note: note.slice(0, 4000),
        ...(extra.commit ? { commit: extra.commit } : {}),
        files: extra.files ?? [],
        ...(extra.code ? { code: extra.code } : {}),
        ...(extra.result !== undefined ? { result: extra.result } : {}),
      },
    },
    actor: SYSTEM_ACTOR,
    scope: runScope(run),
  };
}

/** Finish a task (and, when it was the last, its phase). */
export async function finishReleasePrepTask(
  ctx: Ctx,
  tx: Tx,
  task: Row,
  ok: boolean,
  note: string,
  extra: { commit?: string; files?: string[]; code?: PrepWriterFailureCode; result?: unknown } = {},
): Promise<void> {
  const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1', [task.run_id]);
  if (!run) return;
  await ctx.store.append([taskFinished(run, task.id, ok, note, extra)], { tx });
  await afterTaskFinished(ctx, tx, {
    ...task,
    status: ok ? 'done' : 'failed',
    note,
    code: extra.code ?? null,
    result: extra.result ?? null,
  });
}

// ---------------------------------------------------------------------------------------------------------- dispatch

export interface ReleasePrepDispatch {
  taskId: string;
  shiftId: string;
  agentId: string;
  workstationId: string;
}

/** Why the last pass could not give a queued task to anybody (for the 2-hour message); in memory, per server process. */
const lastWhy = new Map<string, string>();

/**
 * Gives queued tasks to an agent on the repository's workstation: one task at a time per (run, repository, phase), in
 * order, and one release_prep shift at a time per agent. The agent's role comes from PREP_TASK_KINDS (the one place a
 * writer is chosen, for every content step). No such agent on the workstation fails the task at once (`no_writer`); a task
 * nobody could take within RELEASE_PREP_QUEUE_LIMIT_MS fails too (`writer_unreachable`).
 */
export async function releasePrepTaskPass(
  ctx: Ctx,
  skipAgent: (agentId: string) => boolean = () => false,
  workstationFull: (workstationId: string) => boolean = () => false,
): Promise<ReleasePrepDispatch[]> {
  flushDelivery(ctx);
  const now = ctx.clock.now();
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const queued = await rows(
    ctx.pool,
    `SELECT t.*, u.project_id, u.org_id FROM release_docs_prep_tasks t
       JOIN release_docs_prep_runs u ON u.id = t.run_id AND u.status = 'running'
      WHERE t.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM release_docs_prep_tasks o WHERE o.run_id = t.run_id AND o.repo_id = t.repo_id
                          AND o.step = t.step AND o.phase = t.phase AND o.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM release_docs_prep_tasks o WHERE o.run_id = t.run_id AND o.repo_id = t.repo_id
                          AND o.step = t.step AND o.phase = t.phase AND o.status = 'queued'
                          AND (o.attempt, o.position) < (t.attempt, t.position))
      ORDER BY t.created_at, t.position`,
  );
  const started: ReleasePrepDispatch[] = [];
  const busy = new Set<string>();
  for (const t of queued) {
    const task = ReleasePrepTaskSchema.safeParse(t.task);
    const roles: string[] = task.success ? [...PREP_TASK_KINDS[task.data.kind].roles] : [];
    const builders = await rows(
      ctx.pool,
      // The workstation's runtimes, owner and sharing are what accountForAgent reads to find a usable account.
      `SELECT a.*, ws.id AS ws_id, ws.user_id AS ws_user_id, ws.share_accounts, ws.runner_version, ws.runtimes,
              ws.connected, ws.last_seen_at, ws.name AS ws_name FROM agents a
         JOIN workstations ws ON ws.id = a.workstation_id AND ws.status = 'active'
        WHERE a.workstation_id = $1 AND a.org_id = $2 AND a.role_key = ANY ($4::text[]) AND a.status = 'active'
          AND a.paused_at IS NULL AND NOT a.is_devops
          AND (a.allowed_project_ids IS NULL OR $3::uuid = ANY (a.allowed_project_ids))
        ORDER BY array_position($4::text[], a.role_key), a.last_shift_ended_at NULLS FIRST, a.hired_at, a.id`,
      [t.workstation_id, t.org_id, t.project_id, roles],
    );
    const fail = async (reason: string, code: PrepWriterFailureCode = 'writer_failed') =>
      withAppendTx(ctx.pool, async (tx) => {
        const cur = await one(
          tx,
          `SELECT * FROM release_docs_prep_tasks WHERE id=$1 AND status='queued' FOR UPDATE`,
          [t.id],
        );
        if (cur) await finishReleasePrepTask(ctx, tx, cur, false, reason, { code });
      });
    if (!task.success) {
      await fail('the task cannot be read');
      continue;
    }
    const ws = await one(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [t.workstation_id]);
    const what = taskLabel(task.data);
    const kindOf = task.data.kind;
    const whatFor = kindOf === 'new_video' ? `the ${what} video` : what;
    if (builders.length === 0) {
      await fail(prepWriterUnavailable('no_writer', kindOf, { workstation: ws?.name, what: whatFor }), 'no_writer');
      lastWhy.delete(t.id);
      continue;
    }
    if (now.getTime() - new Date(t.created_at).getTime() > RELEASE_PREP_QUEUE_LIMIT_MS) {
      await fail(
        prepWriterUnavailable('writer_unreachable', kindOf, {
          workstation: ws?.name,
          what: whatFor,
          reason:
            lastWhy.get(t.id) ??
            (builders.some((a) => a.connected && a.last_seen_at && new Date(a.last_seen_at) > onlineSince)
              ? 'every writer was busy'
              : 'the runner is offline'),
        }),
        'writer_unreachable',
      );
      lastWhy.delete(t.id);
      continue;
    }
    const accounts = await loadProjectAccounts(ctx.pool, [t.project_id]);
    for (const a of builders) {
      const account = accountForAgent(accounts, t.project_id, a as never, now);
      const online = !!(a.connected && a.last_seen_at && new Date(a.last_seen_at) > onlineSince);
      if (!online) {
        lastWhy.set(t.id, 'the runner is offline');
        continue;
      }
      if (account === null) {
        lastWhy.set(t.id, 'no working model account');
        continue;
      }
      if (busy.has(a.id) || skipAgent(a.id) || workstationFull(a.ws_id)) {
        lastWhy.set(t.id, 'every writer was busy');
        continue;
      }
      const conn = ctx.services.runners.get(a.ws_id);
      if (!conn || !conn.reconciled) {
        lastWhy.set(t.id, 'the runner is offline');
        continue;
      }
      const shiftId = randomUUID();
      const ok = await withAppendTx(ctx.pool, async (tx) => {
        const cur = await one(
          tx,
          `SELECT 1 FROM release_docs_prep_tasks WHERE id=$1 AND status='queued' FOR UPDATE`,
          [t.id],
        );
        if (!cur) return false;
        const open = await one(
          tx,
          `SELECT 1 FROM shifts WHERE agent_id=$1 AND kind='release_prep' AND status <> 'ended' LIMIT 1`,
          [a.id],
        );
        if (open) return false;
        await ctx.store.append(
          [
            {
              streamId: runStream(t.run_id),
              event: {
                type: 'ReleaseDocsPrepTaskDispatched',
                payload: {
                  taskId: t.id,
                  shiftId,
                  agentId: a.id,
                  workstationId: a.ws_id,
                  ...(account && account.key !== MAIN_ACCOUNT ? { accountKey: account.key } : {}),
                },
              },
              actor: SYSTEM_ACTOR,
              scope: projectScope(t.org_id, t.project_id),
            },
          ],
          { tx },
        );
        return true;
      });
      busy.add(a.id);
      if (!ok) continue;
      lastWhy.delete(t.id);
      started.push({ taskId: t.id, shiftId, agentId: a.id, workstationId: a.ws_id });
      const built = await buildReleasePrepShiftStart(ctx, t.id, shiftId);
      if (built) ctx.services.runners.send(a.ws_id, 'shift.start', built, ctx.clock.now());
      break;
    }
  }
  return started;
}

type ShiftStartPayload = Omit<ServerToRunnerOf<'shift.start'>, 'v' | 'id' | 'type' | 'ts'>;

/** The `shift.start` of a release_prep shift: a placeholder card, the task in `releasePrep`, no card worktree. */
export async function buildReleasePrepShiftStart(
  ctx: Ctx,
  taskId: string,
  shiftId: string,
): Promise<ShiftStartPayload | null> {
  const t = await one(
    ctx.pool,
    `SELECT t.*, u.project_id, u.release_branch, r.head_sha, pr.remote_url_normalized, pr.name AS repo_name
       FROM release_docs_prep_tasks t JOIN release_docs_prep_runs u ON u.id = t.run_id
       JOIN release_docs_prep_repos r ON r.run_id = t.run_id AND r.repo_id = t.repo_id
       JOIN project_repos pr ON pr.id = t.repo_id WHERE t.id=$1`,
    [taskId],
  );
  if (!t || !t.head_sha) return null;
  const task = ReleasePrepTaskSchema.safeParse(t.task);
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [t.agent_id]);
  const project = await one(ctx.pool, 'SELECT * FROM projects WHERE id=$1', [t.project_id]);
  if (!task.success || !agent || !project) return null;
  const role = await loadRole(ctx.pool, agent.org_id, agent.role_key, agent.role_version);
  if (!role) return null;
  const title = PREP_TASK_KINDS[task.data.kind].title(task.data, t.release_branch);
  const brief: ShiftBrief = {
    shift: {
      id: shiftId,
      kind: 'release_prep',
      stage: 'release_prep',
      stageLabel: 'Release prep task',
      doneCriteria:
        'The files are written and you ended with `aom prep done`, or you said why not with `aom prep fail`.',
      outcomes: releasePrepBriefOutcomes(),
      maxShiftMinutes: RELEASE_PREP_MAX_SHIFT_MINUTES,
    },
    agent: briefAgent(agent),
    card: {
      id: t.id,
      ref: 'PREP',
      title,
      cardType: 'support',
      fields: {},
      riskTier: null,
      reworkRound: 0,
      completionAction: null,
      docsNeeded: false,
      dependencies: [],
    },
    project: {
      id: project.id,
      key: project.key,
      name: project.name,
      workingBranch: t.release_branch,
      e2eGlobs: [],
      architecturalGlobs: [],
    },
    role: {
      key: role.definition.key,
      name: role.definition.name,
      instructions: role.definition.instructions,
      coreRules: role.definition.coreRules,
      skills: await effectiveAgentSkills(ctx.pool, agent),
    },
    handoffs: [],
    reviewComments: [],
    thread: [],
    standingOrders: await standingOrdersFor(ctx.pool, project.org_id, project.id),
    ledger: [],
  };
  return {
    shiftId,
    claimId: randomUUID(),
    kind: 'release_prep',
    agent: await agentSpecFor(ctx, agent),
    brief,
    worktree: null,
    prepare: { rebase: false },
    maxShiftMinutes: RELEASE_PREP_MAX_SHIFT_MINUTES,
    ...accountOf(
      await one(ctx.pool, 'SELECT account_key FROM shifts WHERE id=$1', [shiftId]).then((s) => s ?? {}),
    ),
    releasePrep: {
      taskId: t.id,
      runId: t.run_id,
      repoId: t.repo_id,
      step: t.step,
      phase: t.phase,
      remoteUrlNormalized: t.remote_url_normalized,
      workRef: `refs/guildwise/docs-prep/${t.run_id}/work`,
      startSha: t.head_sha,
      task: task.data,
      writable: writableFilesFor(task.data),
    },
  };
}

// ------------------------------------------------------------------------------------------------- report and end

type ReportResult = { accepted: boolean; error?: string };

/**
 * `aom prep done|fail` of a release_prep shift. The runner has already checked the changed files against the writable
 * list and committed them to the work ref: `done` arrives with the commit, a refused `done` as `prep_failed`.
 */
export async function applyReleasePrepReport(
  ctx: Ctx,
  tx: Tx,
  msg: RunnerToServerOf<'shift.report'>,
  shift: Row,
): Promise<ReportResult> {
  const task = await one(tx, 'SELECT * FROM release_docs_prep_tasks WHERE shift_id=$1 FOR UPDATE', [
    shift.id,
  ]);
  if (!task || task.status !== 'running')
    return {
      accepted: false,
      error: 'this task is no longer open; there is nothing left to do. Finish now.',
    };
  const report = msg.report;
  if (report.kind === 'comment') return { accepted: true };
  if (
    report.kind !== 'outcome' ||
    (report.outcomeId !== PREP_OUTCOME.done && report.outcomeId !== PREP_OUTCOME.failed)
  )
    return {
      accepted: false,
      error:
        'a release prep task ends with `aom prep done --summary "..."` or `aom prep fail --reason "..."`',
    };
  const data = report.data as { commit?: unknown; files?: unknown; refused?: unknown; proposal?: unknown };
  const parsed = ReleasePrepTaskSchema.safeParse(task.task);
  if (!parsed.success) {
    await finishReleasePrepTask(ctx, tx, task, false, 'the task cannot be read', { code: 'writer_failed' });
    return { accepted: true };
  }
  const kind = parsed.data.kind;
  if (report.outcomeId === PREP_OUTCOME.failed) {
    await finishReleasePrepTask(ctx, tx, task, false, report.note, { code: 'writer_failed' });
    return { accepted: true };
  }
  if (PREP_TASK_KINDS[kind].result === 'proposal') {
    // The runner has checked the proposal against the files; the server checks what only it can (the deny list of names).
    const checked = await checkPrepProposal(tx, task, parsed.data, data.proposal);
    if (!checked.ok) return { accepted: false, error: checked.error };
    await finishReleasePrepTask(ctx, tx, task, true, report.note, { files: [], result: checked.result });
    return { accepted: true, ...(checked.message ? { message: checked.message } : {}) };
  }
  const commit =
    typeof data.commit === 'string' && /^[0-9a-f]{40}$/.test(data.commit) ? data.commit : undefined;
  const files = Array.isArray(data.files) ? data.files.map(String).slice(0, 50) : [];
  if (!commit)
    await finishReleasePrepTask(ctx, tx, task, false, 'the workstation did not commit the files', {
      code: 'writer_failed',
    });
  else await finishReleasePrepTask(ctx, tx, task, true, report.note, { commit, files });
  return { accepted: true };
}

type ProposalCheck = { ok: true; result: unknown; message?: string } | { ok: false; error: string };

/**
 * The server's check of a proposal task's report. `changelog_entries`: `checkChangelogProposal` (schema, the public-text
 * gate, the deny list of agent, member and workstation names, every change accounted for once), refused with the same text
 * the BA got. `guide_edits`: the schema (the file checks ran on the runner). Either way the accepted proposal is stored.
 */
async function checkPrepProposal(
  tx: Tx,
  task: Row,
  parsed: ReleasePrepTask,
  proposal: unknown,
): Promise<ProposalCheck> {
  if (proposal === undefined || proposal === null)
    return {
      ok: false,
      error: 'the report has no proposal: write release-prep-proposal.json and run aom prep done again',
    };
  const size = JSON.stringify(proposal).length;
  if (size > PROPOSAL_MAX_BYTES)
    return {
      ok: false,
      error: `the proposal is too large (${Math.ceil(size / 1024)} KB, max ${PROPOSAL_MAX_BYTES / 1024} KB): propose fewer or shorter edits`,
    };
  if (parsed.kind === 'guide_edits') {
    const p = GuideProposalSchema.safeParse(proposal);
    if (!p.success)
      return {
        ok: false,
        error: `the proposal is not valid: ${p.error.issues[0]?.path.join('.') ?? ''} ${p.error.issues[0]?.message ?? ''}`.trim(),
      };
    return { ok: true, result: { proposal: p.data }, message: `${p.data.edits.length} guide edit(s) accepted.` };
  }
  if (parsed.kind !== 'changelog_entries') return { ok: false, error: 'this task has no proposal' };
  const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1', [task.run_id]);
  const repo = run ? await repoRowOf(tx, run.id, task.repo_id) : null;
  const summary = repo?.summary ? ReleaseDocsPrepSummarySchema.safeParse(repo.summary) : null;
  if (!run || !repo || !summary?.success)
    return { ok: false, error: 'the change summary of this run is gone: report that nothing can be written' };
  const { uncovered, existing } = await changelogWriterInput(tx, run, repo, summary.data);
  const check = checkChangelogProposal(proposal, {
    uncovered,
    existingCount: existing.length,
    publicText,
    denyList: await changelogDenyList(tx, run.org_id),
  });
  if (!check.ok)
    return {
      ok: false,
      error: `The entries were not accepted. Fix these and report again:\n${check.errors.map((e) => `- ${e}`).join('\n')}`,
    };
  // The writer never writes keys: the client ticket of each intake card an entry describes is added here.
  const entries = withClientRefs(check.entries, await changeListFor(tx, run, summary.data, uncovered));
  return {
    ok: true,
    result: storedChangelogResult(entries, check.proposal),
    message: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} accepted for ${repo.name}.`,
  };
}

async function repoRowOf(db: Queryable, runId: string, repoId: string): Promise<Row | null> {
  return (await one(
    db,
    `SELECT r.*, pr.remote_url_normalized, pr.forge_kind, pr.name FROM release_docs_prep_repos r
       JOIN project_repos pr ON pr.id = r.repo_id WHERE r.run_id=$1 AND r.repo_id=$2`,
    [runId, repoId],
  )) ?? null;
}

type EndOutcome = 'rejected' | 'lost' | 'stopped' | 'no_report' | 'crashed' | 'timeout' | 'reported';

/**
 * `ShiftEnded` of a release_prep shift and what it means for its task: a lost or stopped shift puts the task back in the
 * queue; a crash, timeout or missing report counts, and after RELEASE_PREP_MAX_ATTEMPTS the task fails. A rejected start
 * (`rejection`) is requeued too, but one that is not just a busy agent or account counts towards
 * RELEASE_PREP_MAX_REJECTIONS, after which the task fails with the rejection's reason and detail.
 */
export async function endReleasePrepShift(
  ctx: Ctx,
  tx: Tx,
  shift: Row,
  outcome: EndOutcome,
  extra: {
    durationMs?: number;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    exitCode?: number | null;
    guardViolations?: { rule: string; detail: string }[];
    /** Why the start was rejected (the runner's reason and detail, or the reaper's 'not accepted'). */
    rejection?: { reason: string; detail?: string };
  } = {},
): Promise<void> {
  await ctx.store.append(
    [
      {
        streamId: streamId.shift(shift.id),
        event: {
          type: 'ShiftEnded',
          payload: {
            shiftId: shift.id,
            agentId: shift.agent_id,
            outcome,
            durationMs: extra.durationMs ?? 0,
            usage: extra.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            exitCode: extra.exitCode,
            guardViolations: extra.guardViolations ?? [],
          },
        },
        actor: runnerActor(shift.workstation_id),
        scope: orgScope(shift.org_id),
      },
    ],
    { tx },
  );
  const task = await one(
    tx,
    `SELECT * FROM release_docs_prep_tasks WHERE shift_id=$1 AND status='running' FOR UPDATE`,
    [shift.id],
  );
  if (!task) return;
  const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1', [task.run_id]);
  if (!run) return;
  if (outcome === 'rejected' && extra.rejection && !PASSING_REJECTIONS.has(extra.rejection.reason)) {
    const rejected = await one(
      tx,
      `SELECT count(*)::int AS n FROM shifts WHERE release_prep_task_id=$1 AND kind='release_prep' AND outcome='rejected'`,
      [task.id],
    );
    if ((rejected?.n ?? 1) >= RELEASE_PREP_MAX_REJECTIONS) {
      const d = (extra.rejection.detail ?? '').replace(/\s+/g, ' ').trim();
      const why = d ? `${extra.rejection.reason}: ${d}` : extra.rejection.reason.replaceAll('_', ' ');
      await finishReleasePrepTask(ctx, tx, task, false, `the workstation could not start the task (${why})`, {
        code: 'writer_failed',
      });
      return;
    }
  }
  const counted = !(outcome === 'rejected' || outcome === 'lost' || outcome === 'stopped');
  const tries = await one(
    tx,
    `SELECT count(*)::int AS n FROM shifts WHERE release_prep_task_id=$1 AND kind='release_prep'`,
    [task.id],
  );
  if (counted && (tries?.n ?? 1) >= RELEASE_PREP_MAX_ATTEMPTS) {
    await finishReleasePrepTask(
      ctx,
      tx,
      task,
      false,
      outcome === 'timeout'
        ? 'the agent ran out of time'
        : 'the agent ended without `aom prep done` or `aom prep fail`',
      { code: 'writer_failed' },
    );
    return;
  }
  await ctx.store.append(
    [
      {
        streamId: runStream(run.id),
        event: { type: 'ReleaseDocsPrepTaskRequeued', payload: { taskId: task.id, reason: outcome } },
        actor: SYSTEM_ACTOR,
        scope: runScope(run),
      },
    ],
    { tx },
  );
}

// --------------------------------------------------------------------------------------------- videos author phase

/** The new videos of a plan report, as tasks. */
export function newVideoTasks(plan: unknown, repair?: Map<string, string>): ReleasePrepTask[] {
  const parsed = VideoStepReportSchema.safeParse(plan);
  if (!parsed.success) return [];
  return (parsed.data.needsAuthoring ?? [])
    .filter((n) => !repair || repair.has(n.slug))
    .map((n) => {
      const cards = [...new Set(n.reasons.flatMap((r) => r.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []))].sort();
      return {
        kind: 'new_video' as const,
        slug: n.slug,
        title: n.title,
        pages: n.pages.slice(0, 50),
        cards: cards.slice(0, 100),
        ...(repair?.has(n.slug) ? { repairOf: { error: (repair.get(n.slug) ?? '').slice(-4000) } } : {}),
      };
    });
}

/** The slugs and errors of the new videos whose render failed (from the render row's report). */
export function failedNewVideos(renderReport: unknown, authored: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const parsed = VideoStepReportSchema.safeParse(renderReport);
  if (!parsed.success) return out;
  for (const v of parsed.data.videos)
    if (v.action === 'create' && v.state === 'failed' && authored.has(v.slug))
      out.set(v.slug, v.error ?? 'the render failed');
  return out;
}

export { authorFailure };
