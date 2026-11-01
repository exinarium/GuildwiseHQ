import type { OrgMode } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

/**
 * The organization's DEFAULT VIEW (`organizations.mode`; `dev` for an unknown organization). It is a presentation
 * default only: nothing on the server refuses an action because of it. Server-written text that has no single reader
 * (desk items, ledger entries) is worded for this default; a member's own override only changes what the web shows.
 */
export async function orgModeOf(db: Queryable, orgId: string): Promise<OrgMode> {
  const o = await one<{ mode: string }>(db, 'SELECT mode FROM organizations WHERE id=$1', [orgId]);
  return o?.mode === 'business' ? 'business' : 'dev';
}

/** The view a member sees: their own override on the membership, else the organization default. */
export async function effectiveViewOf(db: Queryable, orgId: string, userId: string): Promise<OrgMode> {
  const m = await one<{ view: string | null; mode: string }>(
    db,
    `SELECT om.view, o.mode FROM organizations o
       LEFT JOIN org_members om ON om.org_id = o.id AND om.user_id = $2 AND om.status = 'active'
      WHERE o.id = $1`,
    [orgId, userId],
  );
  const v = m?.view ?? m?.mode;
  return v === 'business' ? 'business' : 'dev';
}
