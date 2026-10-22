import { randomUUID } from 'node:crypto';
import {
  bugDescription,
  DESK_SUBKIND,
  DevOpsAccessSchema,
  e2eOnlyFailure,
  emptyFields,
  type RunnerToServerOf,
  streamId,
  type TestEnvProblem,
  type TestEvidence,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { agentActor, cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';
import { createDevOpsRequestIn } from './devops.ts';
import { bugJoinEvents } from './phases.ts';
import { spawnCardEvent } from './spawn.ts';
import {
  bugCardEvents,
  latestFailureChild,
  reworkOrEscalateEvents,
  testerLoopQuestionEvents,
} from './tester-loop.ts';

/**
 * A failed feature test (spec "Testing strategy"). A failure in the product is a bug child that shares the parent's
 * worktree and branch (`bugCardEvents`). A failure in the E2E spec or its fixtures is a rework: builders may not change
 * those, so the card goes back to the tester (`TestReworkRequested`), capped when it makes no progress. Two guards keep the
 * product route from looping (GWP-11): a failure that names only E2E paths is a rework whatever scope the tester gave, and
 * a failure reported again after the card's bug card was cancelled creates no new bug card but asks the CEO.
 */
export async function testFailedEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  agentId: string,
  note: string,
  evidence: TestEvidence,
  /** The commit the reporting tester shift started at (`shifts.start_sha`). */
  headSha: string | null = null,
): Promise<AppendInput[]> {
  const title = evidence.title?.trim() || `Bug found testing ${card.ref}`;
  const scope = projectScope(card.org_id, card.project_id);
  // The failure is in the E2E spec or its fixtures: builders may not change those, so a bug card for a builder could
  // never fix it. The card stays in Test and goes back to the tester.
  if (evidence.failureScope === 'e2e_spec')
    return reworkOrEscalateEvents(
      ctx,
      tx,
      card,
      agentId,
      evidence,
      title,
      note,
      `Test failed in the E2E spec itself ("${title}"). No bug card was created: only the tester may change E2E tests, so ${card.ref} stays in Test and goes back to the tester.`,
      headSha,
    );
  const desc = bugDescription({ note, evidence, parentRef: card.ref });
  // A bug child of this failure is still open: append the new findings to it instead of creating a duplicate.
  const open = await one(
    tx,
    `SELECT id, ref FROM cards WHERE parent_card_id=$1 AND card_type='bug' AND origin='test_failure'
        AND status NOT IN ('done','cancelled') AND merged_into_working_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [card.id],
  );
  if (open) {
    return [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'TestFailed',
          payload: { cardId: card.id, testerAgentId: agentId, bugCardId: open.id, evidence, summary: title },
        },
        actor: agentActor(agentId),
        scope,
      },
      cardMessage(
        { id: open.id, org_id: card.org_id, project_id: card.project_id },
        { kind: 'system' },
        'system',
        `The tester failed ${card.ref} again while this bug is still open ("${title}"). No second bug card was created.\n\n${desc}`,
        { duplicateOf: open.id },
      ),
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Test failed again: the open bug card ${open.ref} already covers it, so no new bug card was created. The new findings were added to ${open.ref}; ${card.ref} waits in Test until it passed review.`,
        { bugCardId: open.id },
      ),
    ];
  }
  // Product scope, but does the report name only E2E paths or the artifacts of the E2E capture? Then it is spec work.
  const project = await one(tx, 'SELECT e2e_globs FROM projects WHERE id=$1', [card.project_id]);
  const verdict = e2eOnlyFailure(
    [title, note, evidence.summary, evidence.outputExcerpt, ...evidence.commands].join('\n'),
    (project?.e2e_globs as string[] | undefined) ?? [],
  );
  const previous = await latestFailureChild(tx, card.id);
  const cancelled = previous?.status === 'cancelled' ? previous : undefined;
  if (verdict.e2eOnly)
    return reworkOrEscalateEvents(
      ctx,
      tx,
      card,
      agentId,
      { ...evidence, failureScope: 'e2e_spec' },
      title,
      note,
      `The tester reported "${title}" with scope product, but ${verdict.reason}: that is E2E spec work, which builders may not do. No bug card was created${cancelled ? ` (bug card ${cancelled.ref} was cancelled earlier)` : ''}; ${card.ref} stays in Test and goes back to the tester.`,
      headSha,
    );
  if (cancelled)
    return testerLoopQuestionEvents(ctx, tx, card, {
      reason: 'cancelled_bug',
      summary: `${title}. ${note}`.slice(0, 1500),
      testerAgentId: agentId,
      evidence,
      note,
      title,
      cancelledRef: cancelled.ref,
    });
  return bugCardEvents(tx, card, agentId, note, evidence, title);
}

