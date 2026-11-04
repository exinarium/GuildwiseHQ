import {
  type AgentRuntimeSpec,
  DEFAULT_GUIDE_PATH,
  guideOutputSources,
  type ReleaseDocsPrepGuideInput,
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

export const DOCS_PREP_STEP_HOOKS: Record<string, DocsPrepStepHook> = {
  guide: {
    needsWriter: true,
    stepInput: async (db, run, repo): Promise<ReleaseDocsPrepGuideInput> => ({
      guidePath: DEFAULT_GUIDE_PATH,
      coveredSources: await guideCoveredSources(db, run, repo.repo_id),
      denyList: [],
    }),
  },
};

const WRITER_ROLES = ['architect', 'ba', 'builder'];

/**
 * The agent that writes a step's text: an active agent of the run's organization hosted on the workstation that has
 * the repository, preferring an architect, then a business analyst, then a builder (by name). Null: there is none.
 */
export async function docsPrepWriter(ctx: Ctx, db: Queryable, run: Row, repo: Row): Promise<AgentRuntimeSpec | null> {
  const a = await one(
    db,
    `SELECT a.* FROM agents a
      WHERE a.workstation_id = $1 AND a.org_id = $2 AND a.status = 'active' AND a.role_key = ANY($3::text[])
      ORDER BY array_position($3::text[], a.role_key), a.name, a.id LIMIT 1`,
    [repo.workstation_id, run.org_id, WRITER_ROLES],
  );
  return a ? agentSpecFor(ctx, a) : null;
}
