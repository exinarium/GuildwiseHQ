import {
  checkChangelogProposal,
  RELEASE_CHANGELOG_OUTCOME,
  type ReleaseChangelogTask,
  type ReleaseDocsPrepSummary,
  ReleaseDocsPrepSummarySchema,
  type RunnerToServerOf,
  streamId,
  unreleasedBullets,
} from '@aom/shared';
import { publicText } from '../blog/releases.ts';
import { loadCommitAs } from '../commands/commit-as.ts';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { ReportResult } from '../commands/shifts.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { advance, sendDocsPrepStepCommand } from './docs-prep.ts';
import { coveredSourcesFor, summarySources } from './docs-prep-changelog.ts';
import { loadFacts } from './facts.ts';

/**
 * The `release_changelog` BA task of the release prep step 'Write changelog' (docs/investigations GWP-90, 4.6): the
 * brief, the report (checked, and refused with the findings so the BA can fix it in the same shift) and the fallback.
 * An accepted report sends the runner the checked entries; the runner merges them into CHANGELOG.md.
 */

const taskDone = (task: Row, status: 'done' | 'failed' | 'fallback' | 'cancelled', note?: string) => ({
  streamId: streamId.baTask(task.id),
  event: {
    type: 'BaTaskCompleted' as const,
    payload: { taskId: task.id, status, ...(note ? { note } : {}) },
  },
  actor: SYSTEM_ACTOR,
  scope: task.project_id ? projectScope(task.org_id, task.project_id) : orgScope(task.org_id),
});

/** Names that must never reach a public entry: agents, members, workstations and their host names of the organisation. */
export async function changelogDenyList(db: Queryable, orgId: string): Promise<string[]> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t.length >= 3) out.add(t);
  };
  for (const a of await rows(db, 'SELECT name FROM agents WHERE org_id=$1', [orgId])) add(a.name);
  for (const u of await rows(
    db,
    `SELECT u.display_name FROM users u JOIN org_members m ON m.user_id = u.id WHERE m.org_id=$1`,
    [orgId],
  ))
    add(u.display_name);
  for (const w of await rows(
    db,
    `SELECT w.name, w.hostname FROM workstations w JOIN org_members m ON m.user_id = w.user_id WHERE m.org_id=$1`,
    [orgId],
  )) {
    add(w.name);
    add(w.hostname);
  }
  return [...out];
}

/** The open run and repository row of a task, or null when the run is gone or no longer waits for this task. */
async function prepRepoOf(db: Queryable, task: Row): Promise<{ run: Row; repo: Row } | null> {
  const run = await one(db, 'SELECT * FROM release_docs_prep_runs WHERE id=$1', [task.prep_run_id]);
  if (!run) return null;
  const repo = await one(
    db,
    `SELECT r.*, pr.remote_url_normalized, pr.forge_kind, pr.name FROM release_docs_prep_repos r
       JOIN project_repos pr ON pr.id = r.repo_id WHERE r.run_id=$1 AND r.repo_id=$2`,
    [task.prep_run_id, task.prep_repo_id],
  );
  return repo ? { run, repo } : null;
}

const summaryOf = (repo: Row): ReleaseDocsPrepSummary | null => {
  const s = repo.summary ? ReleaseDocsPrepSummarySchema.safeParse(repo.summary) : null;
  return s?.success ? s.data : null;
};

/** The changes no earlier run wrote, and the bullets already under Unreleased (from the facts at the analysed head). */
async function writerInput(db: Queryable, run: Row, repo: Row, summary: ReleaseDocsPrepSummary) {
  const covered = await coveredSourcesFor(db, run, repo);
  const uncovered = summarySources(summary).filter((s) => !covered.has(s));
  const f = await loadFacts(db, repo.repo_id);
  const md = f?.facts?.changelog ?? null;
  const existing = md ? unreleasedBullets(md) : [];
  return { uncovered, existing };
}

/** The brief of a `release_changelog` shift. Null when the run or repository is gone. */
export async function buildReleaseChangelogTask(
  db: Queryable,
  task: Row,
): Promise<ReleaseChangelogTask | null> {
  const found = await prepRepoOf(db, task);
  if (!found) return null;
  const { run, repo } = found;
  const summary = summaryOf(repo);
  if (!summary) return null;
  const { uncovered, existing } = await writerInput(db, run, repo, summary);
  const project = await one(db, 'SELECT name FROM projects WHERE id=$1', [run.project_id]);
  const keys = [...new Set(summary.merges.flatMap((m) => m.cardKeys))];
  const titles = new Map<string, string>();
  if (keys.length)
    for (const c of await rows(db, 'SELECT ref, title FROM cards WHERE project_id=$1 AND ref = ANY($2)', [
      run.project_id,
      keys,
    ]))
      titles.set(c.ref, c.title);
  for (const c of summary.cards) if (c.title && !titles.has(c.key)) titles.set(c.key, c.title);
  const want = new Set(uncovered);
  const changes: ReleaseChangelogTask['changes'] = [];
  for (const m of summary.merges)
    if (want.has(m.sha)) {
      want.delete(m.sha);
      changes.push({
        source: m.sha,
        subject: m.subject,
        cards: m.cardKeys.map((k) => ({ key: k, title: titles.get(k) ?? null })),
        areas: [],
      });
    }
  for (const c of summary.commits)
    if (want.has(c.sha)) {
      want.delete(c.sha);
      changes.push({ source: c.sha, subject: c.subject, cards: [], areas: [] });
    }
  return {
    runId: run.id,
    repoId: repo.repo_id,
    projectName: project?.name ?? '',
    repoName: repo.name ?? summary.repoName,
    releaseBranch: repo.branch,
    changes,
    existing,
  };
}

