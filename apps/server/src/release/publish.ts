import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  noReleasePageText,
  RELEASE_PUBLISH_CAPABILITY,
  type ReleasePublishPayload,
  ReleasePublishPayloadSchema,
  ReleasePublishResultSchema,
  releaseTitle,
  streamId,
} from '@aom/shared';
import { loadCommitAs } from '../commands/commit-as.ts';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { withAppendTx } from '../db/tx.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { appendReleaseFailure } from './ship.ts';

const FIRST_DAY_SECONDS = 180;
const LATER_SECONDS = 3600;

/** A workstation with the clone that announces `release-publish:1`: the ship's own first, then the one seen last. */
async function publishWorkstation(db: Queryable, ship: Row): Promise<string | null> {
  const ws = await one(
    db,
    `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE wr.project_repo_id=$1 AND w.status='active' AND w.connected AND $3 = ANY (wc.capabilities)
      ORDER BY (w.id = $2::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
    [ship.repo_id, ship.workstation_id, RELEASE_PUBLISH_CAPABILITY],
  );
  return ws?.id ?? null;
}

/**
 * The `release.publish` payload of a committed ship. Read again on every send: the release name, the commit identity
 * and the release PR address may have changed since the commit.
 */
export async function publishPayloadOf(tx: Queryable, ship: Row): Promise<ReleasePublishPayload | null> {
  const proposal = await one(tx, 'SELECT notes, notes_source FROM release_proposals WHERE id=$1', [ship.id]);
  const repo = await one(
    tx,
    `SELECT r.remote_url_normalized, r.forge_kind, r.main_branch, r.release_name,
            COALESCE(r.working_branch, p.working_branch) AS working_branch, p.name AS project_name
       FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE r.id=$1`,
    [ship.repo_id],
  );
  if (!repo || !ship.commit_sha) return null;
  const pr = await one(
    tx,
    `SELECT url FROM repo_pr_requests WHERE repo_id=$1 AND state='opened' AND url IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    [ship.repo_id],
  );
  const stored = ship.payload as { workingBranch?: string };
  const name = String(repo.release_name ?? '').trim() || repo.project_name || 'Release';
  return ReleasePublishPayloadSchema.parse({
    shipId: ship.id,
    projectId: ship.project_id,
    repoId: ship.repo_id,
    remoteUrlNormalized: repo.remote_url_normalized,
    ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
    version: ship.version,
    tag: `v${ship.version}`,
    title: releaseTitle(name, ship.version),
    workingBranch: stored.workingBranch ?? repo.working_branch,
    ...(repo.main_branch ? { mainBranch: repo.main_branch } : {}),
    releaseCommitSha: ship.commit_sha,
    land:
      ship.land_mode === 'merge'
        ? { mode: 'merge' }
        : { mode: 'pr', ...((pr?.url ?? ship.pr_url) ? { prUrl: pr?.url ?? ship.pr_url } : {}) },
    notesSource: proposal?.notes_source === 'commits' ? 'commits' : 'changelog',
    ...(proposal?.notes_source === 'commits' && proposal.notes ? { notes: proposal.notes } : {}),
    commitAs: await loadCommitAs(tx, ship.project_id),
  });
}

/**
 * Queues `release.publish` for a ship. Returns the workstation to deliver to, or null when none can run it (the reason is
 * kept on the ship for the repository row, and the next pass tries again).
 */
export async function enqueueReleasePublish(tx: Tx, ship: Row, now: Date): Promise<string | null> {
  const workstationId = await publishWorkstation(tx, ship);
  if (!workstationId) {
    await exec(
      tx,
      `UPDATE release_ships SET step_message=$2, publish_checked_at=$3 WHERE id=$1`,
      [ship.id, 'Waiting for a workstation with an up-to-date runner and this repository', now],
    );
    return null;
  }
  const payload = await publishPayloadOf(tx, ship);
  if (!payload) return null;
  await enqueueRunnerCommand(tx, workstationId, 'release.publish', payload as never);
  await exec(tx, `UPDATE release_ships SET publish_checked_at=$2 WHERE id=$1`, [ship.id, now]);
  return workstationId;
}

/**
 * Right after `ReleaseCommitted`, in its transaction: decides how the release reaches main. A release PR is open or asked
 * for when the project completes work with pull requests; otherwise Guildwise merges the release commit itself.
 */
