import { randomUUID } from 'node:crypto';
import { DESK_SUBKIND, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/sql.ts';
import { one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, orgScope, projectScope, SYSTEM_ACTOR } from './common.ts';
import { createDevOpsRequestIn, devopsAgentOn } from './devops.ts';

/** G-Q2: how many times DevOps tries before the conflict goes to the desk. */
export const MAX_CONFLICT_ATTEMPTS = 2;

const list = (files: readonly string[]) =>
  files.length ? files.map((f) => `- ${f}`).join('\n') : '- (unknown)';

/** The instruction DevOps gets for a card whose rebase conflicted. Exported for tests. */
export function cardConflictBrief(
  card: Row,
  attempt: number,
  stage: string,
  baseBranch: string,
  files: readonly string[],
): string {
  const branch = card.branch_name ?? '(the card branch)';
  const tmp = `conflict/${card.ref}-a${attempt}`;
  const base = baseBranch || 'the working branch';
  return [
    `Resolve a merge conflict for card ${card.ref} ("${card.title}"). This is attempt ${attempt} of ${MAX_CONFLICT_ATTEMPTS}.`,
    `The card branch ${branch} no longer rebases cleanly onto ${base} (it conflicted before the ${stage} stage).`,
    `Conflicted files:\n${list(files)}`,
    card.worktree_path
      ? `The card's worktree is ${card.worktree_path}; nobody else is using it while you work.`
      : '',
    'Do this:',
    `1. In the card's worktree create a temporary branch ${tmp} from the card branch.`,
    `2. Fetch origin and rebase ${tmp} onto origin/${base}. Resolve every conflict so that the intent of BOTH sides is kept.`,
    '3. Run the project build and its unit tests.',
    `4. Only if they pass, move the card branch to the result (check out ${branch}, then fast-forward it to ${tmp}) and delete ${tmp}.`,
    `5. If you cannot resolve it or the tests fail, leave the card branch exactly as it was, delete ${tmp}, and say what blocked you.`,
    'Never force-push and never push to the working branch. The card goes back through review and test afterwards.',
    'Finish with `aom devops-done --summary "Resolved: ..."` or `--summary "Not resolved: ..."` in plain language.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * G-Q2, a card's rebase conflicted (before test, or at finalize): DevOps tries to resolve it on a branch first. The card
 * waits for that attempt (parked on the request), then goes to Rework as before, so review and test run again; the
 * thread says what happened and the user gets a notice. After {@link MAX_CONFLICT_ATTEMPTS} failed attempts the
 * conflict goes to the desk instead. Returns events for the caller to append AFTER the `RebaseConflict` event; empty
 * when the workstation has no DevOps engineer (the old behaviour: Rework for the builder).
 */
export async function cardConflictAttemptEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  workstationId: string,
  stage: string,
  baseBranch: string,
  files: readonly string[],
): Promise<AppendInput[]> {
  const agent = await devopsAgentOn(tx, workstationId, card.org_id);
  if (!agent) return [];
  const prior = await one(
    tx,
    `SELECT count(*)::int AS n FROM devops_requests WHERE card_id=$1 AND origin='conflict'`,
    [card.id],
  );
  const attempt = Number(prior?.n ?? 0) + 1;
  const scope = projectScope(card.org_id, card.project_id);
  if (attempt > MAX_CONFLICT_ATTEMPTS) {
    const open = await one(tx, `SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
      card.id,
      DESK_SUBKIND.conflictUnresolved,
    ]);
    if (open) return [];
    const deskItemId = randomUUID();
    return [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'escalation',
            subkind: DESK_SUBKIND.conflictUnresolved,
            title: `${card.ref} has a conflict DevOps could not resolve`,
            body: `DevOps tried ${MAX_CONFLICT_ATTEMPTS} times to combine the card's branch with ${baseBranch || 'the working branch'} and the conflict is still there.\n\nConflicted files:\n${list(files)}\n\nThe card is back in Rework. Decide who should combine the changes.`,
            options: [],
            blocking: false,
            pinned: true,
            cardId: card.id,
            projectId: card.project_id,
            affectedCardIds: [card.id],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `DevOps could not resolve the conflict after ${MAX_CONFLICT_ATTEMPTS} attempts. It is on the desk now.`,
      ),
    ];
  }
  const { requestId } = await createDevOpsRequestIn(ctx, tx, {
    workstationId,
    summary: cardConflictBrief(card, attempt, stage, baseBranch, files),
    requestedBy: { kind: 'system', id: null, name: 'Conflict handling' },
    cardId: card.id,
    orgId: card.org_id,
    origin: 'conflict',
    context: { cardId: card.id },
  });
  const noticeId = randomUUID();
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'ConflictAttemptStarted',
        payload: {
          cardId: card.id,
          requestId,
          attempt,
          source: stage === 'finalize' ? 'finalize' : 'rebase',
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `DevOps is trying to resolve the conflict on a separate branch (attempt ${attempt} of ${MAX_CONFLICT_ATTEMPTS}). The card waits for it, then review and test run again.`,
      { requestId, attempt },
    ),
    {
      streamId: streamId.desk(noticeId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: noticeId,
          kind: 'alert',
          subkind: DESK_SUBKIND.conflictAttempt,
          title: `DevOps is resolving a conflict on ${card.ref}`,
          body: `The card's branch conflicted with ${baseBranch || 'the working branch'}. DevOps works on it on a separate branch (attempt ${attempt} of ${MAX_CONFLICT_ATTEMPTS}); review and tests run again afterwards. Nothing for you to do unless it goes wrong.`,
          options: [],
          blocking: false,
          pinned: false,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
  ];
}

/**
 * G-Q2 for hygiene: a repository's working branch and its remote could not be combined. DevOps gets a follow-up request
 * to resolve it on a branch (tests first); after two attempts in a day it becomes a desk escalation.
 */
export async function hygieneConflictEvents(
  ctx: Ctx,
  tx: Tx,
  req: Row,
  repo: { repoId: string; projectId: string; name: string; localPath: string; workingBranch: string | null },
  detail: string,
): Promise<AppendInput[]> {
  const prior = await one(
    tx,
    `SELECT count(*)::int AS n FROM devops_requests
      WHERE origin='conflict' AND context->>'repoId' = $1 AND created_at > now() - interval '24 hours'`,
    [repo.repoId],
  );
  const attempt = Number(prior?.n ?? 0) + 1;
  const wb = repo.workingBranch ?? 'the working branch';
  const deskItemId = randomUUID();
  const project = await one(tx, 'SELECT org_id FROM projects WHERE id=$1', [repo.projectId]);
  const scope = project ? projectScope(project.org_id, repo.projectId) : orgScope(req.org_id);
  if (attempt > MAX_CONFLICT_ATTEMPTS) {
    return [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'escalation',
            subkind: DESK_SUBKIND.conflictUnresolved,
            title: `${repo.name}: ${wb} and its remote still conflict`,
            body: `DevOps tried ${MAX_CONFLICT_ATTEMPTS} times to combine ${wb} with its remote and could not.\n\n${detail}\n\nSomeone has to combine them in ${repo.localPath}.`,
            options: [],
            blocking: false,
            pinned: true,
            projectId: repo.projectId,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
    ];
  }
  await createDevOpsRequestIn(ctx, tx, {
    workstationId: req.workstation_id,
    summary: [
      `Resolve a merge conflict in ${repo.name} (${repo.localPath}). This is attempt ${attempt} of ${MAX_CONFLICT_ATTEMPTS}.`,
      `Repository hygiene could not combine the working branch ${wb} with origin/${wb}: ${detail}`,
      'Do this:',
      `1. Create a temporary branch conflict/${wb.replaceAll('/', '-')}-a${attempt} from ${wb} and integrate origin/${wb} into it, resolving conflicts so the intent of both sides is kept.`,
      '2. Run the project build and its unit tests.',
      `3. Only if they pass, fast-forward the local ${wb} to the result, then delete the temporary branch. Do NOT push ${wb}: leave the push to repository hygiene, which pushes only genuinely new local commits.`,
      `   First check that origin/${wb} was not rewritten: if \`git reflog show origin/${wb}\` shows an earlier origin/${wb} that is not an ancestor of the current one (a force-push removed commits), this is NOT a conflict. Do not merge the old commits back; run \`git reset --keep origin/${wb}\` (or \`git branch -f ${wb} origin/${wb}\` when ${wb} is not checked out) after saving any commit that was never on origin to a guildwise/saved-work/<date> branch, and report that.`,
      '4. Otherwise leave everything as it was and say what blocked you.',
      'Finish with `aom devops-done --summary "Resolved: ..."` or `--summary "Not resolved: ..."` in plain language.',
    ].join('\n'),
    requestedBy: { kind: 'system', id: null, name: 'Conflict handling' },
    orgId: req.org_id,
    origin: 'conflict',
    context: { repoId: repo.repoId, projectId: repo.projectId },
  });
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.conflictAttempt,
          title: `DevOps is resolving a conflict in ${repo.name}`,
          body: `${wb} and its remote could not be combined during hygiene. DevOps tries on a separate branch and runs the tests first (attempt ${attempt} of ${MAX_CONFLICT_ATTEMPTS}).`,
          options: [],
          blocking: false,
          pinned: false,
          projectId: repo.projectId,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
  ];
}