/** Outcome of a suite or regression card: green ends it; a genuine failure files a bug in Spec and a desk notice. */
export async function suiteOutcomeEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  ws: { id: string },
  agentId: string,
  pass: boolean,
  note: string,
  evidence: TestEvidence,
): Promise<AppendInput[]> {
  const kind = card.origin === 'regression' ? 'regression' : 'full_suite';
  const platform = card.fields?.platform as 'web' | 'mobile' | undefined;
  const scope = projectScope(card.org_id, card.project_id);
  const actor = agentActor(agentId);
  const events: AppendInput[] = [];
  if (pass) {
    events.push({
      streamId: streamId.card(card.id),
      event: { type: 'FullSuitePassed', payload: { suiteCardId: card.id, evidence, kind, platform } },
      actor,
      scope,
    });
  } else {
    const title = evidence.title?.trim() || `E2E failure in ${card.ref}`;
    const description = bugDescription({ note, evidence, parentRef: card.ref });
    const project = (await one(tx, 'SELECT workflow_key FROM projects WHERE id=$1', [
      card.project_id,
    ])) as Row;
    const bug = await spawnCardEvent(tx, {
      from: card,
      title,
      cardType: 'bug',
      origin: card.origin,
      workflowKey: project.workflow_key,
      status: 'draft',
      fields: { ...emptyFields('code'), context: description },
      parentCardId: card.id,
      completionAction: card.completion_action,
    });
    const deskItemId = randomUUID();
    events.push(
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'FullSuiteFailed',
          payload: { suiteCardId: card.id, evidence, testSideFixed: false, kind, platform },
        },
        actor,
        scope,
      },
      bug.event,
      {
        streamId: streamId.card(bug.cardId),
        event: {
          type: 'BugReported',
          payload: {
            ...(kind === 'regression' ? { regressionCardId: card.id } : { suiteCardId: card.id }),
            title,
            description,
            evidence,
            bugCardId: bug.cardId,
            deskItemId,
          },
        },
        actor,
        scope,
      },
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: DESK_SUBKIND.bugReported,
            title: `${kind === 'regression' ? 'Regression' : 'Full-suite'} failure: ${title}`,
            body: `${description}\n\nBug card ${bug.ref} is in Spec for the BA. Nothing is blocked; prioritise the fix or leave it in the queue.`,
            options: [],
            blocking: false,
            pinned: false,
            cardId: bug.cardId,
            projectId: card.project_id,
            affectedCardIds: [bug.cardId],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
      // A bug filed after finalize joins the phase it came from, and the phase waits for it (owner decision A6).
      ...(await bugJoinEvents(tx, bug.cardId, bug.ref, card, {
        orgId: card.org_id,
        projectId: card.project_id,
      })),
    );
  }
  events.push(
    cardMessage(
      card,
      { kind: 'agent', agentId },
      'evidence',
      `${pass ? 'Suite passed' : 'Suite failed'}: ${evidence.summary}`,
    ),
  );
  // The throwaway suite worktree and its branch are not needed any more.
  if (card.worktree_path)
    await enqueueRunnerCommand(tx, ws.id, 'worktree.remove', {
      path: card.worktree_path,
      branchName: card.branch_name ?? undefined,
      deleteBranch: true,
    });
  return events;
}

export const PROBLEM_TEXT: Record<TestEnvProblem, string> = {
  sandbox: 'The agent hit a sandbox or permission problem',
  tooling: 'The agent hit a problem with the tools on this workstation',
  app_not_deployed: 'The application is not deployed or not running on this workstation',
  docker_missing: 'Docker is not installed or not running on this workstation',
  run_plan_missing: 'There is no run plan for this project on this workstation yet',
  run_failed: 'The test environment did not come up',
  target_unreachable: 'The deploy target under test does not answer',
};

