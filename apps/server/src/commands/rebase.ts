import { streamId } from '@aom/shared';
import type { Row } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, projectScope, runnerActor } from './common.ts';

/** Human text for a rebase conflict: the card goes to Rework and no agent resolves it (docs/ARCHITECTURE.md section 13.6). */
export function rebaseConflictText(stage: string, baseBranch: string, files: readonly string[]): string {
  const list = files.length
    ? files.map((f) => `- ${f}`).join('\n')
    : '- (the runner could not list the files)';
  return `Rebase onto ${baseBranch || 'the working branch'} conflicted before the ${stage} stage. The card is back in Rework for its builder; conflicted files:\n${list}`;
}

/**
 * The `RebaseConflict` event (card -> Rework, rework round + 1) and the thread message that tells the builder which
 * files conflict. The caller appends them together with the claim release (shift) or the finalize failure.
 */
export function rebaseConflictEvents(
  card: Row,
  workstationId: string,
  stage: string,
  baseBranch: string,
  files: readonly string[],
): AppendInput[] {
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'RebaseConflict',
        payload: { cardId: card.id, stage, baseBranch, conflictedFiles: [...files] },
      },
      actor: runnerActor(workstationId),
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(card, { kind: 'system' }, 'system', rebaseConflictText(stage, baseBranch, files), {
      conflictedFiles: [...files],
    }),
  ];
}
