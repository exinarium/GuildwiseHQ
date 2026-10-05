import {
  type CardType,
  getStage,
  type RegressionPlatform,
  type RegressionResponse,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { projectScope, userActor } from './common.ts';
import { spawnCardEvent } from './spawn.ts';

export interface RegressionCardsInput {
  platform: RegressionPlatform;
  /** The user the cards belong to (the project owner for scheduled runs). */
  ownerUserId: string;
  /** Who started it: the manager, or the system for a scheduled run. */
  requestedBy: string;
  actor: AppendInput['actor'];
  /** Scheduled runs jump the queue and may get an overflow shift (one extra shift per organization). */
  scheduled: boolean;
  startedBy: string;
  /** A phase follow-up's run: pin the cards to a workstation, tag them with the follow-up, add card fields. */
  extra?: {
    homeWorkstationId?: string;
    phaseFollowupId?: string;
    fields?: Record<string, unknown>;
  };
}

/**
 * The events of one regression run: a regression card per platform queued at Test, plus `RegressionRequested`.
 * Shared by the manager's endpoint and by regression schedules (the scheduler). The caller appends them in its tx.
 */
export async function regressionRunEvents(
  tx: Tx,
  project: Row,
  input: RegressionCardsInput,
): Promise<{ events: AppendInput[]; cards: RegressionResponse['cards'] }> {
  const wf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!wf || !getStage(wf.definition, 'test'))
    throw conflict('no_test_stage', 'this project workflow has no test stage');
  const repo = (
    await rows(
      tx,
      `SELECT * FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY id LIMIT 1`,
      [project.id],
    )
  )[0] as Row | undefined;
  if (!repo) throw conflict('no_repo', 'the project has no repository to run a regression on');
  const platforms: Array<'web' | 'mobile'> = input.platform === 'both' ? ['web', 'mobile'] : [input.platform];
  const base = {
    project_id: project.id,
    org_id: project.org_id,
    owner_user_id: input.ownerUserId,
    repo_id: repo.id,
    priority: 2,
    workflow_version_id: wf.id,
  };
  const events: AppendInput[] = [];
  const created: RegressionResponse['cards'] = [];
  for (const [i, p] of platforms.entries()) {
    const c = await spawnCardEvent(
      tx,
      {
        from: base as Row,
        title: `Regression run (${p})`,
        cardType: 'regression' as CardType,
        origin: 'regression',
        stage: 'test',
        status: 'queued',
        scheduled: input.scheduled,
        fields: {
          context: `Regression run for ${p}, started by ${input.startedBy}.`,
          platform: p,
          ...(input.extra?.fields ?? {}),
        },
        actor: input.actor,
        ownerUserId: input.ownerUserId,
        ...(input.extra?.homeWorkstationId ? { homeWorkstationId: input.extra.homeWorkstationId } : {}),
        ...(input.extra?.phaseFollowupId ? { phaseFollowupId: input.extra.phaseFollowupId } : {}),
      },
      i,
    );
    events.push(c.event);
    created.push({ id: c.cardId, ref: c.ref, platform: p });
  }
  events.push({
    streamId: streamId.project(project.id),
    event: {
      type: 'RegressionRequested',
      payload: {
        projectId: project.id,
        platform: input.platform,
        requestedBy: input.requestedBy,
        regressionCardId: (created[0] as { id: string }).id,
        regressionCardIds: created.map((c) => c.id),
      },
    },
    actor: input.actor,
    scope: projectScope(project.org_id, project.id),
  });
  return { events, cards: created };
}

/** Manager starts a regression run: one regression card per platform, queued at Test for testers. */
export async function requestRegression(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  platform: RegressionPlatform,
): Promise<RegressionResponse> {
  return withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, projectId);
    if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
    const { events, cards } = await regressionRunEvents(tx, project, {
      platform,
      ownerUserId: user.id,
      requestedBy: user.id,
      actor: userActor(user.id),
      scheduled: false,
      startedBy: user.displayName,
    });
    await ctx.store.append(events, { tx });
    return { cards };
  });
}
