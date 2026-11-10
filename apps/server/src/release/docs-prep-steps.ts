import {
  DEFAULT_GUIDE_PATH,
  DEFAULT_HELP_DIR,
  guideOutputSources,
  helpOutputSources,
  normalizeGuidePath,
  type ReleaseDocsPrepGuideInput,
  type ReleaseDocsPrepHelpInput,
  releaseVersionFromBranch,
} from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';

/**
 * The server twin of the runner's step handlers: what a content step of Release prep (docs and videos) gets in its
 * payload besides the common fields. A step without an entry gets nothing extra.
 */
export interface DocsPrepStepHook {
  stepInput?: (db: Queryable, run: Row, repo: Row) => Promise<Record<string, unknown>>;
}

const COVERED_MAX = 2000;

/**
 * The change ids that earlier passed runs of this release already dealt with in one content step of a repository: the
 * step's output, in passed runs of the same project, release branch and repository since the last published ship.
 */
export async function stepCoveredSources(
  db: Queryable,
  run: Row,
  repoId: string,
  step: string,
  sourcesOf: (output: unknown) => string[],
): Promise<string[]> {
  const found = await rows(
    db,
    `SELECT s.output FROM release_docs_prep_steps s JOIN release_docs_prep_runs u ON u.id = s.run_id
      WHERE u.project_id=$1 AND u.release_branch=$2 AND s.repo_id=$3 AND s.step=$5 AND s.phase IN ('', 'apply') AND s.state='passed'
        AND u.status='passed' AND u.id <> $4 AND s.output IS NOT NULL
        AND u.started_at >= COALESCE((SELECT MAX(x.published_at) FROM release_ships x JOIN project_repos pr ON pr.id = x.repo_id
                                       WHERE pr.project_id = $1 AND x.status='published'), '-infinity'::timestamptz)
      ORDER BY u.started_at DESC`,
    [run.project_id, run.release_branch, repoId, run.id, step],
  );
  const out = new Set<string>();
  for (const r of found) for (const s of sourcesOf(r.output)) if (out.size < COVERED_MAX) out.add(s);
  return [...out];
}

/** The change ids earlier passed runs of this release already dealt with in a repository's guide. */
export const guideCoveredSources = (db: Queryable, run: Row, repoId: string): Promise<string[]> =>
  stepCoveredSources(db, run, repoId, 'guide', guideOutputSources);

/** The change ids earlier passed runs of this release already dealt with in a repository's Help articles. */
export const helpCoveredSources = (db: Queryable, run: Row, repoId: string): Promise<string[]> =>
  stepCoveredSources(db, run, repoId, 'help', helpOutputSources);

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

/** The user guide paths stored in a project's release_docs_prep value (valid, non-default entries only). */
export function configuredGuidePaths(settings: unknown): Record<string, string> {
  const raw = (settings as { guidePaths?: unknown } | null | undefined)?.guidePaths;
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object')
    for (const [id, v] of Object.entries(raw)) {
      const c = typeof v === 'string' ? normalizeGuidePath(v) : null;
      if (c?.ok && c.path) out[id] = c.path;
    }
  return out;
}

/** The repository's own user guide path, or null when it has none (the default applies). */
export async function guidePathFor(db: Queryable, projectId: string, repoId: string): Promise<string | null> {
  const p = await one(db, 'SELECT release_docs_prep FROM projects WHERE id=$1', [projectId]);
  return configuredGuidePaths(p?.release_docs_prep)[repoId] ?? null;
}

export const DOCS_PREP_STEP_HOOKS: Record<string, DocsPrepStepHook> = {
  guide: {
    // The path is read when the step is dispatched, so a Retry after fixing the setting uses the new value.
    stepInput: async (db, run, repo): Promise<ReleaseDocsPrepGuideInput> => {
      const configured = await guidePathFor(db, run.project_id, repo.repo_id);
      return {
        guidePath: configured ?? DEFAULT_GUIDE_PATH,
        guidePathConfigured: configured !== null,
        repoName: String(repo.name ?? ''),
        coveredSources: await guideCoveredSources(db, run, repo.repo_id),
        denyList: [],
        release: await guideRelease(db, run, repo),
      };
    },
  },
  help: {
    stepInput: async (db, run, repo): Promise<ReleaseDocsPrepHelpInput> => ({
      helpDir: DEFAULT_HELP_DIR,
      coveredSources: await helpCoveredSources(db, run, repo.repo_id),
      denyList: [],
    }),
  },
};
