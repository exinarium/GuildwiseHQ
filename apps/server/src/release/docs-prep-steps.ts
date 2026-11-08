import {
  type AgentRuntimeSpec,
  DEFAULT_GUIDE_PATH,
  guideOutputSources,
  type ReleaseDocsPrepGuideInput,
  releaseVersionFromBranch,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { agentSpecFor } from '../runner-gateway/brief.ts';

/**
 * The server twin of the runner's step handlers: what a content step of Release prep (docs and videos) gets in its
 * payload besides the common fields. A step without an entry gets nothing extra.
 */
export interface DocsPrepStepHook {
  stepInput?: (db: Queryable, run: Row, repo: Row) => Promise<Record<string, unknown>>;
  /** The step needs an agent to write its text (`payload.writer`). */
  needsWriter?: boolean;
}

const COVERED_MAX = 2000;

/**
 * The change ids that earlier passed runs of this release already dealt with in a repository's guide: their 'guide'
 * output, in passed runs of the same project, release branch and repository since the last published ship.
 */
export async function guideCoveredSources(db: Queryable, run: Row, repoId: string): Promise<string[]> {
  const found = await rows(
    db,
    `SELECT s.output FROM release_docs_prep_steps s JOIN release_docs_prep_runs u ON u.id = s.run_id
      WHERE u.project_id=$1 AND u.release_branch=$2 AND s.repo_id=$3 AND s.step='guide' AND s.state='passed'
        AND u.status='passed' AND u.id <> $4 AND s.output IS NOT NULL
        AND u.started_at >= COALESCE((SELECT MAX(x.published_at) FROM release_ships x JOIN project_repos pr ON pr.id = x.repo_id
                                       WHERE pr.project_id = $1 AND x.status='published'), '-infinity'::timestamptz)
      ORDER BY u.started_at DESC`,
    [run.project_id, run.release_branch, repoId, run.id],
  );
  const out = new Set<string>();
  for (const r of found) for (const s of guideOutputSources(r.output)) if (out.size < COVERED_MAX) out.add(s);
  return [...out];
}

/** A Postgres `date` (built at local midnight by pg) or `timestamptz` as YYYY-MM-DD. */
function isoDay(v: unknown, utc: boolean): string {
  const d = v instanceof Date ? v : new Date(String(v));
  if (utc) return d.toISOString().slice(0, 10);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The release being prepared, for the PDF guide's cover and footer: its version (the live proposal, else the release
 * branch name), its date and the day the run started. The release only gets a date at approval and docs prep runs
 * before that, so `date` is normally null here and the runner falls back to `runDate`.
 */
export async function guideRelease(
  db: Queryable,
  run: Row,
  repo: Row,
): Promise<NonNullable<ReleaseDocsPrepGuideInput['release']>> {
  const p = await one(
    db,
    `SELECT COALESCE(version, recommended_version) AS v FROM release_proposals
      WHERE repo_id=$1 AND state IN ('proposed','approved') ORDER BY updated_at DESC LIMIT 1`,
    [repo.repo_id],
  );
  const version: string | null = p?.v ?? releaseVersionFromBranch(String(repo.branch ?? ''));
  const ship = version
    ? await one(
        db,
        `SELECT release_date FROM release_ships WHERE repo_id=$1 AND version=$2 AND status <> 'failed'`,
        [repo.repo_id, version],
      )
    : null;
  return {
    version,
    date: ship ? isoDay(ship.release_date, false) : null,
    runDate: isoDay(run.started_at, true),
  };
}

export const DOCS_PREP_STEP_HOOKS: Record<string, DocsPrepStepHook> = {
  guide: {
    needsWriter: true,
    stepInput: async (db, run, repo): Promise<ReleaseDocsPrepGuideInput> => ({
      guidePath: DEFAULT_GUIDE_PATH,
      coveredSources: await guideCoveredSources(db, run, repo.repo_id),
      denyList: [],
      release: await guideRelease(db, run, repo),
    }),
  },
};

const WRITER_ROLES = ['architect', 'ba', 'builder'];

/**
 * The agent that writes a step's text: an active agent of the run's organization hosted on the workstation that has
 * the repository, preferring an architect, then a business analyst, then a builder (by name). Null: there is none.
 */
export async function docsPrepWriter(
  ctx: Ctx,
  db: Queryable,
  run: Row,
  repo: Row,
): Promise<AgentRuntimeSpec | null> {
  const a = await one(
    db,
    `SELECT a.* FROM agents a
      WHERE a.workstation_id = $1 AND a.org_id = $2 AND a.status = 'active' AND a.role_key = ANY($3::text[])
      ORDER BY array_position($3::text[], a.role_key), a.name, a.id LIMIT 1`,
    [repo.workstation_id, run.org_id, WRITER_ROLES],
  );
  return a ? agentSpecFor(ctx, a) : null;
}
