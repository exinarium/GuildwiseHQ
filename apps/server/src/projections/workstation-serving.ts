import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * Which organizations a workstation works for (R9, audit F4): one row per (workstation, organization), the latest
 * `WorkstationOrgServingSet` wins. Read by `wsServesOrgSql` (simulation/fit.ts). Never derived from membership.
 */
export const workstationServingProjectors: Record<string, Projector> = {
  WorkstationOrgServingSet: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationOrgServingSet'>).payload;
    await exec(
      tx,
      `INSERT INTO workstation_org_serving (workstation_id, org_id, serving, set_by, set_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workstation_id, org_id) DO UPDATE
         SET serving = EXCLUDED.serving, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
      [p.workstationId, p.orgId, p.serving, p.by, e.createdAt],
    );
  },
};
