import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  RELEASE_PUBLISH_CAPABILITY,
  RELEASE_PUBLISH_STEPS,
  RELEASE_SHIP_CAPABILITY,
  type ReleaseShipPayload,
  ReleaseShipPayloadSchema,
  ReleaseShipResultSchema,
  streamId,
} from '@aom/shared';
import { projectRole } from '../authz/scope.ts';
import { loadCommitAs } from '../commands/commit-as.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { enqueueReleasePublish, planReleasePublish } from './publish.ts';
import { loadComponentRules } from './rules.ts';

type ShipPayload = Omit<ReleaseShipPayload, 'commitAs'>;

/** The `release.ship` payload of an approved proposal (without the commit identity, which is read on every send). */
export async function shipPayloadFromProposal(
  db: Queryable,
  proposal: Row,
  date: string,
): Promise<ShipPayload> {
  const repo = await one(
    db,
    `SELECT r.remote_url_normalized, r.forge_kind, COALESCE(r.working_branch, p.working_branch) AS working_branch, p.name AS project_name
       FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE r.id=$1`,
    [proposal.repo_id],
  );
  if (!repo?.working_branch)
    throw conflict('no_working_branch', 'This repository has no working branch to release from.');
  const approved = (proposal.components ?? []) as {
    name: string;
    level: 'patch' | 'minor' | 'major';
    to: string | null;
  }[];
  const rules = await loadComponentRules(db, proposal.repo_id);
  return ReleaseShipPayloadSchema.omit({ commitAs: true }).parse({
    shipId: proposal.id,
    projectId: proposal.project_id,
    repoId: proposal.repo_id,
    remoteUrlNormalized: repo.remote_url_normalized,
    projectName: repo.project_name ?? '',
    workingBranch: repo.working_branch,
    version: proposal.version,
    tag: `v${proposal.version}`,
    date,
    lastTag: proposal.last_tag ?? null,
    components: rules.map((r) => {
      const c = approved.find((x) => x.name === r.name);
      return { ...r, level: c?.level ?? 'patch', approvedTo: c?.to ?? null };
    }),
    ...(proposal.notes_source === 'commits' && proposal.notes ? { notes: proposal.notes } : {}),
    ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
  });
}

