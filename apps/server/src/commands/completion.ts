import { type CompletionAction, isBusinessCardType } from '@aom/shared';
import { one, type Queryable, type Row } from '../db/sql.ts';

/**
 * How a card's finished work lands. A card's own `completion_action` is only set when someone deliberately overrode it
 * for that card; null means "inherit", so the project's `default_completion` as it is when the value is used decides.
 */
export interface EffectiveCompletion {
  action: CompletionAction | null;
  source: 'project' | 'card';
}

export async function effectiveCompletion(db: Queryable, card: Row): Promise<EffectiveCompletion> {
  // A business card ends on an approved output, never on a git step, whatever the project default says.
  if (isBusinessCardType(card.card_type)) return { action: null, source: 'card' };
  // `push_branch` was retired (backlog #61): a card that still carries it follows the project instead.
  if (card.completion_action && card.completion_action !== 'push_branch')
    return { action: card.completion_action as CompletionAction, source: 'card' };
  const project = await one(db, 'SELECT default_completion FROM projects WHERE id=$1', [card.project_id]);
  return { action: (project?.default_completion as CompletionAction | undefined) ?? null, source: 'project' };
}

export async function effectiveCompletionAction(db: Queryable, card: Row): Promise<CompletionAction | null> {
  return (await effectiveCompletion(db, card)).action;
}
