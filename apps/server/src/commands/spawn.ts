import { randomUUID } from 'node:crypto';
import { type CardType, type CompletionAction, cardRef, type RiskTier, streamId } from '@aom/shared';
import { loadWorkflowById, resolveWorkflow } from '../catalogue/loader.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';

export interface SpawnInput {
  /** The card that causes the new one (bug child, suite card) or any card of the project. */
  from: Row;
  title: string;
  cardType: CardType;
  origin: 'test_failure' | 'full_suite' | 'regression';
  /** Workflow key; default: the workflow of `from`. */
  workflowKey?: string;
  stage?: string;
  status: 'draft' | 'queued';
  fields: Record<string, unknown>;
  parentCardId?: string;
  worktreeCardId?: string;
  scheduled?: boolean;
  completionAction?: CompletionAction | null;
  riskTier?: RiskTier | null;
  actor?: AppendInput['actor'];
  ownerUserId?: string;
  /** The card runs on this workstation (a phase follow-up's regression run). */
  homeWorkstationId?: string;
  /** The phase follow-up that created the card (never a phase member). */
  phaseFollowupId?: string;
}

/**
 * A `CardCreated` for a card the system spawns (docs/ARCHITECTURE.md section 5.2: bug child, suite card, regression
 * card, bug in Spec). Takes the next card number under the row lock; the projection increments the counter, so at
 * most one card per project may be spawned per transaction unless `numberOffset` is bumped by the caller.
 */
export async function spawnCardEvent(
  tx: Tx,
  input: SpawnInput,
  numberOffset = 0,
): Promise<{ cardId: string; ref: string; event: AppendInput }> {
  const from = input.from;
  const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [from.project_id])) as Row;
  const number = Number(project.next_card_number) + numberOffset;
  let wf: { id: string; definition: { initialStage: string } } | null;
  if (input.workflowKey) wf = await resolveWorkflow(tx, project.org_id, input.workflowKey);
  else wf = await loadWorkflowById(tx, from.workflow_version_id);
  if (!wf) throw new Error(`workflow ${input.workflowKey ?? '(card workflow)'} is not available`);
  const cardId = randomUUID();
  const ref = cardRef(project.key, number);
  return {
    cardId,
    ref,
    event: {
      streamId: streamId.card(cardId),
      event: {
        type: 'CardCreated',
        payload: {
          cardId,
          projectId: project.id,
          number,
          ref,
          title: input.title.slice(0, 300),
          cardType: input.cardType,
          workflowVersionId: wf.id,
          stage: input.stage ?? wf.definition.initialStage,
          status: input.status,
          fields: input.fields,
          ownerUserId: input.ownerUserId ?? from.owner_user_id,
          origin: input.origin,
          parentCardId: input.parentCardId,
          worktreeCardId: input.worktreeCardId,
          scheduled: input.scheduled ?? false,
          repoId: from.repo_id ?? undefined,
          priority: from.priority,
          priorityScale: 2,
          docsNeeded: false,
          designNeeded: false,
          investigationOnly: false,
          completionAction: input.completionAction ?? undefined,
          riskTier: input.riskTier ?? undefined,
          dependencies: [],
          requiredCapabilities: [],
          ...(input.homeWorkstationId ? { homeWorkstationId: input.homeWorkstationId } : {}),
          ...(input.phaseFollowupId ? { phaseFollowupId: input.phaseFollowupId } : {}),
        },
      },
      actor: input.actor ?? SYSTEM_ACTOR,
      scope: projectScope(project.org_id, project.id),
    },
  };
}
