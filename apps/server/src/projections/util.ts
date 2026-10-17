import { exec, one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { StoredEvent } from '../eventstore/types.ts';

export const LEASE_MS = 3600_000;
export const leaseExpiry = (from: Date): Date => new Date(from.getTime() + LEASE_MS);

export const getCard = (tx: Tx, id: string) => one(tx, 'SELECT * FROM cards WHERE id=$1', [id]);

/** Appends a card_transitions row when stage or status changed (or the card is new). */
export async function recordTransition(
  tx: Tx,
  before: Row | undefined,
  after: Row | undefined,
  e: StoredEvent,
  who: { agentId?: string | null; userId?: string | null } = {},
): Promise<void> {
  if (!after) return;
  if (before && before.stage === after.stage && before.status === after.status) return;
  // Lean Team v3: affinity belongs to one stage; a card that moved on is free for any agent again.
  if (before && before.stage !== after.stage && before.affinity_agent_id)
    await exec(
      tx,
      `UPDATE cards SET affinity_agent_id=NULL, affinity_session_id=NULL, affinity_until=NULL, affinity_reason=NULL,
              affinity_desk_item_id=NULL WHERE id=$1`,
      [after.id],
    );
  const agentId =
    who.agentId !== undefined
      ? who.agentId
      : (before?.claimed_by_agent_id ?? after.claimed_by_agent_id ?? null);
  await exec(
    tx,
    `INSERT INTO card_transitions (card_id, from_stage, to_stage, from_status, to_status, agent_id, user_id, reason, event_seq, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      after.id,
      before?.stage ?? null,
      after.stage,
      before?.status ?? null,
      after.status,
      agentId,
      who.userId ?? null,
      e.event.type,
      e.seq.toString(),
      e.createdAt,
    ],
  );
}

/** Runs `fn` (which mutates the card) and records the resulting transition. */
export async function mutateCard(
  tx: Tx,
  e: StoredEvent,
  cardId: string,
  fn: () => Promise<unknown>,
  who: { agentId?: string | null; userId?: string | null } = {},
): Promise<void> {
  const before = await getCard(tx, cardId);
  await fn();
  const after = await getCard(tx, cardId);
  await recordTransition(tx, before, after, e, who);
}
