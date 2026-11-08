import { checkOutboundLeaks, type InternalRefs, type LeakResult } from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';

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
export async function screenOutbound(
  db: Queryable,
  orgId: string,
  body: string,
  internal: InternalRefs = {},
): Promise<LeakResult> {
  return checkOutboundLeaks(body, await orgAgentNames(db, orgId), internal);
}

/**
 * The internal keys a draft for this card must not name: the card's own ref and the project's keys. The client knows the
 * work by its ticket (`ticketKey`).
 */
export async function cardInternalRefs(db: Queryable, card: Row, ticketKey: string): Promise<InternalRefs> {
  const project = await one<{ key: string }>(db, 'SELECT key FROM projects WHERE id=$1', [card.project_id]);
  return { refs: [String(card.ref)], ticketKey, ...(project?.key ? { projectKey: project.key } : {}) };
}