/** A workstation that holds the clone and can ship: the user's own first, then the one seen last. */
async function shipWorkstation(db: Queryable, repoId: string, userId: string): Promise<string> {
  const ws = await one(
    db,
    `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE wr.project_repo_id=$1 AND w.status='active' AND w.connected AND $3 = ANY (wc.capabilities)
      ORDER BY (w.user_id = $2::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
    [repoId, userId, RELEASE_SHIP_CAPABILITY],
  );
  if (ws) return ws.id;
  const clone = await one(db, 'SELECT 1 FROM workstation_repos WHERE project_repo_id=$1', [repoId]);
  throw clone
    ? conflict(
        'runner_too_old',
        'The workstation that has this repository is offline or needs a newer runner. Start or update the runner and approve again.',
      )
    : conflict(
        'no_clone',
        'No workstation has this repository yet. Wait for the clone to finish, then approve again.',
      );
}

async function queue(
  ctx: Ctx,
  tx: Tx,
  actor: ReturnType<typeof userActor>,
  ship: { id: string; project_id: string; org_id: string; repo_id: string; version: string; tag: string },
  payload: ShipPayload,
  date: string,
  workstationId: string,
  retry: boolean,
): Promise<void> {
  await ctx.store.append(
    [
      {
        streamId: streamId.release(ship.id),
        event: {
          type: 'ReleaseShipStarted',
          payload: {
            shipId: ship.id,
            proposalId: ship.id,
            repoId: ship.repo_id,
            version: ship.version,
            tag: ship.tag,
            date,
            workstationId,
            retry,
            payload,
          },
        },
        actor,
        scope: projectScope(ship.org_id, ship.project_id),
      },
    ],
    { tx },
  );
  await enqueueRunnerCommand(tx, workstationId, 'release.ship', {
    ...payload,
    commitAs: await loadCommitAs(tx, ship.project_id),
  } as never);
}

/**
 * Right after the approval, in its transaction: queues `release.ship` on a workstation that has the clone. None
 * available: 409, which rolls the approval back, so the item stays open and nothing happened. Returns the workstation to
 * deliver to, or undefined when the release commit exists already.
 */
export async function startReleaseShipIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
): Promise<string | undefined> {
  const proposal = await one(
    tx,
    `SELECT * FROM release_proposals WHERE desk_item_id=$1 AND state='approved' FOR UPDATE`,
    [item.id],
  );
  if (!proposal) return undefined;
  const done = await one(
    tx,
    `SELECT 1 FROM release_ships WHERE repo_id=$1 AND version=$2 AND status='committed'`,
    [proposal.repo_id, proposal.version],
  );
  if (done) return undefined;
  const workstationId = await shipWorkstation(tx, proposal.repo_id, user.id);
  const date = ctx.clock.now().toISOString().slice(0, 10);
  const payload = await shipPayloadFromProposal(tx, proposal, date);
  await queue(
    ctx,
    tx,
    userActor(user.id),
    {
      id: proposal.id,
      project_id: proposal.project_id,
      org_id: proposal.org_id,
      repo_id: proposal.repo_id,
      version: proposal.version,
      tag: payload.tag,
    },
    payload,
    date,
    workstationId,
    false,
  );
  return workstationId;
}

async function failedShipOf(tx: Tx, user: { id: string }, alert: Row): Promise<Row> {
  const ship = await one(tx, `SELECT * FROM release_ships WHERE alert_desk_item_id=$1 FOR UPDATE`, [
    alert.id,
  ]);
  if (!ship) throw notFound('release not found');
  if ((await projectRole(tx, user.id, ship.project_id)) !== 'owner')
    throw forbidden('only the project owner can decide on a release');
  return ship;
}

/** Retry from the "Release stopped" alert: the stored payload goes out again; the runner continues from the failed step. */
export async function retryReleaseShipIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  alert: Row,
): Promise<string> {
  const ship = await failedShipOf(tx, user, alert);
  if (ship.status !== 'failed')
    throw conflict('not_failed', `this release is ${ship.status}, only a stopped release can be retried`);
  if ((RELEASE_PUBLISH_STEPS as readonly string[]).includes(ship.step ?? '')) {
    // land, tag or publish: the release commit exists. Never resend release.ship (it would start over).
    const target = await enqueueReleasePublishFor(ctx, tx, user, ship);
    return target;
  }
  const workstationId = await shipWorkstation(tx, ship.repo_id, user.id);
  const stored = ship.payload as ShipPayload;
  await queue(ctx, tx, userActor(user.id), ship as never, stored, stored.date, workstationId, true);
  return workstationId;
}

async function enqueueReleasePublishFor(ctx: Ctx, tx: Tx, user: { id: string }, ship: Row): Promise<string> {
  const ws = await enqueueReleasePublishWorkstation(tx, ship);
  if (!ws)
    throw conflict(
      'runner_too_old',
      'The workstation that has this repository is offline or needs a newer runner. Start or update the runner and retry.',
    );
  await ctx.store.append(
    [
      {
        streamId: streamId.release(ship.id),
        event: {
          type: 'ReleasePublishRetried',
          payload: { shipId: ship.id, step: ship.step ?? 'land', workstationId: ws },
        },
        actor: userActor(user.id),
        scope: projectScope(ship.org_id, ship.project_id),
      },
    ],
    { tx },
  );
  const fresh = await one(tx, 'SELECT * FROM release_ships WHERE id=$1', [ship.id]);
  const delivered = fresh ? await enqueueReleasePublish(tx, fresh, ctx.clock.now()) : null;
  return delivered ?? ws;
}

async function enqueueReleasePublishWorkstation(tx: Tx, ship: Row): Promise<string | null> {
  const ws = await one(
    tx,
    `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE wr.project_repo_id=$1 AND w.status='active' AND w.connected AND $2 = ANY (wc.capabilities)
      LIMIT 1`,
    [ship.repo_id, RELEASE_PUBLISH_CAPABILITY],
  );
  return ws?.id ?? null;
}

/** Dismissing a stopped release abandons it: the proposal is closed so the repository can be proposed again. */
export async function dismissReleaseShipIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  alert: Row,
): Promise<void> {
  const ship = await one(tx, `SELECT * FROM release_ships WHERE alert_desk_item_id=$1 FOR UPDATE`, [
    alert.id,
  ]);
  if (!ship || ship.status !== 'failed') return;
  if ((await projectRole(tx, user.id, ship.project_id)) !== 'owner')
    throw forbidden('only the project owner can decide on a release');
  const proposal = await one(tx, `SELECT id, state FROM release_proposals WHERE id=$1 FOR UPDATE`, [ship.id]);
  if (!proposal || proposal.state !== 'approved') return;
  await ctx.store.append(
    [
      {
        streamId: streamId.release(ship.id),
        event: {
          type: 'ReleaseProposalClosed',
          payload: { proposalId: ship.id, repoId: ship.repo_id, reason: 'dismissed' },
        },
        actor: userActor(user.id),
        scope: projectScope(ship.org_id, ship.project_id),
      },
    ],
    { tx },
  );
}

const short = (s: string): string => s.slice(0, 7);
const firstLine = (s: string): string =>
  s
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? s;

/** The runner's answer to `release.ship`: the commit is recorded with a notice, or the failure lands on the desk. */
export async function applyReleaseShipResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const shipId = String(payload.shipId ?? '');
  const parsed = ReleaseShipResultSchema.safeParse(result);
  const r = parsed.success ? parsed.data : undefined;
  const deliver: { to: string | null } = { to: null };
  await withAppendTx(ctx.pool, async (tx) => {
    const ship = await one(tx, 'SELECT * FROM release_ships WHERE id=$1 FOR UPDATE', [shipId]);
    if (!ship || ship.status !== 'committing' || ship.workstation_id !== workstationId) return;
    const scope = projectScope(ship.org_id, ship.project_id);
    const repo = await one(tx, 'SELECT name FROM project_repos WHERE id=$1', [ship.repo_id]);
    const branch = (ship.payload as { workingBranch?: string }).workingBranch ?? 'the working branch';
    if (ok && r?.ok && r.commit) {
      const pr = await one(
        tx,
        `SELECT url FROM repo_pr_requests WHERE repo_id=$1 AND state='opened' AND url IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [ship.repo_id],
      );
      const comps = r.components
        .filter((c) => c.to)
        .map((c) =>
          c.state === 'unchanged'
            ? `${c.name} ${c.to} (unchanged)`
            : c.state === 'bump'
              ? `${c.name} ${c.from} -> ${c.to}`
              : `${c.name} ${c.to}`,
        );
      const lines = [
        r.alreadyDone
          ? `${branch} already had the ${ship.version} section: nothing new was committed (${short(r.commit)}).`
          : `Release commit "chore(release): ${ship.version}" (${short(r.commit)}) is pushed to ${branch}${pr?.url ? `; it is in the release PR ${pr.url}` : ''}.`,
        ...(comps.length ? [`Components: ${comps.join(', ')}.`] : []),
        ...(r.signedOff ? [`Signed off${r.signOffReason ? ` (${r.signOffReason})` : ''}.`] : []),
        ...r.notices,
        'Nothing is tagged or published yet. Once the release PR is merged, Guildwise tags it and creates the release page.',
      ];
      const deskItemId = randomUUID();
      await ctx.store.append(
        [
          {
            streamId: streamId.release(ship.id),
            event: {
              type: 'ReleaseCommitted',
              payload: {
                shipId: ship.id,
                commit: r.commit,
                alreadyDone: !!r.alreadyDone,
                resumed: !!r.resumed,
                signedOff: !!r.signedOff,
                components: r.components.map(({ name, state, from, to }) => ({ name, state, from, to })),
              },
            },
            actor: SYSTEM_ACTOR,
            scope,
          },
          {
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'DeskItemCreated',
              payload: {
                deskItemId,
                kind: 'alert',
                subkind: DESK_SUBKIND.releaseCommitted,
                title: `Release ${ship.version} prepared in ${repo?.name ?? 'the repository'}`,
                body: lines.join('\n'),
                options: [],
                blocking: false,
                pinned: false,
                projectId: ship.project_id,
                affectedCardIds: [],
                askedBy: { kind: 'system' },
              },
            },
            actor: SYSTEM_ACTOR,
            scope,
          },
        ],
        { tx },
      );
      // how the release reaches main, and the first look at whether it did
      deliver.to = await planReleasePublish(ctx, tx, ship.id);
      return;
    }
    const step = r?.step ?? 'prepare';
    const failure = (r?.error ?? error ?? 'the workstation could not prepare the release commit').slice(
      0,
      4000,
    );
    await appendReleaseFailure(ctx, tx, ship, step, failure, false);
  });
  if (deliver.to) void Promise.resolve(ctx.services.gateway.deliverPending(deliver.to)).catch(() => undefined);
}

