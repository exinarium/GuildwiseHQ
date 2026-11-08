import { type ReadinessRepoInput, type ReleaseReadiness, releaseReadiness, sameCommit } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { environmentRoles } from '../delivery/environments.ts';
import { evaluateEnvGate, latestMerge } from '../delivery/gate.ts';
import { envRepo } from '../delivery/runs.ts';
import { HttpError } from '../errors.ts';
import {
  deliverAll,
  docsPrepRepos,
  latestRun,
  lockProjectForStart,
  releaseBranchOf,
  startRunInTx,
} from './docs-prep.ts';
import { loadFacts } from './facts.ts';

/** How often one project's readiness is worked out by the automatic start (a cost limit, not a correctness rule). */
export const AUTO_CHECK_MS = 60_000;

/** The release-branch head: the facts' head, or a newer merge into the repository when the facts are older. */
async function releaseHead(db: Queryable, projectId: string, repoId: string): Promise<string | null> {
  const f = await loadFacts(db, repoId);
  if (!f || f.state !== 'ready' || !f.headSha) return null;
  const merge = await latestMerge(db, projectId, repoId);
  if (merge && f.at && new Date(merge.at) > f.at && !sameCommit(merge.commit, f.headSha)) return merge.commit;
  return f.headSha;
}

type EnvInput = ReadinessRepoInput['envs'][number];

/** The latest deploys of one environment: what runs there now, whether an update is on its way or the last failed. */
async function envDeploys(
  db: Queryable,
  projectId: string,
  env: string,
): Promise<Pick<EnvInput, 'current' | 'updating' | 'lastFailed'>> {
  const runs = await rows(
    db,
    `SELECT status, refusal, COALESCE(deployed_commit, commit) AS commit, health FROM deploy_runs
      WHERE project_id=$1 AND env=$2 AND NOT trial AND NOT dry_run ORDER BY created_at DESC LIMIT 20`,
    [projectId, env],
  );
  let current: EnvInput['current'] = null;
  let updating = false;
  let lastFailed = false;
  let finishedSeen = false;
  for (const r of runs) {
    if (r.status === 'succeeded') {
      const ok = (r.health as { ok?: boolean } | null)?.ok;
      current = { commit: r.commit ?? null, healthy: ok === undefined ? null : !!ok };
      break;
    }
    if (r.status === 'queued' || r.status === 'running') updating = true;
    else if (!finishedSeen && (r.status === 'failed' || (r.status === 'refused' && r.refusal === 'expired'))) {
      lastFailed = true;
      finishedSeen = true;
    } else if (r.status !== 'waiting_release') finishedSeen = true;
  }
  return { current, updating, lastFailed };
}

/** Whether the project's current release is ready on the test site, with a reason per repository. */
export async function loadReleaseReadiness(
  db: Queryable,
  project: Row,
  now: Date = new Date(),
): Promise<ReleaseReadiness & { branch: string | null }> {
  const projectId = String(project.id);
  const branch = await releaseBranchOf(db, projectId, project.working_branch ?? null);
  const repos = await docsPrepRepos(db, projectId);
  const envs = await environmentRoles(db, projectId);
  const repoOf = new Map<string, string | null>();
  for (const e of envs) repoOf.set(e.name, (await envRepo(db, projectId, e.recipeEnv?.repo))?.id ?? null);
  const input: ReadinessRepoInput[] = [];
  for (const r of repos) {
    const head = await releaseHead(db, projectId, r.id);
    const tests: EnvInput[] = [];
    for (const e of envs.filter((x) => x.role === 'test' && repoOf.get(x.name) === r.id)) {
      const d = await envDeploys(db, projectId, e.name);
      let gate: EnvInput['gate'] = null;
      if (head && d.current && sameCommit(d.current.commit, head) && e.recipeEnv)
        gate = await evaluateEnvGate(db, {
          orgId: project.org_id,
          projectId,
          env: e.recipeEnv as never,
          production: e.production,
          commit: head,
          now,
          repoId: r.id,
        });
      else if (head && d.current && sameCommit(d.current.commit, head))
        gate = { satisfied: true, missing: [] };
      tests.push({ name: e.name, label: e.label, ...d, gate });
    }
    const testReady = tests.some(
      (t) =>
        !t.updating && !t.lastFailed && t.current?.healthy !== false && sameCommit(t.current?.commit, head) && t.gate?.satisfied,
    );
    const live: ReadinessRepoInput['live'] = [];
    for (const e of envs.filter((x) => x.role === 'live' && repoOf.get(x.name) === r.id)) {
      const requires =
        testReady && head && e.recipeEnv
          ? await evaluateEnvGate(db, {
              orgId: project.org_id,
              projectId,
              env: e.recipeEnv as never,
              production: e.production,
              commit: head,
              now,
              repoId: r.id,
              requiresOnly: true,
            })
          : testReady && head
            ? { satisfied: true, missing: [] }
            : null;
      live.push({
        name: e.name,
        label: e.label,
        requires: requires ? { satisfied: requires.satisfied, missing: requires.missing } : null,
      });
    }
    input.push({
      repoId: r.id,
      repoName: r.name,
      head,
      envs: tests.map((t) => ({
        ...t,
        gate: t.gate ? { satisfied: t.gate.satisfied, missing: t.gate.missing } : null,
      })),
      live,
    });
  }
  return { ...releaseReadiness(input), branch };
}

