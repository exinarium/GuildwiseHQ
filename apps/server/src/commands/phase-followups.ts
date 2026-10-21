import {
  type DeployTargetBrief,
  type FollowupDelegate,
  followupLabel,
  type PhaseCardOutcome,
  type Recipe,
  streamId,
} from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { SYSTEM_ACTOR } from './common.ts';
import { createDevOpsRequestIn } from './devops.ts';
import {
  actorOf,
  baTaskCompleted,
  cardOutcomes,
  followupRows,
  phaseMessage,
  phaseScope,
  queueBaTask,
  systemBy,
} from './phase-events.ts';
import { regressionRunEvents } from './regression.ts';

export const toTargetBrief = (t: Row): DeployTargetBrief => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  host: t.host,
  appUrl: t.app_url,
  notes: t.notes,
});

const skippedText = (skipped: Workstation[]): string =>
  skipped.length
    ? `\nSkipped, offline when the deploy started: ${skipped.map((s) => `${s.name} (${s.owner})`).join(', ')}.`
    : '';

const targetOf = (db: Queryable, id: string | null) =>
  id ? one(db, 'SELECT * FROM deploy_targets WHERE id=$1', [id]) : Promise.resolve(undefined);

// ------------------------------------------------------------------------------- where it runs

interface Workstation {
  id: string;
  name: string;
  userId: string;
  owner: string;
  /** Connected and seen within the online window when the query ran. */
  online: boolean;
}

/** A workstation counts as online when its runner is connected and was seen this recently (as everywhere else). */
const ONLINE_WINDOW_MS = 45_000;

const WS_SELECT = `SELECT w.id, w.name, w.user_id, w.connected, w.last_seen_at, u.display_name AS owner FROM workstations w
  JOIN users u ON u.id = w.user_id AND u.status = 'active'`;
const HAS_DEVOPS = `EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.is_devops AND a.status = 'active')`;

const toWs = (r: Row, now: Date = new Date()): Workstation => ({
  id: r.id,
  name: r.name,
  userId: r.user_id,
  owner: r.owner,
  online:
    !!r.connected &&
    !!r.last_seen_at &&
    new Date(r.last_seen_at).getTime() > now.getTime() - ONLINE_WINDOW_MS,
});

/**
 * Where a deploy runs. A remote host names its workstation; "deploy to the local stack" fans out to every workstation
 * of every active project member that has a DevOps engineer (owner decision A9), the owner's first.
 */
export async function deployWorkstations(
  db: Queryable,
  project: Row,
  target: Row,
  now: Date,
): Promise<Workstation[]> {
  if (target.kind === 'remote_ssh' || target.workstation_id) {
    // A remote host names its workstation; a local Docker target may name one too ("on this computer").
    return (
      await rows(db, `${WS_SELECT} WHERE w.id=$1 AND w.status='active' AND ${HAS_DEVOPS}`, [
        target.workstation_id,
      ])
    ).map((r) => toWs(r, now));
  }
  return (
    await rows(
      db,
      `${WS_SELECT} JOIN project_members pm ON pm.user_id = w.user_id AND pm.project_id = $1 AND pm.status = 'active'
        WHERE w.status='active' AND ${HAS_DEVOPS}
        ORDER BY (w.user_id = $2) DESC, w.paired_at, w.id`,
      [project.id, project.org_id],
    )
  ).map((r) => toWs(r, now));
}

/** A custom follow-up for DevOps: the workstation of the phase's first remote target, else the owner's most recently seen one. */
async function customWorkstation(db: Queryable, project: Row, phase: Row): Promise<Workstation | undefined> {
  const remote = await one(
    db,
    `SELECT t.workstation_id FROM phase_followups f JOIN deploy_targets t ON t.id = f.target_id
      WHERE f.phase_id=$1 AND t.kind='remote_ssh' ORDER BY f.position LIMIT 1`,
    [phase.id],
  );
  if (remote) {
    const w = await one(db, `${WS_SELECT} WHERE w.id=$1 AND w.status='active' AND ${HAS_DEVOPS}`, [
      remote.workstation_id,
    ]);
    if (w) return toWs(w);
  }
  const mine = await one(
    db,
    `${WS_SELECT} WHERE w.user_id=$1 AND w.status='active' AND ${HAS_DEVOPS} ORDER BY w.last_seen_at DESC NULLS LAST LIMIT 1`,
    [project.org_id],
  );
  return mine ? toWs(mine) : undefined;
}

