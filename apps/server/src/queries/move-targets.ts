import type { MoveTargetsResponse, RuntimeInfo } from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

/** An active workstation of an active member of org `org` (any role), or the org's simulated one. */
export const orgWorkstationSql = (ws: string, org: string): string => `(
  ${ws}.status = 'active'
  AND EXISTS (SELECT 1 FROM users wu WHERE wu.id = ${ws}.user_id AND wu.status = 'active')
  AND (${ws}.simulation_org_id = ${org}
       OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = ${org} AND om.user_id = ${ws}.user_id AND om.status = 'active'))
  AND ${wsServesOrgSql(ws, org)})`;

/** The workstations an agent can move to (the caller's own first) and where it is now. */
export async function listMoveTargets(
  db: Queryable,
  agent: Row,
  viewerId: string,
): Promise<MoveTargetsResponse> {
  const list = await rows(
    db,
    `SELECT w.id, w.name, w.user_id, w.connected, w.runtimes, u.display_name
       FROM workstations w JOIN users u ON u.id = w.user_id
      WHERE ${orgWorkstationSql('w', '$1::uuid')} AND w.id IS DISTINCT FROM $2::uuid
      ORDER BY (w.user_id = $3::uuid) DESC, lower(u.display_name), lower(w.name), w.id`,
    [agent.org_id, agent.workstation_id ?? null, viewerId],
  );
  const cur = agent.workstation_id
    ? await one(db, 'SELECT id, name, status, connected FROM workstations WHERE id=$1', [agent.workstation_id])
    : undefined;
  return {
    current: cur
      ? {
          id: cur.id,
          name: cur.name,
          state: cur.status !== 'active' ? 'unpaired' : cur.connected ? 'connected' : 'offline',
        }
      : null,
    workstations: list.map((w) => ({
      id: w.id,
      name: w.name,
      ownerUserId: w.user_id,
      ownerName: w.display_name,
      mine: w.user_id === viewerId,
      connected: w.connected === true,
      runtimes: (w.runtimes ?? []) as RuntimeInfo[],
    })),
  };
}
