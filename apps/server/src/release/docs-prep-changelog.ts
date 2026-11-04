import { randomUUID } from 'node:crypto';
import {
  checkChangelog,
  RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY,
  RELEASE_DOCS_PREP_OUTPUT_MAX_BYTES,
  type ReleaseChangelogOutput,
  ReleaseChangelogOutputSchema,
  type ReleaseDocsPrepSummary,
  ReleasePrepChangelogPayloadSchema,
  streamId,
} from '@aom/shared';
import { projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { loadFacts } from './facts.ts';

/**
 * The server half of the 'Write changelog' prep step: what to do when the run reaches the step for one repository,
 * and what of the runner's report is kept. The runner half merges the entries (apps/runner release-docs-prep-changelog).
 */

export const NEEDS_ANALYSE = 'Write changelog needs Analyse changes. Turn it on in the project settings.';
export const NEEDS_RUNNER =
  'Write changelog needs a newer runner on the workstation that has this repository. Update the runner and retry prep.';
/** The source ids of a change summary: the commits and merges 'Analyse changes' found. */
export function summarySources(summary: ReleaseDocsPrepSummary): string[] {
  return [...new Set([...summary.commits.map((c) => c.sha), ...summary.merges.map((m) => m.sha)])];
}

/** Every source an earlier passed run already wrote, matched or skipped; plus the earlier prep commits themselves. */
export function coveredSourcesOf(outputs: readonly unknown[], prepCommits: readonly string[]): Set<string> {
  const out = new Set<string>(prepCommits);
  for (const o of outputs) {
    const p = ReleaseChangelogOutputSchema.safeParse(o);
    if (!p.success) continue;
    for (const e of p.data.added) for (const s of e.sources) out.add(s);
    for (const c of p.data.covered) out.add(c.source);
    for (const s of p.data.skipped) out.add(s.source);
  }
  return out;
}

export type ChangelogDispatch =
  | { kind: 'fail'; error: string }
  /** Nothing new to write: the runner gets no entries and leaves the file as it is. */
  | { kind: 'apply'; entries: [] }
  /** These changes need entries written. */
  | { kind: 'write'; uncovered: string[] };

/** Pure: the decision for one repository. `facts` is used only when it was read at the analysed head. */
export function decideChangelogDispatch(i: {
  summary: ReleaseDocsPrepSummary | null;
  hasCapability: boolean;
  facts: { headSha: string; changelog: string | null } | null;
  covered: ReadonlySet<string>;
}): ChangelogDispatch {
  if (!i.summary) return { kind: 'fail', error: NEEDS_ANALYSE };
  if (!i.hasCapability) return { kind: 'fail', error: NEEDS_RUNNER };
  if (i.facts && i.facts.headSha === i.summary.headSha && i.facts.changelog !== null) {
    const { errors } = checkChangelog(i.facts.changelog);
    if (errors.length > 0) return { kind: 'fail', error: errors.join(' ') };
  }
  const uncovered = summarySources(i.summary).filter((s) => !i.covered.has(s));
  return uncovered.length === 0 ? { kind: 'apply', entries: [] } : { kind: 'write', uncovered };
}

/** The part of the runner's report that is stored: schema-checked, with the proposal's lists, at most 64 KB. */
export function storedChangelogOutput(
  output: unknown,
  payloadChangelog: unknown,
): ReleaseChangelogOutput | undefined {
  if (output === undefined) return undefined;
  const sent = ReleasePrepChangelogPayloadSchema.safeParse(payloadChangelog);
  const proposal = sent.success ? sent.data.proposal : undefined;
  const base = typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : {};
  const parsed = ReleaseChangelogOutputSchema.safeParse({
    ...base,
    ...(proposal ? { covered: proposal.covered, skipped: proposal.skipped } : {}),
  });
  if (!parsed.success) return undefined;
  return JSON.stringify(parsed.data).length <= RELEASE_DOCS_PREP_OUTPUT_MAX_BYTES ? parsed.data : undefined;
}

/** Generic size cap for the other content steps' output. */
export function storedStepOutput(step: string, output: unknown, payloadChangelog: unknown): unknown {
  if (step === 'changelog') return storedChangelogOutput(output, payloadChangelog);
  if (output === undefined) return undefined;
  const json = JSON.stringify(output);
  return json !== undefined && json.length <= RELEASE_DOCS_PREP_OUTPUT_MAX_BYTES ? output : undefined;
}

/** Reads what the decision needs for one repository of a run. */
export async function changelogDispatchFor(
  db: Queryable,
  /** A release_docs_prep_runs row. */
  run: Row,
  /** A release_docs_prep_repos row. */
  repo: Row,
  summary: ReleaseDocsPrepSummary | null,
): Promise<ChangelogDispatch> {
  const cap = await one(
    db,
    'SELECT 1 FROM workstation_capabilities WHERE workstation_id=$1 AND $2 = ANY (capabilities)',
    [repo.workstation_id, RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY],
  );
  const covered = await coveredSourcesFor(db, run, repo);
  const f = await loadFacts(db, repo.repo_id);
  const facts = f?.facts ? { headSha: f.facts.headSha, changelog: f.facts.changelog ?? null } : null;
  return decideChangelogDispatch({ summary, hasCapability: !!cap, facts, covered });
}

/** The sources earlier passed runs of the same release (branch, repository, base tag) already handled. */
export async function coveredSourcesFor(db: Queryable, run: Row, repo: Row): Promise<Set<string>> {
  const earlier = await rows(
    db,
    `SELECT s.output, r.commit_sha FROM release_docs_prep_runs u
       JOIN release_docs_prep_repos r ON r.run_id = u.id
       LEFT JOIN release_docs_prep_steps s ON s.run_id = u.id AND s.repo_id = r.repo_id AND s.step = 'changelog'
      WHERE u.project_id=$1 AND u.release_branch=$2 AND u.status='passed' AND u.id <> $3
        AND r.repo_id=$4 AND r.base_tag IS NOT DISTINCT FROM $5`,
    [run.project_id, run.release_branch, run.id, repo.repo_id, repo.base_tag],
  );
  return coveredSourcesOf(
    earlier.map((e) => e.output).filter((o) => o != null),
    earlier.map((e) => e.commit_sha).filter((c): c is string => typeof c === 'string'),
  );
}

/**
 * Marks the step running (no runner command yet) and queues the BA task that proposes the entries for one repository.
 * At most one open task per (run, repository).
 */
export async function queueChangelogTask(ctx: Ctx, tx: Tx, run: Row, repoId: string): Promise<void> {
  const open = await one(
    tx,
    `SELECT 1 FROM ba_tasks WHERE prep_run_id=$1 AND prep_repo_id=$2 AND status IN ('queued','running')`,
    [run.id, repoId],
  );
  const scope = projectScope(run.org_id, run.project_id);
  const actor = run.started_by ? userActor(run.started_by) : SYSTEM_ACTOR;
  const taskId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.releaseDocsPrep(run.id),
        event: { type: 'ReleaseDocsPrepStepStarted', payload: { runId: run.id, repoId, step: 'changelog' } },
        actor,
        scope,
      },
      ...(open
        ? []
        : [
            {
              streamId: streamId.baTask(taskId),
              event: {
                type: 'BaTaskQueued' as const,
                payload: {
                  taskId,
                  projectId: run.project_id,
                  kind: 'release_changelog' as const,
                  prepRunId: run.id,
                  prepRepoId: repoId,
                },
              },
              actor,
              scope,
            },
          ]),
    ],
    { tx },
  );
}