/** The "Release stopped" alert and `ReleaseFailed` for any step; Retry continues from `step`. */
export async function appendReleaseFailure(
  ctx: Ctx,
  tx: Tx,
  ship: Row,
  step: string,
  failure: string,
  tagged: boolean,
): Promise<void> {
  const scope = projectScope(ship.org_id, ship.project_id);
  const alertId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(alertId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: alertId,
            kind: 'alert',
            subkind: DESK_SUBKIND.releaseFailed,
            title: `Release ${ship.version} stopped at ${step}`,
            body: `${failure}\n\nNothing was force-pushed${tagged ? '' : ' and no tag was made'}; steps that already ran are not repeated. Fix the cause, then Retry: it continues from this step. Dismiss abandons this release.`,
            options: [
              { id: 'retry', label: 'Retry' },
              { id: 'dismiss', label: 'Dismiss' },
            ],
            blocking: false,
            pinned: false,
            projectId: ship.project_id,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
            data: { repoId: ship.repo_id, shipId: ship.id, step, summary: firstLine(failure) },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
      {
        streamId: streamId.release(ship.id),
        event: {
          type: 'ReleaseFailed',
          payload: { shipId: ship.id, step, error: failure, alertDeskItemId: alertId },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
    ],
    { tx },
  );
}