/** Fails the step for the task's repository (nothing was written) and moves the run on, which finishes it as failed. */
async function failStep(ctx: Ctx, tx: Tx, run: Row, repoId: string, error: string): Promise<string[]> {
  const step = await one(
    tx,
    `SELECT state FROM release_docs_prep_steps WHERE run_id=$1 AND repo_id=$2 AND step='changelog' AND phase=''`,
    [run.id, repoId],
  );
  if (run.status !== 'running' || step?.state !== 'running') return [];
  await ctx.store.append(
    [
      {
        streamId: streamId.releaseDocsPrep(run.id),
        event: {
          type: 'ReleaseDocsPrepStepFinished',
          payload: { runId: run.id, repoId, step: 'changelog', state: 'failed', error, files: [] },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(run.org_id, run.project_id),
      },
    ],
    { tx },
  );
  return advance(ctx, tx, run.id);
}

const deliverLater = (ctx: Ctx, workstations: readonly string[]) => {
  // The commands become visible when the report's transaction commits; the gateway also redelivers on reconnect.
  for (const w of new Set(workstations))
    setTimeout(() => {
      void Promise.resolve(ctx.services.gateway.deliverPending(w)).catch(() => undefined);
    }, 250);
};

/** The terminal report of a `release_changelog` shift. */
export async function applyReleaseChangelogReport(
  ctx: Ctx,
  tx: Tx,
  task: Row,
  msg: RunnerToServerOf<'shift.report'>,
): Promise<ReportResult> {
  const report = msg.report;
  if (report.kind === 'comment') return { accepted: true };
  if (report.kind !== 'outcome')
    return {
      accepted: false,
      error:
        'there are no questions in a background task: write the entries from what the prompt says, or report that none can be written',
    };
  const found = await prepRepoOf(tx, task);
  const run = found
    ? await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1 FOR UPDATE', [found.run.id])
    : null;
  const step =
    found && run
      ? await one(
          tx,
          `SELECT state FROM release_docs_prep_steps WHERE run_id=$1 AND repo_id=$2 AND step='changelog' AND phase=''`,
          [run.id, found.repo.repo_id],
        )
      : null;
  if (!found || !run || run.status !== 'running' || step?.state !== 'running') {
    await ctx.store.append([taskDone(task, 'cancelled', 'the release prep run is no longer running')], {
      tx,
    });
    return { accepted: true, message: 'The release prep run is no longer running; nothing is written.' };
  }
  const { repo } = found;
  if (report.outcomeId === RELEASE_CHANGELOG_OUTCOME.fail) {
    const why =
      (report.note ?? '').trim().slice(0, 500) ||
      'The changelog writer could not write entries for these changes.';
    await ctx.store.append([taskDone(task, 'done', why)], { tx });
    deliverLater(ctx, await failStep(ctx, tx, run, repo.repo_id, `Write changelog: ${why}`));
    return { accepted: true };
  }
  if (report.outcomeId !== RELEASE_CHANGELOG_OUTCOME.done)
    return {
      accepted: false,
      error: `outcome '${report.outcomeId}' is not available (allowed: ${RELEASE_CHANGELOG_OUTCOME.done}, ${RELEASE_CHANGELOG_OUTCOME.fail})`,
    };
  const summary = summaryOf(repo);
  if (!summary) {
    await ctx.store.append([taskDone(task, 'failed', 'the change summary is gone')], { tx });
    deliverLater(ctx, await failStep(ctx, tx, run, repo.repo_id, 'Write changelog needs Analyse changes.'));
    return { accepted: true };
  }
  const { uncovered, existing } = await writerInput(tx, run, repo, summary);
  const check = checkChangelogProposal(report.data, {
    uncovered,
    existingCount: existing.length,
    publicText,
    denyList: await changelogDenyList(tx, run.org_id),
  });
  if (!check.ok)
    return {
      accepted: false,
      error: `The entries were not accepted. Fix these and report again:\n${check.errors.map((e) => `- ${e}`).join('\n')}`,
    };
  const project = await one(tx, 'SELECT key, name FROM projects WHERE id=$1', [run.project_id]);
  await ctx.store.append([taskDone(task, 'done')], { tx });
  const ws = await sendDocsPrepStepCommand(ctx, tx, run, repo, {
    step: 'changelog',
    projectKey: project?.key ?? '',
    commitAs: (await loadCommitAs(tx, run.project_id)) ?? null,
    changelog: {
      projectName: project?.name ?? '',
      entries: check.entries,
      proposal: { covered: check.proposal.covered, skipped: check.proposal.skipped },
    },
  });
  deliverLater(ctx, [ws]);
  return {
    accepted: true,
    message: `${check.entries.length} entr${check.entries.length === 1 ? 'y' : 'ies'} accepted for ${repo.name}.`,
  };
}

/** No BA took the task in time (or it failed twice): the step fails, nothing is written, and Retry is available. */
export async function runReleaseChangelogFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  await ctx.store.append([taskDone(task, 'fallback', 'no BA was available to write the changelog')], { tx });
  const found = await prepRepoOf(tx, task);
  if (!found) return;
  const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1 FOR UPDATE', [found.run.id]);
  if (!run) return;
  deliverLater(
    ctx,
    await failStep(
      ctx,
      tx,
      run,
      found.repo.repo_id,
      'No BA was available to write the changelog. Retry prep, or write the entries under ## [Unreleased] by hand.',
    ),
  );
}