/** The workstation a regression run is pinned to: where the local stack was just deployed (a tester there first). */
async function regressionWorkstation(
  db: Queryable,
  phase: Row,
  f: Row,
  target: Row | undefined,
): Promise<string | undefined> {
  if (target && target.kind === 'remote_ssh') return undefined;
  const deploys = await rows(
    db,
    `SELECT evidence FROM phase_followups WHERE phase_id=$1 AND kind='deploy' AND status='succeeded'
        AND ($2::uuid IS NULL OR target_id = $2) ORDER BY position DESC`,
    [phase.id, f.target_id],
  );
  const deployed: string[] = deploys.flatMap((d) => (d.evidence?.deployedWorkstationIds as string[]) ?? []);
  if (deployed.length === 0) return undefined;
  const withTester = await one(
    db,
    `SELECT w.id FROM workstations w WHERE w.id = ANY($1::uuid[]) AND EXISTS (
       SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.role_key='tester' AND a.status='active')
      ORDER BY array_position($1::uuid[], w.id) LIMIT 1`,
    [deployed],
  );
  return withTester?.id ?? deployed[0];
}

// ------------------------------------------------------------------------------------ starting

const finished = (
  phase: Row,
  followupId: string,
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled',
  summary: string,
  evidence: Record<string, unknown> = {},
): AppendInput => ({
  streamId: streamId.phase(phase.id),
  event: {
    type: 'PhaseFollowupFinished',
    payload: { phaseId: phase.id, followupId, status, summary, evidence },
  },
  actor: SYSTEM_ACTOR,
  scope: phaseScope(phase),
});

export const followupFinishedEvent = finished;

/**
 * Starts a briefed follow-up: a DevOps request (a local deploy fans out, one per workstation), regression cards, or a
 * BA task for a custom follow-up the BA does itself. Appends in `tx`. A follow-up that cannot start fails at once
 * with the reason (no DevOps engineer, no repository), so the sequence stops instead of waiting for nothing.
 */
