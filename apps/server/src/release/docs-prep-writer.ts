import {
  type ChangelogEntriesTask,
  DEFAULT_GUIDE_PATH,
  GuideEditsTaskSchema,
  GuideProposalSchema,
  type ReleaseDocsPrepSummary,
  ReleaseDocsPrepSummarySchema,
  workReference,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { changelogDispatchFor, changelogWriterInput } from './docs-prep-changelog.ts';
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

interface ChangeCard {
  /** The card's work reference: its client ticket (`ABC-1`) for an intake card, otherwise its internal ref. */
  key: string;
  /** The internal ref (never shown to the writer for an intake card). */
  ref: string;
  title: string;
  client: boolean;
}

/**
 * The project's cards a release's merge keys name, by internal ref and, for an intake card, by its client ticket too
 * (merges name either). The work reference comes from workReference, so an intake card is always shown by its ticket.
 */
export async function resolveChangeCards(
  db: Queryable,
  projectId: string,
  keys: readonly string[],
): Promise<Map<string, ChangeCard>> {
  const out = new Map<string, ChangeCard>();
  if (!keys.length) return out;
  const found = await rows(
    db,
    `SELECT ref, title, fields FROM cards WHERE project_id=$1 AND status<>'cancelled'
        AND (ref = ANY($2) OR coalesce(fields->>'externalRef','') <> '') ORDER BY created_at, ref`,
    [projectId, [...keys]],
  );
  for (const c of found) {
    const wr = workReference({ ref: c.ref, fields: c.fields });
    const card: ChangeCard = { key: wr.ref, ref: c.ref, title: c.title, client: wr.isClientRef };
    out.set(c.ref, card);
    if (wr.isClientRef && !out.has(wr.ref)) out.set(wr.ref, card);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The subject with each intake card's internal ref replaced by its ticket, so the writer never sees the internal key. */
function subjectWithWorkRefs(subject: string, cards: readonly ChangeCard[]): string {
  let out = subject;
  for (const c of cards)
    if (c.client && c.key !== c.ref)
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(c.ref)}(?![0-9])`, 'g'), c.key);
  return out;
}

/** The changes the writer describes (and the accepted entries are mapped back to): merges with their cards, then commits. */
export async function changeListFor(
  db: Queryable,
  run: Row,
  summary: ReleaseDocsPrepSummary,
  uncovered: readonly string[],
): Promise<ChangelogEntriesTask['changes']> {
  const keys = [...new Set(summary.merges.flatMap((m) => m.cardKeys))];
  const cards = await resolveChangeCards(db, run.project_id, keys);
  // Jira keys are indexed upper case (workReference canonicalises them); a merge may name one in lower case.
  const lookup = (k: string) => cards.get(k) ?? cards.get(k.toUpperCase());
  const titles = new Map<string, string>();
  for (const c of summary.cards) if (c.title && !titles.has(c.key)) titles.set(c.key, c.title);
  const want = new Set(uncovered);
  const changes: ChangelogEntriesTask['changes'] = [];
  for (const m of summary.merges)
    if (want.has(m.sha)) {
      want.delete(m.sha);
      const matched: ChangeCard[] = [];
      const list: ChangelogEntriesTask['changes'][number]['cards'] = [];
      for (const k of m.cardKeys) {
        const c = lookup(k);
        const entry = c
          ? { key: c.key, title: c.title, ...(c.client ? { client: true } : {}) }
          : { key: k, title: titles.get(k) ?? null };
        if (c) matched.push(c);
        if (!list.some((x) => x.key === entry.key)) list.push(entry);
      }
      changes.push({
        source: m.sha,
        subject: subjectWithWorkRefs(m.subject, matched),
        cards: list,
        areas: [],
      });
    }
  for (const c of summary.commits)
    if (want.has(c.sha)) {
      want.delete(c.sha);
      changes.push({ source: c.sha, subject: c.subject, cards: [], areas: [] });
    }
  return changes;
}

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
