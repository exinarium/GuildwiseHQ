import { computerRemovedMessage, DEPLOYING_COMPUTER_REMOVED, MOVE_OPEN_STATES, streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { conflict } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';

/**
 * A place (deploy target) whose deploying computer was unpaired. The target keeps `workstation_id` for the record and
 * carries `computer_removed_at` (`DeployTargetComputerRemoved`); old data may lack the flag, so "the computer is not
 * active" counts as removed too.
 */
export const COMPUTER_REMOVED = DEPLOYING_COMPUTER_REMOVED;
export { computerRemovedMessage };

/** True when the place has a deploying computer that is no longer active (or the place is flagged). */
export async function targetComputerRemoved(db: Queryable, target: Row): Promise<boolean> {
  if (!target.workstation_id) return false;
  if (target.computer_removed_at) return true;
  const w = await one(db, `SELECT 1 AS x FROM workstations WHERE id=$1 AND status='active'`, [
    target.workstation_id,
  ]);
  return !w;
}

/** 409 `deploying_computer_removed` when the place's own computer is gone. */
export async function assertTargetComputerActive(db: Queryable, target: Row): Promise<void> {
  if (await targetComputerRemoved(db, target))
    throw conflict(COMPUTER_REMOVED, computerRemovedMessage(target.name));
}

/** The removed computer `workstationId` still deploys a live place of the project: 409 naming it (else nothing). */
export async function assertNoRemovedPlaceOn(
  db: Queryable,
  projectId: string,
  workstationId: string,
): Promise<void> {
  const t = await one(
    db,
    `SELECT t.name FROM deploy_targets t JOIN workstations w ON w.id = t.workstation_id
      WHERE t.project_id=$1 AND t.workstation_id=$2 AND t.removed_at IS NULL AND w.status <> 'active'
      ORDER BY lower(t.name) LIMIT 1`,
    [projectId, workstationId],
  );
  if (t) throw conflict(COMPUTER_REMOVED, computerRemovedMessage(t.name));
}

/** For rows selected with `w.status AS workstation_status`: flagged, or the deploying computer is not active. */
export const rowComputerRemoved = (t: {
  workstation_id?: string | null;
  computer_removed_at?: unknown;
  workstation_status?: string | null;
}): boolean =>
  !!t.workstation_id && (!!t.computer_removed_at || (t.workstation_status ?? 'unlinked') !== 'active');

/**
 * The events that record "the computer of these places is gone": one `DeployTargetComputerRemoved` per live place of the
 * computer that is not flagged yet, and one `DeployTargetMoveCancelled` per open move that computer was running (a move
 * cannot go on without it, and an open move would stop the Owner from choosing another computer for the place).
 *
 * `workstationId` names one computer (the unpair); without it every live place whose computer is not an active
 * workstation is covered (the one-time repair of data from before the flag existed). Dedicated keys are not touched: the
 * public key is still on the server, and `DeployKeyRevoked` is the record of a key that was really taken off it.
 */
export async function computerRemovedEvents(
  db: Queryable,
  opts: { workstationId?: string; now: Date },
): Promise<AppendInput[]> {
  const where = opts.workstationId
    ? `t.workstation_id = $1`
    : `t.workstation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workstations w WHERE w.id = t.workstation_id AND w.status='active')`;
  const args = opts.workstationId ? [opts.workstationId] : [];
  const targets = await rows(
    db,
    `SELECT t.id, t.org_id, t.project_id, t.workstation_id FROM deploy_targets t
      WHERE t.removed_at IS NULL AND t.computer_removed_at IS NULL AND ${where} ORDER BY t.created_at, t.id`,
    args,
  );
  const events: AppendInput[] = targets.map((t) => ({
    streamId: streamId.project(t.project_id),
    event: {
      type: 'DeployTargetComputerRemoved',
      payload: { targetId: t.id, projectId: t.project_id, workstationId: t.workstation_id },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(t.org_id, t.project_id),
  }));
  const moveWhere = opts.workstationId
    ? `m.workstation_id = $2`
    : `NOT EXISTS (SELECT 1 FROM workstations w WHERE w.id = m.workstation_id AND w.status='active')`;
  const moves = await rows(
    db,
    `SELECT m.id, m.org_id, m.project_id, m.started_by FROM deploy_target_moves m
      WHERE m.state = ANY($1::text[]) AND ${moveWhere} ORDER BY m.started_at, m.id`,
    opts.workstationId ? [[...MOVE_OPEN_STATES], opts.workstationId] : [[...MOVE_OPEN_STATES]],
  );
  for (const m of moves)
    events.push({
      streamId: streamId.project(m.project_id),
      event: {
        type: 'DeployTargetMoveCancelled',
        payload: { moveId: m.id, projectId: m.project_id, by: m.started_by, at: opts.now.toISOString() },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(m.org_id, m.project_id),
    });
  return events;
}
