import { one, type Queryable } from '../db/sql.ts';

/**
 * SQL condition: workstation `ws` may run work of the organization in column `orgCol`.
 * - A simulated workstation only serves its own simulation organization.
 * - A real workstation never serves a simulation organization (nothing real is built there).
 * - A real workstation serves an organization only when its user switched that organization on: a
 *   `workstation_org_serving` row with `serving` (R9, audit F4). Rows come only from explicit `WorkstationOrgServingSet`
 *   events (pairing for the orgs the user owns, accept, "Works for", a hire onto one's own workstation, the data
 *   migration); membership alone never makes a workstation work for an organization.
 */
export const wsServesOrgSql = (ws: string, orgCol: string): string =>
  `COALESCE(${ws}.simulation_org_id = ${orgCol},
            NOT EXISTS (SELECT 1 FROM organizations so WHERE so.id = ${orgCol} AND so.simulation)
            AND EXISTS (SELECT 1 FROM workstation_org_serving wos
                         WHERE wos.workstation_id = ${ws}.id AND wos.org_id = ${orgCol} AND wos.serving))`;

/** The same rule for one workstation and one organization. */
export async function workstationServesOrg(
  db: Queryable,
  workstationId: string,
  orgId: string,
): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    db,
    `SELECT ${wsServesOrgSql('ws', '$2::uuid')} AS ok FROM workstations ws WHERE ws.id = $1`,
    [workstationId, orgId],
  );
  return r?.ok === true;
}
