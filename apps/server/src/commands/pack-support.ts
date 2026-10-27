import { PACK_AUTHORING_CAPABILITY, PACKS_CAPABILITY, streamId } from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, runnerActor, SYSTEM_ACTOR, userActor, userScope } from './common.ts';

/**
 * Shared pieces of the pack commands (docs/ARCHITECTURE.md sections 38.4 and 38.8): who holds a pack, the audience of its events
 * and the capability checks. No imports from the other pack modules, so they can all use it.
 */

/**
 * Whether a pack may be on, and may be reported by, this workstation: it is active, its owner is an active member of the pack's
 * organization, it is one the adding admin chose (no choice: any workstation of the admin who added the pack), and, when it was
 * assigned to another member's workstation, that member accepted. A private pack is held only by its owner's workstation.
 * `p` is the packs row, `w` the workstation.
 */
export const HOLDS_PACK_SQL = `w.status = 'active'
  AND EXISTS (SELECT 1 FROM org_members om WHERE om.user_id = w.user_id AND om.org_id = p.org_id AND om.status = 'active')
  AND (w.id = ANY(p.workstation_ids) OR (cardinality(p.workstation_ids) = 0 AND w.user_id = p.added_by))
  AND (p.visibility = 'org' OR w.user_id = p.owner_user_id)
  AND NOT EXISTS (SELECT 1 FROM pack_assignments pa WHERE pa.pack_id = p.id AND pa.workstation_id = w.id AND pa.status = 'pending')`;

/** The audience of a pack's events: the owner alone for a private pack, the organization otherwise. */
// biome-ignore lint/suspicious/noExplicitAny: a packs row (or the few fields of one)
type PackAudience = Record<string, any>;
export const packScopeOf = (p: PackAudience) =>
  p.visibility === 'private' && p.owner_user_id ? userScope(p.owner_user_id) : orgScope(p.org_id);

export const packEvent = (
  type: string,
  payload: Record<string, unknown>,
  pack: PackAudience,
  by?: string | { workstationId: string },
): AppendInput =>
  ({
    streamId: streamId.pack(pack.id),
    event: { type, payload },
    actor: typeof by === 'string' ? userActor(by) : by ? runnerActor(by.workstationId) : SYSTEM_ACTOR,
    scope: packScopeOf(pack),
  }) as AppendInput;

/** The author's workstation of an authored pack: the first of its holders (the one that pins it and that others fetch it from). */
export const authorWorkstationOf = (p: Row): string | null =>
  p.source === 'authored' ? ((p.workstation_ids as string[] | null)?.[0] ?? null) : null;

/** True when the workstation announced `capability`. */
export async function wsHas(db: Queryable, workstationId: string, capability: string): Promise<boolean> {
  const r = await one(
    db,
    'SELECT $2 = ANY(capabilities) AS ok FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId, capability],
  );
  return !!r?.ok;
}

export const wsCanAuthor = (db: Queryable, workstationId: string) =>
  wsHas(db, workstationId, PACK_AUTHORING_CAPABILITY);

/** Workstations of the organization's active members that announce `packs:1`: the ones an admin may choose from. */
export async function packWorkstations(
  db: Queryable,
  orgId: string,
): Promise<Array<{ id: string; name: string; user_id: string; owner_name: string; authoring: boolean }>> {
  return rows(
    db,
    `SELECT w.id, w.name, w.user_id, u.display_name AS owner_name, ($3 = ANY(wc.capabilities)) AS authoring
       FROM workstations w
       JOIN users u ON u.id = w.user_id
       JOIN org_members om ON om.user_id = w.user_id AND om.org_id = $1 AND om.status = 'active'
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE w.status = 'active' AND $2 = ANY(wc.capabilities)
      ORDER BY w.name, w.id`,
    [orgId, PACKS_CAPABILITY, PACK_AUTHORING_CAPABILITY],
  );
}

/** A pack is approved at its pinned revision (organization packs); a private pack needs no approval. */
export const isTrustedRow = (r: Row): boolean =>
  r.visibility === 'private' ||
  (!!r.trusted && r.trusted_sha === r.pinned_sha && r.trusted_hash === r.content_hash);

/**
 * An item of the Claude Code plugin layout in a pack that was approved before that layout was read: it is listed, but waits for the
 * Owner to approve the pack's current content hash (`PackLayoutRead`). Private packs need no approval.
 */
export const pluginItemAwaiting = (p: Row, item: { layout?: string | undefined }): boolean =>
  item.layout === 'plugin' &&
  p.visibility !== 'private' &&
  p.trusted_hash !== (p.snapshot as { contentHash?: string } | null)?.contentHash;
