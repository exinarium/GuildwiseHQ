import { randomUUID } from 'node:crypto';
import {
  type CreateDeployTargetRequest,
  type DeployTargetDto,
  MOVE_OPEN_STATES,
  type PatchDeployTargetRequest,
  type ProjectWorkstation,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { duplicateOfPlace, placeBlockFor } from '../delivery/environments.ts';
import { projectScope, userActor } from './common.ts';

export function toTargetDto(t: Row): DeployTargetDto {
  return {
    id: t.id,
    projectId: t.project_id,
    name: t.name,
    kind: t.kind,
    workstationId: t.workstation_id,
    workstationName: t.workstation_name ?? null,
    host: t.host,
    appUrl: t.app_url,
    notes: t.notes,
    createdAt: iso(t.created_at) as string,
    testEnabled: t.test_enabled ?? false,
    production: t.production ?? false,
    destructiveOk: t.destructive_ok ?? false,
    testHosts: t.test_hosts ?? [],
    secretNames: t.secret_names ?? [],
    role: t.role ?? 'active',
  };
}

const SELECT = `SELECT t.*, w.name AS workstation_name FROM deploy_targets t
  LEFT JOIN workstations w ON w.id = t.workstation_id`;

export async function listDeployTargets(db: Queryable, projectId: string): Promise<Row[]> {
  return rows(db, `${SELECT} WHERE t.project_id=$1 AND t.removed_at IS NULL ORDER BY lower(t.name)`, [
    projectId,
  ]);
}

/**
 * Every active workstation of every active member of the project, for the remote deploy-target form (owner decision:
 * the target may name any member's workstation). Only what the form needs: name, owner, whether it is online and has
 * a DevOps engineer. The caller has already been checked as a member of the project.
 */
export async function listMemberWorkstations(
  db: Queryable,
  projectId: string,
  viewerId: string,
): Promise<ProjectWorkstation[]> {
  const list = await rows(
    db,
    `SELECT w.id, w.name, w.user_id, w.connected, u.display_name AS owner,
            EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.is_devops AND a.status = 'active') AS has_devops
       FROM workstations w
       JOIN project_members pm ON pm.user_id = w.user_id AND pm.project_id = $1 AND pm.status = 'active'
       JOIN users u ON u.id = w.user_id AND u.status = 'active'
      WHERE w.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM cloud_workstations cw WHERE cw.workstation_id = w.id
                         AND cw.provider = 'codespaces' AND cw.removed_at IS NULL)
      ORDER BY (w.user_id = $2) DESC, lower(u.display_name), lower(w.name), w.id`,
    [projectId, viewerId],
  );
  return list.map((w) => ({
    id: w.id,
    name: w.name,
    ownerId: w.user_id,
    ownerName: w.owner,
    mine: w.user_id === viewerId,
    connected: !!w.connected,
    hasDevops: !!w.has_devops,
  }));
}

/** A target of the project that is not removed, or a 422 naming the problem. */
export async function liveTarget(db: Queryable, projectId: string, targetId: string): Promise<Row> {
  const t = await one(db, `${SELECT} WHERE t.id=$1 AND t.project_id=$2 AND t.removed_at IS NULL`, [
    targetId,
    projectId,
  ]);
  if (!t) throw unprocessable('unknown_target', 'the deploy target does not exist in this project');
  return t;
}

/** Workstations a deploy may name: active ones of an active member of the project (owner decision A1). */
async function assertMemberWorkstation(tx: Queryable, projectId: string, workstationId: string) {
  const ok = await one(
    tx,
    `SELECT 1 FROM workstations w JOIN project_members pm ON pm.user_id = w.user_id AND pm.project_id = $1 AND pm.status = 'active'
      WHERE w.id = $2 AND w.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM cloud_workstations cw WHERE cw.workstation_id = w.id
                         AND cw.provider = 'codespaces' AND cw.removed_at IS NULL)`,
    [projectId, workstationId],
  );
  if (!ok)
    throw unprocessable(
      'workstation_not_member',
      "the workstation must be an active workstation of one of the project's members (a Codespace cannot deploy Docker images: use a workstation or a VPS)",
    );
}

function checkShape(input: {
  kind: string;
  workstationId?: string | null | undefined;
  host?: string | null | undefined;
}) {
  if (input.kind === 'remote_ssh') {
    if (!input.workstationId)
      throw unprocessable(
        'workstation_required',
        'a remote host needs the workstation whose DevOps engineer deploys',
      );
    if (!input.host) throw unprocessable('host_required', 'a remote host needs an SSH host alias');
  } else if (input.host) {
    throw unprocessable(
      'local_target_shape',
      'a local Docker target has no host: it runs Docker on a workstation (or, with none named, on every workstation of every project member)',
    );
  }
}

/** A production target is never tested, and a target the tester tests needs the URL it answers on. */
function checkTesting(t: { testEnabled: boolean; production: boolean; appUrl?: string | null | undefined }) {
  if (t.production && t.testEnabled)
    throw unprocessable(
      'production_not_tested',
      'a production target is never tested: switch one of the two off',
    );
  if (t.testEnabled && !t.appUrl)
    throw unprocessable('test_needs_url', 'a target the tester tests needs an app URL (where it answers)');
}

const nameTaken = async (tx: Queryable, projectId: string, name: string, exceptId?: string) =>
  one(
    tx,
    `SELECT 1 FROM deploy_targets WHERE project_id=$1 AND lower(name)=lower($2) AND removed_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`,
    [projectId, name, exceptId ?? null],
  );

/** The id of a place that is the same as what is being added (same alias on the same computer, or the same computer). */
async function matchingPlace(
  tx: Queryable,
  projectId: string,
  req: { kind: string; workstationId?: string | null | undefined; host?: string | null | undefined },
): Promise<Row | undefined> {
  const probe = {
    id: 'new',
    kind: req.kind,
    host: req.host ?? null,
    workstation_id: req.workstationId ?? null,
    created_at: new Date(8.64e15),
  };
  const existing = await rows(tx, `${SELECT} WHERE t.project_id=$1 AND t.removed_at IS NULL`, [projectId]);
  const hit = duplicateOfPlace(probe as Row, existing);
  return hit ? existing.find((x) => x.id === hit.id) : undefined;
}

export async function addDeployTarget(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: CreateDeployTargetRequest,
): Promise<string> {
  return (await addOrReuseDeployTarget(ctx, user, projectId, req)).id;
}

/** `addDeployTarget`, saying whether an existing place was returned (`reuseExisting`) instead of a new one made. */
export async function addOrReuseDeployTarget(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: CreateDeployTargetRequest,
): Promise<{ id: string; reused: boolean }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.status !== 'active') throw conflict('project_archived', 'project is archived');
    if (req.reuseExisting) {
      const same = await matchingPlace(tx, projectId, req);
      if (same) return { id: same.id as string, reused: true };
    }
    // Marking a target production, testable or destructive-ok is the project owner's call.
    if ((req.production || req.testEnabled || req.destructiveOk) && p.my_role !== 'owner')
      throw forbidden('only the project owner can mark a target as production or open it to testing');
    checkShape(req);
    checkTesting({
      testEnabled: req.testEnabled ?? false,
      production: req.production ?? false,
      appUrl: req.appUrl ?? null,
    });
    if (req.workstationId) await assertMemberWorkstation(tx, projectId, req.workstationId);
    if (await nameTaken(tx, projectId, req.name))
      throw conflict('target_name_taken', `a deploy target named '${req.name}' already exists`);
    const targetId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'DeployTargetAdded',
            payload: {
              targetId,
              projectId,
              name: req.name,
              kind: req.kind,
              workstationId: req.workstationId ?? null,
              ...(req.host ? { host: req.host } : {}),
              ...(req.appUrl ? { appUrl: req.appUrl } : {}),
              notes: req.notes,
              createdBy: user.id,
              ...(req.testEnabled !== undefined ? { testEnabled: req.testEnabled } : {}),
              ...(req.production !== undefined ? { production: req.production } : {}),
              ...(req.destructiveOk !== undefined ? { destructiveOk: req.destructiveOk } : {}),
              ...(req.testHosts ? { testHosts: req.testHosts } : {}),
              ...(req.secretNames ? { secretNames: req.secretNames } : {}),
            },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return { id: targetId, reused: false };
  });
}

