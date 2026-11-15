import { randomUUID } from 'node:crypto';
import { type CheckEvidence, DESK_SUBKIND, streamId } from '@aom/shared';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';

/**
 * A handoff the runner's checks refused (docs/RUNNER.md "Handoff checks"): the runner sends a non-terminal comment that
 * carries the check results. The card thread gets the agent's comment with `data.handoffChecks` (stored in the event store,
 * no schema change), so the card shows what was refused and why. A check that produced no verdict (error or timeout) a
 * second time in a row on the project raises one non-blocking desk alert per project and check.
 */
export async function handoffRefusalEvents(
  tx: Tx,
  card: Row,
  agentId: string,
  workstationId: string,
  note: string,
  checks: readonly CheckEvidence[],
  headSha: string | undefined,
): Promise<AppendInput[]> {
  const out: AppendInput[] = [
    cardMessage(card, { kind: 'agent', agentId }, 'comment', note, {
      handoffChecks: { refused: true, headSha: headSha ?? null, checks },
    }),
  ];
  const broken = checks.filter((c) => c.status === 'error' || c.status === 'timeout');
  if (broken.length === 0) return out;
  // The project's last refusal before this one (the projection has not seen this one yet).
  const prev = await one<{ data: { handoffChecks?: { checks?: CheckEvidence[] } } }>(
    tx,
    `SELECT m.data FROM thread_messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.project_id = $1 AND m.data ? 'handoffChecks'
      ORDER BY m.created_at DESC, m.event_seq DESC LIMIT 1`,
    [card.project_id],
  );
  const before = prev?.data?.handoffChecks?.checks ?? [];
  const ws = await one<{ name: string }>(tx, 'SELECT name FROM workstations WHERE id=$1', [workstationId]);
  for (const c of broken) {
    const again = before.some(
      (b) =>
        b.name === c.name &&
        (b.kind ?? 'check') === (c.kind ?? 'check') &&
        (b.status === 'error' || b.status === 'timeout'),
    );
    if (!again) continue;
    const title = `Handoff check "${c.name}" cannot run`;
    const open = await one(
      tx,
      `SELECT 1 AS x FROM desk_items WHERE project_id=$1 AND subkind=$2 AND title=$3 AND status='open'`,
      [card.project_id, DESK_SUBKIND.handoffCheckBroken, title],
    );
    if (open) continue;
    const deskItemId = randomUUID();
    out.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.handoffCheckBroken,
          title,
          body: `"${c.name}" cannot run on ${ws?.name ?? 'a workstation'}: ${c.summary || c.status}. It refused handoffs twice in a row (last on ${card.ref}): every card that hands off stays put until it runs. Fix the tool or the command, or unconfirm the check (Project settings > Run and test).`,
          options: [],
          blocking: false,
          pinned: false,
          projectId: card.project_id,
          affectedCardIds: [card.id],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    });
  }
  return out;
}
