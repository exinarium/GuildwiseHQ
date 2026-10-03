import { type CompletionAction, streamId } from '@aom/shared';
import type { Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';
import { mergeApprovalEvents, needsMergeApproval, queueExecute } from './finalize.ts';

export type BaFinalize =
  | { ok: true; events: AppendInput[]; message: string; workstationId?: string }
  | { ok: false; error: string };

/**
 * The BA's background finalize queue (docs/ARCHITECTURE.md section 24 item 22; docs/SPEC.md "Finalize"): the BA claims
 * the Finalize stage and reports `aom finalize --action ...`. The action may revise the card's completion action
 * (recorded on the card). A large-tier merge waits for the manager's approval on the desk; anything else goes to the
 * card's home workstation as `finalize.execute`, where the runner runs the completion action (`git/completion.ts`)
 * with no agent involved. The manager's Finalize button stays as an override (`requestFinalize`).
 */
export async function baFinalizeEvents(
  tx: Tx,
  input: { card: Row; agent: Row; action: CompletionAction; note: string },
): Promise<BaFinalize> {
  const { card, agent, action } = input;
  const scope = projectScope(card.org_id, card.project_id);
  const actor = agentActor(agent.id);
  const events: AppendInput[] = [];
  const revised = action !== card.completion_action;
  if (revised) {
    events.push(
      {
        streamId: streamId.card(card.id),
        event: { type: 'CardUpdated', payload: { cardId: card.id, changes: { completionAction: action } } },
        actor,
        scope,
      },
      cardMessage(
        card,
        { kind: 'agent', agentId: agent.id },
        'comment',
        `Completion action revised from ${card.completion_action ?? 'none'} to ${action}: ${input.note}`,
      ),
    );
  }
  const by = `${agent.name} (BA)`;
  if (needsMergeApproval(card, action)) {
    const approval = mergeApprovalEvents(card, action, { requestedBy: agent.id, actor, by });
    events.push(...approval.events);
    return {
      ok: true,
      events,
      message: 'Recorded. A large merge needs the manager: the approval is on the desk. Finish now.',
    };
  }
  let workstationId: string;
  try {
    workstationId = await queueExecute(tx, { ...card, completion_action: action }, action);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  events.push(
    {
      streamId: streamId.card(card.id),
      event: { type: 'FinalizeRequested', payload: { cardId: card.id, action, requestedBy: agent.id } },
      actor,
      scope,
    },
    cardMessage(card, { kind: 'system' }, 'system', `Finalize (${action}) requested by ${by}: ${input.note}`),
  );
  return {
    ok: true,
    events,
    message: `Recorded. The runner is executing the completion action (${action}). Finish now.`,
    workstationId,
  };
}