export async function updateDeployTarget(
  ctx: Ctx,
  user: AuthSession['user'],
  targetId: string,
  patch: PatchDeployTargetRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const t = await one(tx, 'SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [
      targetId,
    ]);
    if (!t) throw notFound('deploy target not found');
    const p = await loadVisibleProject(tx, user.id, t.project_id);
    const flips =
      (patch.production !== undefined && patch.production !== !!t.production) ||
      (patch.testEnabled !== undefined && patch.testEnabled !== !!t.test_enabled) ||
      (patch.destructiveOk !== undefined && patch.destructiveOk !== !!t.destructive_ok);
    if (flips && p.my_role !== 'owner')
      throw forbidden('only the project owner can mark a target as production or open it to testing');
    // What a move relies on (the name the approved files use, the server it reaches, the computer that signs in, the address it
    // is checked at) stays as it is while a move for this target is open (final review).
    const changesIdentity =
      (patch.name !== undefined && patch.name !== t.name) ||
      (patch.host !== undefined && patch.host !== t.host) ||
      (patch.workstationId !== undefined && patch.workstationId !== t.workstation_id) ||
      (patch.appUrl !== undefined && patch.appUrl !== t.app_url) ||
      (patch.kind !== undefined && patch.kind !== t.kind);
    if (changesIdentity) {
      const inMove = await one(
        tx,
        `SELECT 1 AS x FROM deploy_target_moves WHERE (from_target_id=$1 OR to_target_id=$1) AND state = ANY($2::text[]) LIMIT 1`,
        [t.id, [...MOVE_OPEN_STATES]],
      );
      if (inMove)
        throw conflict(
          'target_in_move',
          'this server is part of a move that is not finished: finish or cancel the move before changing its name, address or computer',
        );
    }
    // Pointing a live server at another address or computer redirects the real deploys: the project owner only.
    const movesServer =
      (patch.host !== undefined && patch.host !== t.host) ||
      (patch.workstationId !== undefined && patch.workstationId !== t.workstation_id) ||
      (patch.kind !== undefined && patch.kind !== t.kind);
    if (t.production && movesServer && p.my_role !== 'owner')
      throw forbidden('only the project owner can change the server or the computer of a production target');
    const merged = {
      kind: patch.kind ?? t.kind,
      workstationId: patch.workstationId !== undefined ? patch.workstationId : t.workstation_id,
      host: patch.host !== undefined ? patch.host : t.host,
    };
    // Switching kind clears what no longer applies. A local Docker target may keep a workstation ("on this computer").
    if (merged.kind === 'local_docker') merged.host = null;
    checkShape(merged);
    checkTesting({
      testEnabled: patch.testEnabled ?? t.test_enabled ?? false,
      production: patch.production ?? t.production ?? false,
      appUrl: patch.appUrl !== undefined ? patch.appUrl : t.app_url,
    });
    if (merged.workstationId && merged.workstationId !== t.workstation_id)
      await assertMemberWorkstation(tx, t.project_id, merged.workstationId);
    if (patch.name && (await nameTaken(tx, t.project_id, patch.name, t.id)))
      throw conflict('target_name_taken', `a deploy target named '${patch.name}' already exists`);
    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.kind !== undefined) changes.kind = patch.kind;
    if (merged.workstationId !== t.workstation_id) changes.workstationId = merged.workstationId;
    if (merged.host !== t.host) changes.host = merged.host;
    if (patch.appUrl !== undefined) changes.appUrl = patch.appUrl;
    if (patch.notes !== undefined) changes.notes = patch.notes;
    if (patch.testEnabled !== undefined) changes.testEnabled = patch.testEnabled;
    if (patch.production !== undefined) changes.production = patch.production;
    if (patch.destructiveOk !== undefined) changes.destructiveOk = patch.destructiveOk;
    if (patch.testHosts !== undefined) changes.testHosts = patch.testHosts;
    if (patch.secretNames !== undefined) changes.secretNames = patch.secretNames;
    if (Object.keys(changes).length === 0) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(t.project_id),
          event: { type: 'DeployTargetUpdated', payload: { targetId, changes } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, t.project_id),
        },
      ],
      { tx },
    );
  });
}

/** A target that a not yet finished follow-up uses cannot be removed (409 `target_in_use`). */
export const targetInUse = (tx: Tx | Queryable, targetId: string) =>
  one(
    tx,
    `SELECT 1 FROM phase_followups f JOIN phases p ON p.id = f.phase_id
      WHERE f.target_id=$1 AND f.status IN ('pending','queued','briefed','running')
        AND p.status NOT IN ('done','done_with_failures','followups_rejected','discarded','cancelled') LIMIT 1`,
    [targetId],
  );

export async function removeDeployTarget(
  ctx: Ctx,
  user: AuthSession['user'],
  targetId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const t = await one(tx, 'SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [
      targetId,
    ]);
    if (!t) throw notFound('deploy target not found');
    const p = await loadVisibleProject(tx, user.id, t.project_id);
    const block = await placeBlockFor(tx, t);
    if (block) throw conflict(block.code, block.message);
    if (await targetInUse(tx, targetId))
      throw conflict('target_in_use', 'a phase follow-up that is not finished yet uses this deploy target');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(t.project_id),
          event: { type: 'DeployTargetRemoved', payload: { targetId } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, t.project_id),
        },
      ],
      { tx },
    );
  });
}
