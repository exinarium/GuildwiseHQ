import {
  type ChangelogEntriesTask,
  DEFAULT_GUIDE_PATH,
  GuideEditsTaskSchema,
  GuideProposalSchema,
  type ReleaseDocsPrepSummary,
  ReleaseDocsPrepSummarySchema,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { changeListFor, changelogDispatchFor, changelogWriterInput } from './docs-prep-changelog.ts';
import type { ServerPhaseOutcome } from './docs-prep-phases.ts';
import { guideCoveredSources } from './docs-prep-steps.ts';
import {
  phaseTasks,
  queueReleasePrepTasks,
  registerPhaseTasksFinisher,
  taskFailureText,
} from './docs-prep-tasks.ts';

/**
 * Release prep, the writer phases of 'Write changelog' (`write`) and 'Update user guide' (`write`): the server queues one
 * release prep task whose writer proposes the text, and the finisher turns the finished task into the phase's row. The
 * writer is chosen by `releasePrepTaskPass` for every task kind (docs-prep-tasks.ts), not here.
 */

const summaryOf = (repo: Row): ReleaseDocsPrepSummary | null => {
  const s = repo.summary ? ReleaseDocsPrepSummarySchema.safeParse(repo.summary) : null;
  return s?.success ? s.data : null;
};

async function repoRow(db: Queryable, runId: string, repoId: string): Promise<Row | null> {
  return (
    (await one(
      db,
      `SELECT r.*, pr.remote_url_normalized, pr.forge_kind, pr.name FROM release_docs_prep_repos r
       JOIN project_repos pr ON pr.id = r.repo_id WHERE r.run_id=$1 AND r.repo_id=$2`,
      [runId, repoId],
    )) ?? null
  );
}

/** The step's report of one phase. */
async function stepReport(db: Queryable, runId: string, repoId: string, step: string, phase: string) {
  const row = await one(
    db,
    `SELECT report FROM release_docs_prep_steps WHERE run_id=$1 AND repo_id=$2 AND step=$3 AND phase=$4`,
    [runId, repoId, step, phase],
  );
  return (row?.report ?? null) as Record<string, unknown> | null;
}

/** The last finished task of a phase (the highest attempt), or null. */
async function doneTask(db: Queryable, runId: string, repoId: string, step: string, phase: string) {
  const tasks = await phaseTasks(db, runId, repoId, step, phase);
  const done = tasks.filter((t) => t.status === 'done');
  return done.length > 0 ? (done[done.length - 1] as Row) : null;
}

// ---------------------------------------------------------------------------------------------------- changelog

/** The task for one repository: the uncovered changes with their cards, and the entries already under Unreleased. */
export async function buildChangelogEntriesTask(
  db: Queryable,
  run: Row,
  repo: Row,
  summary: ReleaseDocsPrepSummary,
): Promise<ChangelogEntriesTask> {
  const { uncovered, existing } = await changelogWriterInput(db, run, repo, summary);
  const project = await one(db, 'SELECT name FROM projects WHERE id=$1', [run.project_id]);
  const changes = await changeListFor(db, run, summary, uncovered);
  return {
    kind: 'changelog_entries',
    projectName: project?.name ?? '',
    repoName: repo.name ?? summary.repoName,
    releaseBranch: repo.branch,
    changes,
    existing,
  };
}

/**
 * The `write` phase of 'Write changelog'. Fails when there is no change summary or the changelog is malformed; passes at
 * once when nothing is new; otherwise queues one `changelog_entries` task for the writer and waits.
 */
export async function runChangelogWritePhase(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
): Promise<ServerPhaseOutcome> {
  const repo = await repoRow(tx, run.id, repoId);
  if (!repo) return { state: 'failed', error: 'the repository is no longer part of this run' };
  const summary = summaryOf(repo);
  const d = await changelogDispatchFor(tx, run, repo, summary);
  if (d.kind === 'fail') return { state: 'failed', error: d.error };
  if (d.kind === 'apply' || !summary) return { state: 'passed', report: { entries: 0 } };
  const task = await buildChangelogEntriesTask(tx, run, repo, summary);
  await queueReleasePrepTasks(ctx, tx, run, repoId, 'changelog', 'write', 0, [task]);
  return { state: 'running' };
}

/** What the runner's `apply` phase merges: the accepted entries of the writer task, or none. */
export async function changelogApplyInput(
  tx: Queryable,
  runId: string,
  repoId: string,
): Promise<Record<string, unknown>> {
  const t = await doneTask(tx, runId, repoId, 'changelog', 'write');
  const r = (t?.result ?? null) as { entries?: unknown; covered?: unknown; skipped?: unknown } | null;
  if (!r || !Array.isArray(r.entries)) return { entries: [] };
  return {
    entries: r.entries,
    proposal: { covered: r.covered ?? [], skipped: r.skipped ?? [] },
  };
}

registerPhaseTasksFinisher('changelog/write', async (_tx, _run, _repoId, tasks) => {
  const bad = tasks.find((t) => t.status !== 'done');
  if (bad) return { state: 'failed', error: taskFailureText(bad) };
  const done = tasks[tasks.length - 1] as Row;
  const r = (done.result ?? {}) as { entries?: unknown[]; covered?: unknown[]; skipped?: unknown[] };
  return {
    state: 'passed',
    report: {
      entries: r.entries?.length ?? 0,
      covered: r.covered?.length ?? 0,
      skipped: r.skipped?.length ?? 0,
    },
  };
});

// ---------------------------------------------------------------------------------------------------------- guide

export const NO_NEW_GUIDE_CHANGES_NOTE = 'no new changes';

/**
 * The `write` phase of 'Update user guide'. Reads the `check` phase's report: no uncovered changes means skipped;
 * otherwise one `guide_edits` task is queued for the writer.
 */
export async function runGuideWritePhase(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
): Promise<ServerPhaseOutcome> {
  const report = await stepReport(tx, run.id, repoId, 'guide', 'check');
  const changes = Array.isArray(report?.changes) ? (report.changes as unknown[]) : [];
  if (changes.length === 0) return { state: 'skipped', error: NO_NEW_GUIDE_CHANGES_NOTE, report: {} };
  const task = GuideEditsTaskSchema.safeParse({
    kind: 'guide_edits',
    guidePath: typeof report?.guidePath === 'string' ? report.guidePath : DEFAULT_GUIDE_PATH,
    changes,
    coveredSources: await guideCoveredSources(tx, run, repoId),
  });
  if (!task.success)
    return { state: 'failed', error: 'the guide check of this repository has no usable report' };
  await queueReleasePrepTasks(ctx, tx, run, repoId, 'guide', 'write', 0, [task.data]);
  return { state: 'running' };
}

/** What the runner's `apply` phase applies: the checked proposal of the writer task, or nothing. */
export async function guideApplyInput(
  tx: Queryable,
  runId: string,
  repoId: string,
): Promise<Record<string, unknown>> {
  const t = await doneTask(tx, runId, repoId, 'guide', 'write');
  const r = (t?.result ?? null) as { proposal?: unknown } | null;
  return r?.proposal !== undefined ? { proposal: r.proposal } : {};
}

registerPhaseTasksFinisher('guide/write', async (_tx, _run, _repoId, tasks) => {
  const bad = tasks.find((t) => t.status !== 'done');
  if (bad) return { state: 'failed', error: taskFailureText(bad) };
  const done = tasks[tasks.length - 1] as Row;
  const p = GuideProposalSchema.safeParse((done.result as { proposal?: unknown } | null)?.proposal);
  return { state: 'passed', report: { edits: p.success ? p.data.edits.length : 0 } };
});