export async function startFollowup(ctx: Ctx, tx: Tx, phase: Row, project: Row, f: Row): Promise<void> {
  const list = await followupRows(tx, phase.id);
  const n = f.position as number;
  const label = followupLabel({ kind: f.kind, platform: f.platform, instruction: f.instruction }, null);
  const target = await targetOf(tx, f.target_id);
  const delegate = (f.delegate ??
    (f.kind === 'regression' ? 'tester' : f.kind === 'deploy' ? 'devops' : 'devops')) as FollowupDelegate;
  const prefix = `Follow-up ${n} of ${list.length} (${target ? followupLabel({ kind: f.kind, platform: f.platform, instruction: f.instruction }, target.name) : label}) started`;
  const fail = async (why: string) =>
    ctx.store.append(
      [
        finished(phase, f.id, 'failed', why),
        phaseMessage(phase, { kind: 'system' }, `Follow-up ${n} could not start: ${why}`),
      ],
      { tx },
    );

  // A recipe project deploys through its approved recipe: no prose request. The deploy run is requested outside this
  // transaction by the dispatcher (`deployStep`); the follow-up finishes with the run (`followupVerdict`).
  if (f.kind === 'deploy' && project.delivery_mode === 'recipe') {
    if (!target && !f.environment) return void (await fail('the deploy target no longer exists'));
    const rec = await one(tx, `SELECT approved_parsed, status FROM delivery_recipes WHERE project_id=$1`, [
      project.id,
    ]);
    const env = (rec?.approved_parsed as Recipe | null)?.environments.find((e) =>
      f.environment
        ? e.name === f.environment
        : e.targets.some((t) => t.toLowerCase() === String(target?.name).toLowerCase()),
    );
    if (rec?.status !== 'approved' || !env)
      return void (await fail(
        rec?.status !== 'approved'
          ? 'the delivery recipe is not approved (or changed since): approve it, then deploy'
          : f.environment
            ? `the delivery recipe has no environment called ${f.environment}`
            : `the delivery recipe has no environment for ${target?.name}`,
      ));
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phase.id),
          event: {
            type: 'PhaseFollowupStarted',
            payload: {
              phaseId: phase.id,
              followupId: f.id,
              delegate: 'devops',
              devopsRequestIds: [],
              regressionCardIds: [],
            },
          },
          actor: SYSTEM_ACTOR,
          scope: phaseScope(phase),
        },
        phaseMessage(
          phase,
          { kind: 'system' },
          `${prefix}: deploying ${env.name} through the delivery recipe (${env.releasedBy === 'owner' ? 'it waits in the release queue for the Owner or an Admin' : env.releasedBy === 'ceo' ? 'the CEO releases it' : 'it is released automatically once the gate holds'}).`,
        ),
      ],
      { tx },
    );
    return;
  }

  if (delegate === 'devops') {
    let stations: Workstation[];
    let skipped: Workstation[] = [];
    if (f.kind === 'deploy') {
      if (!target) return void (await fail('the deploy target no longer exists'));
      stations = await deployWorkstations(tx, project, target, ctx.clock.now());
      // A local deploy fans out to every member's workstation; the ones offline right now are skipped, not waited for.
      if (target.kind !== 'remote_ssh') {
        skipped = stations.filter((s) => !s.online);
        stations = stations.filter((s) => s.online);
      }
      if (stations.length === 0 && skipped.length > 0)
        return void (await fail(
          `every workstation with a DevOps engineer is offline (${skipped.map((s) => `${s.name} (${s.owner})`).join(', ')})`,
        ));
      if (stations.length === 0)
        return void (await fail(
          target.kind === 'remote_ssh'
            ? `the workstation of ${target.name} is gone or has no DevOps engineer`
            : 'no workstation of a project member has a DevOps engineer to deploy',
        ));
    } else {
      const ws = await customWorkstation(tx, project, phase);
      if (!ws) return void (await fail('no workstation with a DevOps engineer is available'));
      stations = [ws];
    }
    const requestIds: string[] = [];
    const lines: string[] = [];
    for (const ws of stations) {
      const summary =
        `${f.brief ?? f.instruction}\n\n---\nPhase ${phase.ref} (${phase.name}), follow-up ${n} of ${list.length}.` +
        (stations.length > 1
          ? `\nThis deploy runs on every project member's workstation; you are deploying on "${ws.name}" (${ws.owner}).`
          : '') +
        `\nWhen done, report with \`aom devops-done --summary\` stating the deployed commit and the URL you verified.`;
      const { requestId } = await createDevOpsRequestIn(ctx, tx, {
        workstationId: ws.id,
        summary,
        requestedBy: { kind: 'system', id: null, name: `Phase ${phase.ref} follow-up ${n}` },
      });
      requestIds.push(requestId);
      lines.push(`${ws.name} (${ws.owner}): request ${requestId.slice(0, 8)}`);
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phase.id),
          event: {
            type: 'PhaseFollowupStarted',
            payload: {
              phaseId: phase.id,
              followupId: f.id,
              delegate,
              devopsRequestIds: requestIds,
              regressionCardIds: [],
              skippedOffline: skipped.map((s) => ({ id: s.id, name: s.name, owner: s.owner })),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: phaseScope(phase),
        },
        phaseMessage(
          phase,
          { kind: 'system' },
          `${prefix}: ${stations.length} DevOps request${stations.length === 1 ? '' : 's'} sent.\n${lines.map((l) => `- ${l}`).join('\n')}${skippedText(skipped)}`,
        ),
      ],
      { tx },
    );
    return;
  }

  if (delegate === 'tester') {
    const pin = await regressionWorkstation(tx, phase, f, target);
    const platform = (f.platform ?? 'web') as 'web' | 'mobile' | 'both';
    let run: Awaited<ReturnType<typeof regressionRunEvents>>;
    try {
      run = await regressionRunEvents(tx, project, {
        platform,
        ownerUserId: await orgOwnerId(tx, project.org_id),
        requestedBy: phase.approved_by ?? (await orgOwnerId(tx, project.org_id)),
        actor: SYSTEM_ACTOR,
        scheduled: true,
        startedBy: `phase ${phase.ref} follow-up ${n}`,
        extra: {
          ...(pin ? { homeWorkstationId: pin } : {}),
          phaseFollowupId: f.id,
          fields: {
            ...(target?.app_url ? { targetUrl: target.app_url } : {}),
            ...(target ? { deployTarget: target.name } : {}),
            context: f.brief ?? `Regression run for phase ${phase.ref}`,
            ...(f.mock ? { mock: f.mock } : {}),
          },
        },
      });
    } catch (err) {
      return void (await fail(err instanceof Error ? err.message : String(err)));
    }
    await ctx.store.append(
      [
        ...run.events,
        {
          streamId: streamId.phase(phase.id),
          event: {
            type: 'PhaseFollowupStarted',
            payload: {
              phaseId: phase.id,
              followupId: f.id,
              delegate,
              devopsRequestIds: [],
              regressionCardIds: run.cards.map((c) => c.id),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: phaseScope(phase),
        },
        phaseMessage(
          phase,
          { kind: 'system' },
          `${prefix}: regression run ${run.cards.map((c) => c.ref).join(', ')}${pin ? ' pinned to the workstation that was just deployed' : ''}${target?.app_url ? ` against ${target.app_url}` : ''}.`,
        ),
      ],
      { tx },
    );
    return;
  }

  // delegate 'ba': a custom follow-up the BA carries out itself
  const task = await queueBaTask(tx, phase, 'followup_custom', f.id);
  await ctx.store.append(
    [
      task.event,
      {
        streamId: streamId.phase(phase.id),
        event: {
          type: 'PhaseFollowupStarted',
          payload: {
            phaseId: phase.id,
            followupId: f.id,
            delegate,
            devopsRequestIds: [],
            regressionCardIds: [],
            baTaskId: task.taskId,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: phaseScope(phase),
      },
      phaseMessage(phase, { kind: 'system' }, `${prefix}: the BA carries it out.`),
    ],
    { tx },
  );
}

// -------------------------------------------------------------------------------------- results

export interface FollowupVerdict {
  status: 'succeeded' | 'failed';
  summary: string;
  evidence: Record<string, unknown>;
}

/** What a running DevOps or regression follow-up has come to, or null while it is still going. */
export async function followupVerdict(db: Queryable, f: Row): Promise<FollowupVerdict | null> {
  if (f.kind === 'deploy' && !f.devops_request_ids?.length) {
    const runs = await rows(
      db,
      `SELECT id, status, target_name, env, summary, refusal, refusal_detail FROM deploy_runs
        WHERE phase_followup_id=$1 AND NOT trial ORDER BY created_at, id`,
      [f.id],
    );
    if (runs.length === 0) return null;
    const open = runs.some((r) => ['requested', 'waiting_release', 'queued', 'running'].includes(r.status));
    const evidence = { deployRunIds: runs.map((r) => r.id) };
    const say = (r: Row) =>
      `${r.target_name}: ${r.status === 'succeeded' ? (r.summary ?? 'deployed') : (r.refusal_detail ?? r.summary ?? r.status)}`;
    const bad = runs.filter((r) => ['failed', 'refused', 'cancelled'].includes(r.status));
    if (bad.length) return open ? null : { status: 'failed', summary: runs.map(say).join('\n'), evidence };
    if (open) return null;
    return { status: 'succeeded', summary: runs.map(say).join('\n'), evidence };
  }
  if (f.devops_request_ids?.length) {
    const reqs = await rows(
      db,
      `SELECT r.id, r.status, r.result_summary, r.thread_id, r.workstation_id, w.name AS workstation
         FROM devops_requests r JOIN workstations w ON w.id = r.workstation_id
        WHERE r.id = ANY($1::uuid[]) ORDER BY r.created_at, r.id`,
      [f.devops_request_ids],
    );
    const commands = (
      await rows(
        db,
        'SELECT commands FROM environment_changes WHERE request_id = ANY($1::uuid[]) ORDER BY created_at, id',
        [f.devops_request_ids],
      )
    ).flatMap((c) => c.commands as string[]);
    const evidence = {
      requests: reqs.map((r) => ({
        id: r.id,
        workstationId: r.workstation_id,
        workstation: r.workstation,
        status: r.status,
        threadId: r.thread_id,
        summary: r.result_summary,
      })),
      deployedWorkstationIds: reqs.filter((r) => r.status === 'done').map((r) => r.workstation_id),
      commands,
      ...(f.evidence?.skippedOffline?.length ? { skippedOffline: f.evidence.skippedOffline } : {}),
    };
    const skippedNote = (evidence.skippedOffline as Array<{ name: string; owner: string }> | undefined)
      ?.length
      ? `\nSkipped, offline when the deploy started: ${(evidence.skippedOffline as Array<{ name: string; owner: string }>).map((s) => `${s.name} (${s.owner})`).join(', ')}.`
      : '';
    const failed = reqs.filter((r) => r.status === 'failed');
    const say = (r: Row) => `${r.workstation}: ${r.result_summary ?? r.status}`;
    if (failed.length)
      return {
        status: 'failed',
        summary: `Failed on ${failed.map((r) => r.workstation).join(', ')}: ${failed.map((r) => r.result_summary ?? 'failed').join('; ')}${reqs.length > 1 ? `\n${reqs.filter((r) => r.status === 'done').length} of ${reqs.length} succeeded.` : ''}${skippedNote}`,
        evidence,
      };
    if (reqs.length > 0 && reqs.every((r) => r.status === 'done'))
      return {
        status: 'succeeded',
        summary:
          (reqs.length === 1 ? (reqs[0]?.result_summary ?? 'done') : reqs.map(say).join('\n')) + skippedNote,
        evidence,
      };
    return null;
  }
  if (f.regression_card_ids?.length) {
    const cards = await rows(
      db,
      'SELECT id, ref, status FROM cards WHERE id = ANY($1::uuid[]) ORDER BY number',
      [f.regression_card_ids],
    );
    if (cards.some((c) => c.status === 'cancelled'))
      return {
        status: 'failed',
        summary: 'The regression run was cancelled.',
        evidence: { cardRefs: cards.map((c) => c.ref) },
      };
    if (!cards.every((c) => c.status === 'done')) return null;
    const runs = [];
    for (const c of cards) {
      const run = await one(
        db,
        'SELECT id, result, evidence FROM test_runs WHERE card_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [c.id],
      );
      const bugs = await rows(
        db,
        `SELECT id, ref FROM cards WHERE parent_card_id=$1 AND card_type='bug' ORDER BY number`,
        [c.id],
      );
      runs.push({ card: c, run, bugs });
    }
    const evidence = {
      cardRefs: cards.map((c) => c.ref),
      testRunIds: runs.flatMap((r) => (r.run ? [r.run.id] : [])),
      bugCardIds: runs.flatMap((r) => r.bugs.map((b) => b.id)),
      bugRefs: runs.flatMap((r) => r.bugs.map((b) => b.ref)),
    };
    const bad = runs.filter((r) => r.run?.result !== 'passed');
    if (bad.length)
      return {
        status: 'failed',
        summary: `Regression run failed (${bad.map((r) => r.card.ref).join(', ')})${evidence.bugRefs.length ? `; bug ${evidence.bugRefs.join(', ')}` : ''}: ${bad.map((r) => r.run?.evidence?.summary ?? 'no result').join('; ')}`,
        evidence,
      };
    return {
      status: 'succeeded',
      summary: `Regression run passed (${cards.map((c) => c.ref).join(', ')}): ${runs.map((r) => r.run?.evidence?.summary ?? 'passed').join('; ')}`,
      evidence,
    };
  }
  return null;
}

// ------------------------------------------------------------------------------------ fallbacks

/** Template cards snapshot for briefs and reports (the phase's outcome snapshot, or computed live). */
export async function outcomesOf(db: Queryable, phase: Row): Promise<PhaseCardOutcome[]> {
  const snap = phase.card_outcomes as PhaseCardOutcome[] | null;
  return snap && snap.length ? snap : cardOutcomes(db, phase.id);
}

export { actorOf, baTaskCompleted, systemBy };
