import { randomUUID } from 'node:crypto';
import {
  isBusinessOrg,
  isResearchStage,
  RELEASE_FACTS_CAPABILITY,
  RepoReleaseFactsResultSchema,
  type ReleaseFacts,
  ReleaseFactsSchema,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable } from '../db/sql.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { reconcileReleaseProposal } from './reconcile.ts';
import { loadComponentRules } from './rules.ts';

export type FactsTrigger = 'release_pr' | 'sync' | 'manual';

const PENDING_MS = 5 * 60_000;
const SYNC_MS = 30 * 60_000;

export type RequestFactsOutcome =
  | { queued: true; requestId: string }
  | { queued: false; reason: 'skipped' | 'throttled' | 'no_clone' | 'old_runner' };

/**
 * Asks a workstation that holds the clone to read the repository (`repo.release_facts`, read-only). `sync` is the
 * heartbeat trigger: it asks at most every 30 minutes and uses the workstation that reported. Other triggers go to the
 * owner's own workstation first.
 */
export async function requestReleaseFacts(
  ctx: Ctx,
  repoId: string,
  trigger: FactsTrigger,
  opts: { workstationId?: string; userId?: string } = {},
): Promise<RequestFactsOutcome> {
  const now = ctx.clock.now();
  const repo = await one(
    ctx.pool,
    `SELECT r.*, p.org_id, p.working_branch AS project_branch, p.workflow_key
       FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE r.id=$1 AND r.removed_at IS NULL AND p.status='active'`,
    [repoId],
  );
  if (!repo) return { queued: false, reason: 'skipped' };
  const head: string | null = repo.working_branch ?? repo.project_branch ?? null;
  if (!head || (repo.main_branch && repo.main_branch === head) || isResearchStage(repo.workflow_key))
    return { queued: false, reason: 'skipped' };
  const org = await one(ctx.pool, 'SELECT mode, simulation FROM organizations WHERE id=$1', [repo.org_id]);
  if (isBusinessOrg(org) || org?.simulation) return { queued: false, reason: 'skipped' };

  const prior = await one(
    ctx.pool,
    'SELECT state, requested_at, updated_at FROM repo_release_facts WHERE project_repo_id=$1',
    [repoId],
  );
  if (prior?.state === 'pending' && now.getTime() - new Date(prior.requested_at).getTime() < PENDING_MS)
    return { queued: false, reason: 'throttled' };
  if (trigger === 'sync' && prior && now.getTime() - new Date(prior.updated_at).getTime() < SYNC_MS)
    return { queued: false, reason: 'throttled' };

  const capable = (await one(
    ctx.pool,
    `SELECT 1 FROM workstation_capabilities WHERE workstation_id = $1 AND $2 = ANY (capabilities)`,
    [opts.workstationId ?? '00000000-0000-0000-0000-000000000000', RELEASE_FACTS_CAPABILITY],
  ))
    ? true
    : false;
  const ws =
    trigger === 'sync' && opts.workstationId
      ? capable
        ? { id: opts.workstationId as string }
        : undefined
      : await one(
          ctx.pool,
          `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
             JOIN workstation_capabilities wc ON wc.workstation_id = w.id
            WHERE wr.project_repo_id=$1 AND w.status='active' AND $3 = ANY (wc.capabilities)
            ORDER BY (w.user_id = $2::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
          [repoId, opts.userId ?? null, RELEASE_FACTS_CAPABILITY],
        );
  if (!ws) {
    const anyClone = await one(ctx.pool, 'SELECT 1 FROM workstation_repos WHERE project_repo_id=$1', [repoId]);
    return { queued: false, reason: anyClone ? 'old_runner' : 'no_clone' };
  }

  const rules = await loadComponentRules(ctx.pool, repoId);
  const requestId = randomUUID();
  await exec(
    ctx.pool,
    `INSERT INTO repo_release_facts (project_repo_id, request_id, workstation_id, trigger, state, requested_at, updated_at)
     VALUES ($1,$2,$3,$4,'pending',$5,$5)
     ON CONFLICT (project_repo_id) DO UPDATE SET request_id=EXCLUDED.request_id, workstation_id=EXCLUDED.workstation_id,
       trigger=EXCLUDED.trigger, state=CASE WHEN repo_release_facts.facts IS NULL THEN 'pending' ELSE repo_release_facts.state END,
       requested_at=EXCLUDED.requested_at`,
    [repoId, requestId, ws.id, trigger, now],
  );
  await enqueueRunnerCommand(ctx.pool, ws.id, 'repo.release_facts', {
    requestId,
    projectId: repo.project_id,
    repoId,
    remoteUrlNormalized: repo.remote_url_normalized,
    head,
    ...(repo.main_branch ? { base: repo.main_branch } : {}),
    ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
    components: rules,
  });
  void Promise.resolve(ctx.services.gateway.deliverPending(ws.id)).catch(() => undefined);
  return { queued: true, requestId };
}

/** `command.result` of `repo.release_facts`: stores the facts (or the message) and reconciles the proposal. */
export async function applyReleaseFactsResult(
  ctx: Ctx,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const requestId = String(payload.requestId ?? '');
  const repoId = String(payload.repoId ?? '');
  const row = await one(
    ctx.pool,
    'SELECT trigger FROM repo_release_facts WHERE project_repo_id=$1 AND request_id=$2',
    [repoId, requestId],
  );
  if (!row) return; // a newer request replaced this one
  const parsed = RepoReleaseFactsResultSchema.safeParse(result);
  const r = ok && parsed.success ? parsed.data : undefined;
  const now = ctx.clock.now();
  if (!r || !r.ok || !r.headSha) {
    const message = r?.error ?? error ?? 'the workstation could not read the repository';
    await exec(
      ctx.pool,
      `UPDATE repo_release_facts SET state=CASE WHEN facts IS NULL THEN 'failed' ELSE state END, message=$3, updated_at=$4
        WHERE project_repo_id=$1 AND request_id=$2`,
      [repoId, requestId, message, now],
    );
    return;
  }
  const facts: ReleaseFacts = ReleaseFactsSchema.parse({
    ...r,
    headSha: r.headSha,
    ahead: r.ahead ?? 0,
    lastTag: r.lastTag ?? null,
    changelog: r.changelog ?? null,
  });
  await exec(
    ctx.pool,
    `UPDATE repo_release_facts SET state='ready', message=NULL, head_sha=$3, facts=$4::jsonb, updated_at=$5
      WHERE project_repo_id=$1 AND request_id=$2`,
    [repoId, requestId, facts.headSha, JSON.stringify(facts), now],
  );
  const trigger = row.trigger === 'release_pr' ? 'release_pr' : row.trigger === 'manual' ? 'manual' : 'ahead';
  await reconcileReleaseProposal(ctx, repoId, trigger);
}

/** The stored facts of a repository, or null while nothing was read. */
export async function loadFacts(
  db: Queryable,
  repoId: string,
): Promise<{ facts: ReleaseFacts | null; state: 'pending' | 'ready' | 'failed'; message: string | null; at: Date | null; headSha: string | null } | null> {
  const r = await one(db, 'SELECT * FROM repo_release_facts WHERE project_repo_id=$1', [repoId]);
  if (!r) return null;
  const parsed = r.facts ? ReleaseFactsSchema.safeParse(r.facts) : null;
  return {
    facts: parsed?.success ? parsed.data : null,
    state: r.state,
    message: r.message ?? null,
    at: r.updated_at ? new Date(r.updated_at) : null,
    headSha: r.head_sha ?? null,
  };
}