/**
 * A blocking desk item: the card cannot be tested until a person fixes the environment and resolves it. Used when the
 * DevOps engineer cannot help (no access, none on the workstation) or already tried twice.
 */
export function testEnvironmentHardStop(
  card: Row,
  problem: TestEnvProblem,
  detail: string,
  why: string,
): AppendInput[] {
  const deskItemId = randomUUID();
  const suffix = detail ? ` (${detail})` : '';
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'escalation',
          subkind: DESK_SUBKIND.testEnvironment,
          title: `${card.ref} cannot be tested: ${PROBLEM_TEXT[problem].toLowerCase()}`,
          body: `${PROBLEM_TEXT[problem]}${suffix}. ${why}\n\nFix the environment (or grant the DevOps engineer the access it needs), then resolve this item and the card returns to the Test queue.`,
          options: [],
          blocking: true,
          pinned: true,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [card.id],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
}

/**
 * `shift.rejected{environment_not_ready}` of a tester shift: ask this workstation's DevOps engineer and park the card
 * until the request completes. Docker missing without install access (or a second failed attempt) is a hard stop:
 * a blocking desk item. Returns the events to append before the claim release.
 */
export async function environmentNotReadyEvents(
  ctx: Ctx,
  tx: Tx,
  ws: { id: string; userId: string },
  card: Row,
  env: NonNullable<RunnerToServerOf<'shift.rejected'>['environment']>,
  /** Lean Team v3 (`aom question --topic environment|sandbox|tooling`): who asks, and what the request says. */
  opts: {
    summary?: string;
    requestedBy?: { kind: 'agent'; id: string; name?: string };
  } = {},
): Promise<AppendInput[]> {
  const problem = env.problem;
  // "Test without an environment" is on for the project: no DevOps request, the tester carries on with what it has.
  const policy = await one(tx, 'SELECT test_without_environment FROM projects WHERE id=$1', [
    card.project_id,
  ]);
  if (policy?.test_without_environment)
    return [
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `${PROBLEM_TEXT[problem]}. This project allows testing without an environment, so ${card.ref} goes back to the tester, who runs what it can and records that no environment was used.`,
        { problem },
      ),
    ];
  const wsRow = (await one(tx, 'SELECT devops_access FROM workstations WHERE id=$1', [ws.id])) as Row;
  const access = DevOpsAccessSchema.parse(wsRow?.devops_access ?? {});
  const canInstall = problem !== 'docker_missing' || (access.allowInstall && access.allowDocker);
  const scope = projectScope(card.org_id, card.project_id);
  const detail = env.detail ? ` (${env.detail})` : '';

  const hardStop = (why: string): AppendInput[] =>
    testEnvironmentHardStop(card, problem, env.detail ?? '', why);

  if (!canInstall) return hardStop('The DevOps engineer cannot install Docker with the access it has.');
  if (Number(card.env_parks) >= 2) return hardStop('The DevOps engineer already tried to fix this twice.');
  let requestId: string;
  try {
    const summary =
      opts.summary ??
      (problem === 'docker_missing'
        ? `Install Docker and make sure it is running: ${card.ref} needs it to run its E2E tests${detail}.`
        : `Start the app: deploy and run the application so the E2E tests of ${card.ref} can run${detail}.`);
    ({ requestId } = await createDevOpsRequestIn(ctx, tx, {
      workstationId: ws.id,
      summary,
      requestedBy: opts.requestedBy ?? { kind: 'system', id: null, name: 'Test environment check' },
      cardId: card.id,
    }));
  } catch {
    return hardStop('This workstation has no DevOps engineer to ask.');
  }
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'TestEnvironmentParked',
        payload: { cardId: card.id, requestId, problem, detail: env.detail ?? '' },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `${PROBLEM_TEXT[problem]}${detail}. The DevOps engineer was asked to fix it; ${card.ref} is parked until the request completes.`,
      { requestId, problem },
    ),
  ];
}