export async function planReleasePublish(ctx: Ctx, tx: Tx, shipId: string): Promise<string | null> {
  const ship = await one(tx, 'SELECT * FROM release_ships WHERE id=$1 FOR UPDATE', [shipId]);
  if (!ship) return null;
  const project = await one(tx, 'SELECT default_completion FROM projects WHERE id=$1', [ship.project_id]);
  const req = await one(
    tx,
    `SELECT url, state FROM repo_pr_requests WHERE repo_id=$1 AND state IN ('pending','opened') ORDER BY created_at DESC LIMIT 1`,
    [ship.repo_id],
  );
  let mode: 'pr' | 'merge' = 'merge';
  let prUrl: string | undefined;
  if (req) {
    mode = 'pr';
    prUrl = req.url ?? undefined;
  } else if (project?.default_completion === 'pr') {
    mode = 'pr';
    await requestReleasePrForShip(ctx, tx, ship);
  }
  await ctx.store.append(
    [
      {
        streamId: streamId.release(ship.id),
        event: {
          type: 'ReleasePublishPlanned',
          payload: { shipId: ship.id, landMode: mode, ...(prUrl ? { prUrl } : {}) },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(ship.org_id, ship.project_id),
      },
    ],
    { tx },
  );
  const fresh = await one(tx, 'SELECT * FROM release_ships WHERE id=$1', [shipId]);
  return fresh ? enqueueReleasePublish(tx, fresh, ctx.clock.now()) : null;
}

/** Asks the ship's workstation for the release PR (the internals of "Open release PR", as the system). */
async function requestReleasePrForShip(ctx: Ctx, tx: Tx, ship: Row): Promise<void> {
  const repo = await one(tx, 'SELECT * FROM project_repos WHERE id=$1', [ship.repo_id]);
  const project = await one(tx, 'SELECT working_branch FROM projects WHERE id=$1', [ship.project_id]);
  if (!repo || !ship.workstation_id) return;
  const head: string = repo.working_branch ?? project?.working_branch;
  if (!head || (repo.main_branch && repo.main_branch === head)) return;
  const requestId = randomUUID();
  const now = ctx.clock.now();
  await exec(
    tx,
    `INSERT INTO repo_pr_requests (request_id, project_id, repo_id, workstation_id, requested_by, head, base, created_at, updated_at)
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$7)`,
    [requestId, ship.project_id, ship.repo_id, ship.workstation_id, head, repo.main_branch ?? null, now],
  );
  await enqueueRunnerCommand(tx, ship.workstation_id, 'repo.open_pr', {
    requestId,
    projectId: ship.project_id,
    repoId: ship.repo_id,
    remoteUrlNormalized: repo.remote_url_normalized,
    head,
    ...(repo.main_branch ? { base: repo.main_branch } : {}),
    title: `Release ${ship.version}: merge ${head} into ${repo.main_branch ?? 'the main branch'}`,
    body: `Brings the work integrated on ${head}, with the release commit for ${ship.version}, into ${repo.main_branch ?? 'the main branch'}.`,
    ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
  } as never);
}

/**
 * The dispatcher pass: asks each committed or tagged ship of an approved proposal whether it reached main, tags it and
 * publishes it. Ships that are committing or failed, and proposals that were not approved, never get the command.
 */
export async function releaseChecks(ctx: Ctx): Promise<void> {
  const due = await rows(
    ctx.pool,
    `SELECT s.* FROM release_ships s
       JOIN release_proposals p ON p.id = s.id AND p.state='approved'
       JOIN projects pr ON pr.id = s.project_id AND pr.status='active'
       JOIN organizations o ON o.id = pr.org_id AND o.status IN ('trial','active')
      WHERE s.status IN ('committed','tagged')
        AND NOT EXISTS (
          SELECT 1 FROM runner_commands rc
           WHERE rc.type='release.publish' AND rc.payload->>'shipId' = s.id::text
             AND (rc.status IN ('pending','sent')))
        AND (s.publish_checked_at IS NULL
             OR s.publish_checked_at < $1::timestamptz - make_interval(secs => CASE WHEN s.updated_at > $1::timestamptz - interval '24 hours' THEN $2::int ELSE $3::int END))`,
    [ctx.clock.now(), FIRST_DAY_SECONDS, LATER_SECONDS],
  );
  const touched = new Set<string>();
  for (const s of due) {
    const ws = await withAppendTx(ctx.pool, async (tx) => {
      const live = await one(tx, `SELECT * FROM release_ships WHERE id=$1 AND status IN ('committed','tagged') FOR UPDATE`, [
        s.id,
      ]);
      return live ? enqueueReleasePublish(tx, live, ctx.clock.now()) : null;
    });
    if (ws) touched.add(ws);
  }
  for (const ws of touched) await ctx.services.gateway.deliverPending(ws);
}

/** The runner's answer to `release.publish`. Late or repeated answers change nothing (only committed/tagged ships move). */
export async function applyReleasePublishResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const shipId = String(payload.shipId ?? '');
  const parsed = ReleasePublishResultSchema.safeParse(result);
  const r = parsed.success ? parsed.data : undefined;
  void workstationId;
  await withAppendTx(ctx.pool, async (tx) => {
    const ship = await one(tx, 'SELECT * FROM release_ships WHERE id=$1 FOR UPDATE', [shipId]);
    if (!ship || (ship.status !== 'committed' && ship.status !== 'tagged')) return;
    const proposal = await one(tx, 'SELECT state FROM release_proposals WHERE id=$1', [shipId]);
    if (proposal?.state !== 'approved') return;
    const scope = projectScope(ship.org_id, ship.project_id);
    const now = ctx.clock.now();
    const append = (type: string, p: Record<string, unknown>, extra: Record<string, unknown>[] = []) =>
      ctx.store.append(
        [{ streamId: streamId.release(ship.id), event: { type, payload: p } as never, actor: SYSTEM_ACTOR, scope }, ...(extra as never[])],
        { tx },
      );

    if (!ok || !r || r.stage === 'failed') {
      const step = r?.failedStep ?? 'land';
      const message = (r?.error ?? error ?? 'the workstation could not publish the release').slice(0, 4000);
      // what finished before the failure still counts
      if (r?.land && !ship.merge_sha && r.land.mergeSha)
        await append('ReleaseLanded', { shipId, mergeSha: r.land.mergeSha, mode: r.land.mode, by: r.land.by, ...(r.land.prUrl ? { prUrl: r.land.prUrl } : {}) });
      if (r?.tag && !ship.tag_name)
        await append('ReleaseTagged', { shipId, tag: r.tag.name, targetSha: r.tag.target, state: r.tag.state, tagUrl: r.tag.url });
      const tagged = !!(ship.tag_name || r?.tag);
      await appendReleaseFailure(ctx, tx, { ...ship, tag_name: ship.tag_name ?? r?.tag?.name }, step, message, tagged);
      return;
    }

    if (r.stage === 'waiting') {
      const w = r.waiting;
      if (r.land?.mode === 'pr' && ship.land_mode !== 'pr')
        await append('ReleasePublishPlanned', { shipId, landMode: 'pr', ...(r.land.prUrl ? { prUrl: r.land.prUrl } : {}) });
      await exec(
        tx,
        `UPDATE release_ships SET step_message=$2, publish_checked_at=$3, publish_checks=publish_checks+1 WHERE id=$1`,
        [shipId, w?.reason ?? 'waiting for the release to reach the main branch', now],
      );
      return;
    }

    // done
    if (r.land && !ship.merge_sha)
      await append('ReleaseLanded', { shipId, mergeSha: r.land.mergeSha, mode: r.land.mode, by: r.land.by, ...(r.land.prUrl ? { prUrl: r.land.prUrl } : {}) });
    if (r.tag && !ship.tag_name)
      await append('ReleaseTagged', { shipId, tag: r.tag.name, targetSha: r.tag.target, state: r.tag.state, tagUrl: r.tag.url });
    const rel = r.release ?? { state: 'none' as const, url: null };
    const repo = await one(tx, 'SELECT forge_kind, remote_url, name FROM project_repos WHERE id=$1', [ship.repo_id]);
    const kind = repo?.forge_kind ?? 'git';
    const tagUrl = r.tag?.url ?? ship.tag_url ?? null;
    const tag = r.tag?.name ?? ship.tag_name ?? `v${ship.version}`;
    const pageText = rel.state === 'none' ? (rel.message ?? noReleasePageText(kind, tag)) : null;
    const deskItemId = randomUUID();
    const lines = [
      `Tag ${tagUrl ? `${tag} (${tagUrl})` : tag} is on ${r.land?.mergeSha ? r.land.mergeSha.slice(0, 7) : 'the main branch'}.`,
      rel.state === 'none'
        ? pageText
        : `Release page ${rel.state === 'created' ? 'created' : 'already existed (not changed)'}: ${rel.url ?? ''}`,
      ...(rel.message && rel.state !== 'none' ? [rel.message] : []),
    ];
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'alert',
              subkind: DESK_SUBKIND.releasePublished,
              title: `Released ${ship.version}${repo?.name ? ` in ${repo.name}` : ''}`,
              body: lines.filter(Boolean).join('\n'),
              options: [],
              blocking: false,
              pinned: false,
              projectId: ship.project_id,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              data: { repoId: ship.repo_id, shipId, tagUrl, releaseUrl: rel.url },
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        {
          streamId: streamId.release(ship.id),
          event: {
            type: 'ReleasePublished',
            payload: {
              shipId,
              state: rel.state,
              releaseUrl: rel.url,
              ...(rel.latest === undefined ? {} : { latest: rel.latest }),
              deskItemId,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        {
          streamId: streamId.release(ship.id),
          event: {
            type: 'ReleaseProposalClosed',
            payload: { proposalId: shipId, repoId: ship.repo_id, reason: 'released', tag },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ] as never,
      { tx },
    );
  });
}
