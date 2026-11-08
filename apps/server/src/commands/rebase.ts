import { type FinalizeResult, type RebaseErrorInfo, streamId } from '@aom/shared';
import type { Row } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, projectScope, runnerActor } from './common.ts';

/**
 * A runner report is a rebase conflict only when git stopped on conflicting paths and the runner listed them. Anything
 * else (no files, an older runner's empty list, an error) is a failure on the workstation, never a code conflict.
 */
export const isRealConflict = (files: readonly string[] | undefined | null): files is readonly string[] =>
  (files?.length ?? 0) > 0;

/** Human text for a rebase conflict: the card goes to Rework and no agent resolves it (docs/ARCHITECTURE.md section 13.6). */
export function rebaseConflictText(stage: string, baseBranch: string, files: readonly string[]): string {
  // Only called with files (isRealConflict); the fallback keeps the text honest if that ever changes.
  const list = files.length ? files.map((f) => `- ${f}`).join('\n') : '- (no files were reported)';
  return `Rebase onto ${baseBranch || 'the working branch'} conflicted before the ${stage} stage. The card is back in Rework for its builder; conflicted files:\n${list}`;
}

/** An older runner's message for a "conflict" without files ("rebase conflict in "): says nothing, so it is dropped. */
const EMPTY_CONFLICT_MESSAGE = /^\s*(?:rebase|merge) conflict in[\s,]*$/i;
const usefulDetail = (text: string | null | undefined): string => {
  const t = (text ?? '').trim();
  return EMPTY_CONFLICT_MESSAGE.test(t) ? '' : t.slice(0, 2000);
};

export interface RebaseFailure {
  /** The runner's structured report (newer runners). */
  rebaseError?: RebaseErrorInfo | null;
  /** The runner's free text when there is no structured report (`detail`, `error`). */
  detail?: string | null;
  /** The runner said "conflict" but listed no files (an older runner). */
  fileLessConflict?: boolean;
}

/**
 * Human text for a rebase that failed for a reason other than a conflict: names the base branch and quotes git. It
 * never says "conflicted" and never says the runner could not list files, and it says the card was not sent back to
 * Rework: this is a workstation problem, not the card's code.
 */
export function rebaseErrorText(stage: string, baseBranch: string, f: RebaseFailure): string {
  const base = baseBranch || 'the working branch';
  const e = f.rebaseError;
  const lines = [
    `Updating the card branch with ${base} failed before the ${stage} stage${e ? `: \`${e.command}\` exited ${e.exitCode}` : ''}.`,
  ];
  if (f.fileLessConflict)
    lines.push(
      'The runner reported a conflict but git listed no conflicting files, so this is not a code conflict.',
    );
  const said = e?.stderr?.trim() || usefulDetail(f.detail);
  lines.push(said ? `Git said: ${said}` : 'Git gave no message.');
  lines.push(
    "This is a problem on the workstation, not in the card's code: the card was not sent back to Rework.",
  );
  return lines.join('\n');
}

/**
 * The card and desk text for a finalize that did not land and is not a real conflict (applyFinalizeResult's failure
 * route): a rebase error or an older runner's file-less "conflict" gets {@link rebaseErrorText}, anything else today's
 * "Finalize (<action>) failed: <message>".
 */
export function finalizeFailureText(
  action: string,
  baseBranch: string,
  result: Pick<FinalizeResult, 'conflict' | 'conflictedFiles' | 'rebaseError' | 'error'> | null,
  error?: string | null,
): string {
  if (result?.rebaseError || (result?.conflict && !isRealConflict(result.conflictedFiles)))
    return `Finalize (${action}) did not land. ${rebaseErrorText('finalize', baseBranch, {
      rebaseError: result.rebaseError ?? null,
      detail: result.error ?? error ?? null,
      fileLessConflict: !result.rebaseError && !!result.conflict,
    })}`;
  return `Finalize (${action}) failed: ${result?.error ?? error ?? 'the completion action failed'}`;
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
