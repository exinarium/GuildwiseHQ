import { type CompletionAction, type FinalizeAction, streamId } from '@aom/shared';
import type { Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';
import { effectiveCompletionAction } from './completion.ts';
import { mergeApprovalEvents, mergeGate, queueExecute } from './finalize.ts';
import { investigationRecorded } from './investigation.ts';

/**
 * `aom finalize` on an investigation-only card whose report lives in the vault has nothing to merge or push.
 * The card is finished at once (`CardFinalized` with action `none`) and its worktree is given back. Refused for any other
 * card, and for a report that is in the repository (that report must reach the working branch).
 */
async function finalizeWithoutGit(
  tx: Tx,
  input: {
    card: Row;
    agent: Row;
    note: string;
    scope: ReturnType<typeof projectScope>;
  },
): Promise<BaFinalize> {
  const { card, agent, scope } = input;
  if (!card.investigation_only)
    return {
      ok: false,
      error: 'only an investigation-only card with its report in the vault finishes without a git step',
    };
  const inv = card.investigation as { location?: string } | null;
  if (inv?.location !== 'vault')
    return {
      ok: false,
      error: `the report of ${card.ref} is in the repository, so it must be merged: run \`aom finalize\` without --action`,
    };
  const events: AppendInput[] = [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardFinalized',
        payload: { cardId: card.id, action: 'none', resultRef: {}, toStage: 'done' },
      },
      actor: agentActor(agent.id),
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `Finalized without a repository step: the investigation report is in the project vault. ${input.note}`.trim(),
    ),
  ];
  let workstationId: string | undefined;
  if (card.worktree_path && card.home_workstation_id) {
    await enqueueRunnerCommand(tx, card.home_workstation_id, 'worktree.remove', {
      repoId: card.repo_id ?? undefined,
      path: card.worktree_path,
      branchName: card.branch_name ?? undefined,
      deleteBranch: false,
    });
    workstationId = card.home_workstation_id;
  }
  return {
    ok: true,
    events,
    message: 'Recorded. The investigation is finished; no merge was needed. Finish now.',
    action: 'none',
    ...(workstationId ? { workstationId } : {}),
  };
}

/** Same teaching message as the #52 guard on card drafts: only people choose how a card lands. */
export const FINALIZE_ACTION_REFUSAL =
  'agents may not choose the completion action: finalize runs the card\'s own completion action (set by a person on the card, else the project\'s default). Run `aom finalize --note "<note>"` without --action. If the card should land differently, say so in the conversation and ask the manager to change it on the card page.';

export type BaFinalize =
  | { ok: true; events: AppendInput[]; message: string; workstationId?: string; action: FinalizeAction }
  | { ok: false; error: string };

/**
 * The BA's background finalize queue (docs/ARCHITECTURE.md section 24 item 22; docs/SPEC.md "Finalize"): the BA claims
 * the Finalize stage and reports `aom finalize`. The action is always the card's effective completion action
 * (a person's override, else the project default). A large-tier merge waits for the manager's approval on the desk; anything else goes to the
 * card's home workstation as `finalize.execute`, where the runner runs the completion action (`git/completion.ts`)
 * with no agent involved. The manager's Finalize button stays as an override (`requestFinalize`).
 */
export async function baFinalizeEvents(
  tx: Tx,
  input: { card: Row; agent: Row; action?: FinalizeAction | undefined; note: string },
): Promise<BaFinalize> {
  const { card, agent } = input;
  const scope = projectScope(card.org_id, card.project_id);
  const actor = agentActor(agent.id);
  // An investigation-only card is finalized once its result is in the ledger (`aom investigation record`).
  if (card.investigation_only && !(await investigationRecorded(tx, card.id)))
    return {
      ok: false,
      error: `${card.ref} is an investigation-only card: record the result first with \`aom investigation record --title "<what was investigated>" --summary-file <summary.md>\`, then finalize`,
    };
  // Agents never choose how a card lands (#52): only the card's own action runs. `none` is derived, not chosen.
  if (input.action !== undefined && input.action !== 'none')
    return { ok: false, error: FINALIZE_ACTION_REFUSAL };
  const reportInVault =
    card.investigation_only && (card.investigation as { location?: string } | null)?.location === 'vault';
  if (input.action === 'none' || reportInVault) return finalizeWithoutGit(tx, { ...input, scope });
  const events: AppendInput[] = [];
  const action: CompletionAction | null = await effectiveCompletionAction(tx, card);
  if (!action)
    return {
      ok: false,
      error: `${card.ref} has no completion action: ask the manager to set one on the card or in the project settings`,
    };
  const by = `${agent.name} (BA)`;
  const gate = await mergeGate(tx, card, action);
  if (gate === 'approval') {
    const approval = mergeApprovalEvents(card, action, { requestedBy: agent.id, actor, by });
    events.push(...approval.events);
    return {
      ok: true,
      events,
      message: 'Recorded. A large merge needs the manager: the approval is on the desk. Finish now.',
      action,
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
      event: {
        type: 'FinalizeRequested',
        payload: {
          cardId: card.id,
          action,
          requestedBy: agent.id,
          ...(gate === 'waived' ? { withoutApproval: true } : {}),
        },
      },
      actor,
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `Finalize (${action}) requested by ${by}${gate === 'waived' ? ' and merged without manager approval (project setting)' : ''}: ${input.note}`,
    ),
  );
  return {
    ok: true,
    events,
    message: `Recorded. The runner is executing the completion action (${action}). Finish now.`,
    workstationId,
    action,
  };
}
