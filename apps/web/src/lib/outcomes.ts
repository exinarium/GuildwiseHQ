import type { CardDto } from '@aom/shared';

/**
 * Plain-language outcome of a code card for people who have not turned on expert mode: no branch names, no merge
 * jargon (docs/design/git-free-and-devops-instructions.md, 1.3). Expert mode shows the raw completion action instead.
 */
export function landingText(
  card: Pick<CardDto, 'status' | 'effectiveCompletionAction' | 'baseBranch' | 'finalizedAt'>,
): string {
  const main = card.baseBranch ?? 'main';
  const done = card.status === 'done' || card.finalizedAt != null;
  switch (card.effectiveCompletionAction) {
    case 'pr':
      return done
        ? 'Waiting for you to merge the pull request'
        : 'Arrives as a pull request for you to merge';
    case 'push_branch':
      return done
        ? 'Ready for someone to combine into main'
        : 'Will be set aside for someone to combine into main';
    case 'merge':
      return done ? `Your change is live on ${main}` : `Goes into ${main} after review and test`;
    default:
      return `Goes into ${main} after review and test`;
  }
}
