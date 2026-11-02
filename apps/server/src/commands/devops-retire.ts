import { type Actor, streamId } from '@aom/shared';
import { type Queryable, type Row, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, orgScope, projectScope, runnerActor, SYSTEM_ACTOR } from './common.ts';
import { threadMessage } from './devops.ts';

/** Release every claim an agent holds (`ClaimReleased` reason `agent_retired`, with the last handoff) and tell the card. */
export async function releaseClaimsOfAgentEvents(
  db: Queryable,
  agent: { id: string },
  actor: Actor,
  text: string,
  skipCardIds: ReadonlySet<string> = new Set(),
): Promise<{ events: AppendInput[]; cardIds: string[] }> {
  const cards = (
    await rows(
      db,
      `SELECT c.*, (SELECT h.id FROM card_handoffs h WHERE h.card_id = c.id ORDER BY h.created_at DESC, h.event_seq DESC LIMIT 1) AS last_handoff_id
         FROM cards c WHERE c.claimed_by_agent_id=$1 AND c.claim_id IS NOT NULL`,
      [agent.id],
    )
  ).filter((c) => !skipCardIds.has(c.id));
  const events: AppendInput[] = [];
  for (const c of cards) {
    events.push({
      streamId: streamId.card(c.id),
      event: {
        type: 'ClaimReleased',
        payload: {
          cardId: c.id,
          claimId: c.claim_id,
          agentId: agent.id,
          reason: 'agent_retired',
          lastHandoffId: c.last_handoff_id ?? undefined,
        },
      },
      actor,
      scope: projectScope(c.org_id, c.project_id),
    });
    events.push(cardMessage(c, { kind: 'system' }, 'system', text));
  }
  return { events, cardIds: cards.map((c) => c.id as string) };
}

/** Fail DevOps requests that can never run (completed as failed, thread message, desk item resolved). */
export function failDevopsRequestEvents(requests: Row[], why: string, deskNote: string): AppendInput[] {
  const events: AppendInput[] = [];
  for (const r of requests) {
    events.push(
      {
        streamId: streamId.thread(r.id),
        event: {
          type: 'DevOpsRequestCompleted',
          payload: { requestId: r.id, status: 'failed', summary: why },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(r.org_id),
      },
      threadMessage(r.thread_id, r.org_id, { kind: 'system' }, 'system', why),
    );
    const deskItemId = (r.approval as { deskItemId?: string } | null)?.deskItemId;
    if (deskItemId)
      events.push({
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemResolved',
          payload: { deskItemId, resolution: 'acknowledged', note: deskNote, by: { kind: 'system' } },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(r.org_id),
      });
  }
  return events;
}

/**
 * AgentRetired for the DevOps engineers of a workstation that is gone, plus the release of the work they still hold.
 * Only callers that know the workstation is unpaired or removed use this; `fireAgent` keeps refusing DevOps engineers.
 * `skip` holds the ids the caller already released in the same batch.
 */
export async function devopsRetireEvents(
  db: Queryable,
  opts: {
    agents: Row[];
    reason: 'workstation_unpaired' | 'orphaned_migration';
    actor: Actor;
    by: string;
    skip?: {
      cardIds?: ReadonlySet<string>;
      shiftIds?: ReadonlySet<string>;
      requestIds?: ReadonlySet<string>;
    };
  },
): Promise<AppendInput[]> {
  const events: AppendInput[] = [];
  const why =
    opts.reason === 'workstation_unpaired'
      ? 'The workstation was unpaired, so this request cannot run.'
      : 'The workstation is gone, so this request cannot run.';
  for (const a of opts.agents) {
    const released = await releaseClaimsOfAgentEvents(
      db,
      { id: a.id as string },
      opts.actor,
      `${a.name} was retired with its workstation; the card is back in the queue with the last handoff attached.`,
      opts.skip?.cardIds,
    );
    events.push(...released.events);
    const shifts = (
      await rows(
        db,
        `SELECT id, org_id, agent_id, card_id, workstation_id FROM shifts WHERE agent_id=$1 AND status <> 'ended'`,
        [a.id],
      )
    ).filter((s) => !opts.skip?.shiftIds?.has(s.id));
    for (const s of shifts)
      events.push({
        streamId: streamId.shift(s.id),
        event: {
          type: 'ShiftEnded',
          payload: {
            shiftId: s.id,
            agentId: s.agent_id,
            cardId: s.card_id ?? undefined,
            outcome: 'lost',
            durationMs: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            guardViolations: [],
          },
        },
        actor: s.workstation_id ? runnerActor(s.workstation_id) : SYSTEM_ACTOR,
        scope: orgScope(s.org_id),
      });
    const requests = (
      await rows(
        db,
        `SELECT id, org_id, thread_id, approval FROM devops_requests
          WHERE devops_agent_id=$1 AND status IN ('queued','running','needs_approval') ORDER BY created_at`,
        [a.id],
      )
    ).filter((r) => !opts.skip?.requestIds?.has(r.id));
    events.push(
      ...failDevopsRequestEvents(requests, why, 'The DevOps engineer was retired; the request failed.'),
    );
    events.push({
      streamId: streamId.agent(a.id),
      event: {
        type: 'AgentRetired',
        payload: {
          agentId: a.id,
          by: opts.by,
          releasedCardIds: released.cardIds,
          reason: opts.reason,
          ...(a.workstation_id ? { workstationId: a.workstation_id } : {}),
        },
      },
      actor: opts.actor,
      scope: orgScope(a.org_id),
    });
  }
  return events;
}
