import { checkOutboundLeaks, type LeakResult } from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';

/** Names of every agent of the organization (retired ones too: their names are just as internal). */
export async function orgAgentNames(db: Queryable, orgId: string): Promise<string[]> {
  return (await rows<{ name: string }>(db, 'SELECT name FROM agents WHERE org_id=$1', [orgId])).map(
    (r) => r.name,
  );
}

/**
 * The server-side leak check (docs/SPEC.md "External systems boundary"): runs on every draft and on every edit the
 * manager makes before approving. Nothing that names an agent or describes the team's inner workings reaches an outside
 * system; the runner scrubs once more before posting.
 */
export async function screenOutbound(db: Queryable, orgId: string, body: string): Promise<LeakResult> {
  return checkOutboundLeaks(body, await orgAgentNames(db, orgId));
}