const lastCheck = new Map<string, number>();
const logged = new Set<string>();

/** Forget the cost limit (tests). */
export function resetReleaseDocsPrepAutoStart(): void {
  lastCheck.clear();
  logged.clear();
}

const CANDIDATES = `SELECT p.* FROM projects p JOIN organizations o ON o.id = p.org_id
  WHERE p.status='active' AND p.kind='project' AND o.status IN ('trial','active') AND NOT COALESCE(o.simulation, false)
    AND COALESCE((p.release_docs_prep->>'enabled')::boolean, false)
    AND COALESCE((p.release_docs_prep->>'autoStart')::boolean, false)`;

/**
 * Dispatcher step: starts release prep for every project whose release is ready on the test site, the automatic start
 * is on and the release has no run yet in this cycle. State based, so a missed event, a time-based requirement or a
 * restart is caught by the next pass; the project row lock and a unique index keep it to one run.
 */
export async function releaseDocsPrepAutoStart(ctx: Ctx, opts: { force?: boolean } = {}): Promise<void> {
  const nowMs = ctx.clock.now().getTime();
  for (const p of await rows(ctx.pool, CANDIDATES)) {
    const id = String(p.id);
    if (!opts.force && nowMs - (lastCheck.get(id) ?? Number.NEGATIVE_INFINITY) < AUTO_CHECK_MS) continue;
    lastCheck.set(id, nowMs);
    const branch = await releaseBranchOf(ctx.pool, id, p.working_branch ?? null);
    if (!branch || (await latestRun(ctx.pool, id, branch))) continue;
    const ready = await loadReleaseReadiness(ctx.pool, p, ctx.clock.now());
    if (!ready.ready || !ready.key) continue;
    try {
      const out = await withAppendTx(ctx.pool, async (tx) => {
        const locked = await lockProjectForStart(tx, id);
        const s = (locked.release_docs_prep ?? {}) as { enabled?: unknown; autoStart?: unknown };
        if (s.enabled !== true || s.autoStart !== true) return null;
        const b = await releaseBranchOf(tx, id, locked.working_branch ?? null);
        if (!b || (await latestRun(tx, id, b))) return null;
        const again = await loadReleaseReadiness(tx, locked, ctx.clock.now());
        if (!again.ready || again.key !== ready.key || !again.key) return null;
        return startRunInTx(ctx, tx, locked, { kind: 'auto', heads: again.heads, readyKey: again.key });
      });
      if (out) deliverAll(ctx, out.deliver);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') continue;
      if (err instanceof HttpError && err.status === 409) {
        const k = `${id}:${ready.key}:${err.code}`;
        if (!logged.has(k)) {
          logged.add(k);
          ctx.log.info({ projectId: id, code: err.code }, 'release prep did not start by itself');
        }
        continue;
      }
      throw err;
    }
  }
}
