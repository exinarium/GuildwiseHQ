import {
  DELEGATE_LIMITS,
  DelegateBeginParamsSchema,
  type DelegateBeginResult,
  DelegateCostParamsSchema,
  type DelegateOwnerKind,
  type DelegateProfile,
  type DelegateTargetSpec,
  effectiveProfile,
  isKnownChoice,
  type KeyUseReport,
  profileOfPermissions,
  purposeMayDelegate,
  streamId,
} from '@aom/shared';
import { orgScope, runnerActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { withTx } from '../db/tx.ts';
import { providerCapProblem } from '../provider-keys/caps.ts';
import { assertProjectMayRun, sessionCost } from './cost.ts';
import { grantsWithHandles } from './delegate-grants.ts';
import { runtimeProblem, runtimeReports } from './offer.ts';

/** `[ok, result, error]`, as every rpc handler of the gateway answers. */
type Reply = [boolean, unknown?, string?];

/** Shift kinds whose agents may delegate. The CEO's and the DevOps engineer's own turns never do (they hold wider powers). */
const SHIFT_KINDS = new Set(['card', 'question', 'ba_task', 'chat']);

type Caller = { kind: 'session_turn'; row: Row } | { kind: 'shift'; row: Row; project: string | null };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The server side of `aom delegate` (explicit since R3b). The runner runs the child; it asks here first (`delegate.begin`) and
 * reports the usage after (`delegate.cost`). `begin` is where a refusal belongs: the caller must be running, a grant must name
 * the target (an agent's, or the session's for its facilitator and Chair; none by default), the target's model is the one
 * configured for it (a hired agent's own, never the caller's choice), the workstation must be able to run it, the provider cap,
 * the session budget and the project budget must have room, and the per-target and per-caller counts must not be used up.
 * `cost` books the usage under the caller (`DelegateCompleted`); it is accepted even when the caller has just ended, because the
 * tokens were spent.
 */
export async function delegateRpc(
  ctx: Ctx,
  workstationId: string,
  callerId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Reply> {
  try {
    const caller = await loadCaller(ctx, workstationId, callerId);
    if (!caller) return [false, undefined, 'unknown caller'];
    if (method === 'delegate.begin') return await begin(ctx, caller, params, workstationId);
    if (method === 'delegate.heartbeat') return await heartbeat(ctx, workstationId, caller, params);
    if (method === 'delegate.cost') return await cost(ctx, workstationId, caller, params);
    return [false, undefined, `${method} is not available`];
  } catch (err) {
    return [false, undefined, message(err)];
  }
}

async function loadCaller(ctx: Ctx, workstationId: string, id: string): Promise<Caller | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const turn = await one(ctx.pool, 'SELECT * FROM session_turns WHERE id=$1 AND workstation_id=$2', [
    id,
    workstationId,
  ]);
  if (turn) return { kind: 'session_turn', row: turn };
  const shift = await one(
    ctx.pool,
    `SELECT s.*, ag.role_key AS agent_role, ag.is_devops AS agent_is_devops,
            COALESCE(s.project_id, c.project_id, bt.project_id) AS eff_project_id
       FROM shifts s JOIN agents ag ON ag.id = s.agent_id
       LEFT JOIN cards c ON c.id = s.card_id LEFT JOIN ba_tasks bt ON bt.id = s.ba_task_id
      WHERE s.id=$1 AND s.workstation_id=$2`,
    [id, workstationId],
  );
  return shift ? { kind: 'shift', row: shift, project: shift.eff_project_id ?? null } : undefined;
}

const noGrant = (what: string): Reply => [
  false,
  undefined,
  `not_granted: ${what}. Delegation is off unless an Owner, an Admin or the agent's manager (or the session's creator) grants this target.`,
];

async function begin(
  ctx: Ctx,
  caller: Caller,
  params: Record<string, unknown>,
  workstationId: string,
): Promise<Reply> {
  const p = DelegateBeginParamsSchema.safeParse(params);
  if (!p.success)
    return [
      false,
      undefined,
      'invalid delegate request (an older runner cannot delegate: update the runner)',
    ];
  if (!isKnownChoice(p.data.model)) return [false, undefined, `unknown model "${p.data.model.model}"`];
  if (p.data.taskChars > DELEGATE_LIMITS.maxTaskChars)
    return [false, undefined, `the task is longer than ${DELEGATE_LIMITS.maxTaskChars} characters`];
  const now = ctx.clock.now();
  let sessionBudgeted = false;
  let owner: { kind: DelegateOwnerKind; id: string };
  if (caller.kind === 'session_turn') {
    const turn = caller.row;
    if (turn.status !== 'running') return [false, undefined, 'this turn is over'];
    const purpose = (turn.meta as { purpose?: string } | null)?.purpose;
    if (!purposeMayDelegate(purpose)) return noGrant('`aom delegate` is not available in this turn');
    const t = await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1 AND deleted_at IS NULL', [
      turn.thread_id,
    ]);
    if (!t) return [false, undefined, 'the session no longer exists'];
    owner = { kind: 'session', id: t.id };
    const c = await sessionCost(ctx.pool, t);
    sessionBudgeted = c.budgetUsd !== null;
    if (c.exceeded)
      return [
        false,
        undefined,
        `session_budget_exceeded: this session has used its budget of $${(c.budgetUsd ?? 0).toFixed(2)} (spent $${c.costUsd.toFixed(2)}); the delegate was not started`,
      ];
    try {
      await assertProjectMayRun(ctx.pool, t.project_id, now, 'session');
    } catch (err) {
      return [false, undefined, message(err)];
    }
  } else {
    const s = caller.row;
    if (s.status !== 'starting' && s.status !== 'running') return [false, undefined, 'this shift is over'];
    if (!SHIFT_KINDS.has(s.kind) || s.agent_is_devops || s.agent_role === 'ceo' || s.agent_role === 'devops')
      return noGrant('`aom delegate` is not available to this agent');
    owner = { kind: 'agent', id: s.agent_id };
    try {
      await assertProjectMayRun(ctx.pool, caller.project, now, 'shift');
    } catch (err) {
      return [false, undefined, message(err)];
    }
  }
  // The grant: the caller names a target by its handle; no grant, no delegation.
  const handle = p.data.target.replace(/^persona:/, '');
  const grants = await grantsWithHandles(ctx.pool, owner.kind, owner.id);
  const g = grants.find((x) => x.handle === handle);
  if (!g)
    return noGrant(
      grants.length
        ? `"${handle}" is not one of your delegation targets (${grants.map((x) => x.handle).join(', ')})`
        : 'you have no delegation targets',
    );
  const grantMax = (g.row.max_profile ?? null) as DelegateProfile | null;
  // R3c (Q62): the grant may set the model the target runs on for this caller; the caller still cannot choose
  const override =
    g.row.model_runtime && g.row.model_name
      ? { runtime: g.row.model_runtime as string, model: g.row.model_name as string }
      : null;
  let choice = p.data.model;
  let profile: DelegateProfile;
  let target: DelegateTargetSpec;
  const common = {
    handle: g.handle,
    key: g.row.target_key as string,
    maxCalls: g.row.max_calls as number,
    timeoutSec: g.row.timeout_sec as number,
    maxProfile: grantMax,
    ...(override ? { modelOverride: override } : {}),
  };
  if (g.row.target_kind === 'agent') {
    const a = g.agent;
    if (!a || a.status === 'retired' || a.is_devops || a.role_key === 'ceo' || a.role_key === 'devops')
      return [false, undefined, `"${handle}" cannot be a delegate now (the agent is retired or unavailable)`];
    // The model is the grant's (Q62), else the agent's own. The runner may not pick another one.
    const mine = override ?? { runtime: a.runtime as string, model: a.model as string };
    if (p.data.model.runtime !== mine.runtime || p.data.model.model !== mine.model)
      return [
        false,
        undefined,
        `model_locked: "${handle}" runs on ${mine.runtime}:${mine.model}, the model configured for it; the caller cannot choose another`,
      ];
    choice = mine;
    profile = effectiveProfile(
      profileOfPermissions(a.permissions ?? { allowedTools: [] }),
      'shell',
      grantMax,
    );
    target = {
      kind: 'agent',
      ...common,
      name: a.name,
      description: '',
      runtime: mine.runtime,
      model: mine.model,
      profile,
    };
  } else {
    if (override && (p.data.model.runtime !== override.runtime || p.data.model.model !== override.model))
      return [
        false,
        undefined,
        `model_locked: "${handle}" runs on ${override.runtime}:${override.model}, the model its grant sets; the caller cannot choose another`,
      ];
    if (override) choice = override;
    profile = effectiveProfile(p.data.profile ?? 'read_only', 'shell', grantMax);
    target = { kind: 'persona', ...common, name: handle, description: '', profile };
  }
  // The workstation must be able to run the target's model, and the organization's key of its provider must have room (Q48).
  const reports = await runtimeReports(ctx.pool, workstationId);
  const orgId = caller.row.org_id as string;
  const problem = runtimeProblem(reports, choice, orgId);
  if (problem) return [false, undefined, `runtime_unavailable: ${problem}`];
  const capped = await providerCapProblem(ctx.pool, orgId, reports as unknown as KeyUseReport[], choice, now);
  if (capped) return [false, undefined, `provider_cap_reached: ${capped}`];
  return reserve(ctx, caller, p.data.delegateId, now, sessionBudgeted, workstationId, {
    target,
    profile,
    model: choice,
    native: p.data.native === true,
  });
}

/**
 * A delegate that has not reported its cost this long after it began is taken to be gone. A runner that sends heartbeats is
 * held to `heartbeatStaleMs` after the last one; an older runner (no heartbeat) gets its own limit plus a grace period.
 */
const STALE_NO_HEARTBEAT_MS = DELEGATE_LIMITS.timeoutMs + 30_000;

/** `delegate.heartbeat`: the runner says the delegate is alive. */
async function heartbeat(
  ctx: Ctx,
  workstationId: string,
  caller: Caller,
  params: Record<string, unknown>,
): Promise<Reply> {
  const id = typeof params.delegateId === 'string' ? params.delegateId : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return [false, undefined, 'invalid delegate heartbeat'];
  // only the delegate this caller began on this workstation: another delegate's slot cannot be held open or touched
  const r = await ctx.pool.query(
    'UPDATE delegate_begins SET heartbeat_at=$2 WHERE delegate_id=$1 AND caller_id=$3 AND workstation_id=$4',
    [id, ctx.clock.now(), caller.row.id, workstationId],
  );
  if (!r.rowCount) return [false, undefined, 'unknown delegate'];
  return [true, {}];
}

/** A workstation's runner disconnected: its running delegates are gone, so their slots are freed now. */
export async function releaseDelegatesOf(ctx: Ctx, workstationId: string): Promise<void> {
  await ctx.pool.query('DELETE FROM delegate_begins WHERE workstation_id=$1', [workstationId]);
}

/**
 * Counts what the caller has started, finished or still running, and records this one, in one step under a lock per caller. A
 * session or project with a budget runs one delegate at a time: the budget is checked against costs that are booked when a
 * delegate ends, so with several running at once none of them would see what the others are about to spend.
 */
async function reserve(
  ctx: Ctx,
  caller: Caller,
  delegateId: string,
  now: Date,
  sessionBudgeted: boolean,
  workstationId: string,
  info: {
    target: DelegateTargetSpec;
    profile: DelegateProfile;
    model: { runtime: string; model: string };
    native: boolean;
  },
): Promise<Reply> {
  const row = caller.row;
  const answer: DelegateBeginResult = { delegateId, target: info.target, profile: info.profile };
  const threadId: string | null = caller.kind === 'session_turn' ? (row.thread_id ?? null) : null;
  return withTx(ctx.pool, async (tx): Promise<Reply> => {
    const projectId: string | null =
      caller.kind === 'shift'
        ? caller.project
        : ((await one(tx, 'SELECT project_id FROM threads WHERE id=$1', [threadId]))?.project_id ?? null);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delegate:${row.id}`]);
    await tx.query(
      `DELETE FROM delegate_begins
        WHERE (heartbeat_at IS NULL AND begun_at < $1)
           OR (heartbeat_at IS NOT NULL AND heartbeat_at < $2)`,
      [
        new Date(now.getTime() - STALE_NO_HEARTBEAT_MS),
        new Date(now.getTime() - DELEGATE_LIMITS.heartbeatStaleMs),
      ],
    );
    if (await one(tx, 'SELECT 1 FROM delegate_begins WHERE delegate_id=$1', [delegateId]))
      return [true, answer]; // a retried begin is the same delegate
    const used = await one(
      tx,
      `SELECT (SELECT count(*) FROM shift_costs WHERE parent_id=$1)
            + (SELECT count(*) FROM delegate_begins b WHERE b.caller_id=$1
                  AND NOT EXISTS (SELECT 1 FROM shift_costs sc WHERE sc.shift_id = b.delegate_id)) AS n`,
      [row.id],
    );
    if (Number(used?.n ?? 0) >= DELEGATE_LIMITS.maxPerCaller)
      return [
        false,
        undefined,
        `at most ${DELEGATE_LIMITS.maxPerCaller} delegates per ${caller.kind === 'shift' ? 'shift' : 'turn'}: work with what you have`,
      ];
    // the grant's own count for this target (finished and still running)
    const forTarget = await one(
      tx,
      `SELECT (SELECT count(*) FROM shift_costs WHERE parent_id=$1 AND delegate_target=$2)
            + (SELECT count(*) FROM delegate_begins b WHERE b.caller_id=$1 AND b.target=$2
                  AND NOT EXISTS (SELECT 1 FROM shift_costs sc WHERE sc.shift_id = b.delegate_id)) AS n`,
      [row.id, info.target.handle],
    );
    if (Number(forTarget?.n ?? 0) >= info.target.maxCalls)
      return [
        false,
        undefined,
        `at most ${info.target.maxCalls} call${info.target.maxCalls === 1 ? '' : 's'} to "${info.target.handle}" per ${caller.kind === 'shift' ? 'shift' : 'turn'}: work with what you have`,
      ];
    const running = async (col: 'thread_id' | 'project_id', id: string): Promise<boolean> =>
      !!(await one(
        tx,
        `SELECT 1 FROM delegate_begins b WHERE b.${col}=$1
            AND NOT EXISTS (SELECT 1 FROM shift_costs sc WHERE sc.shift_id = b.delegate_id) LIMIT 1`,
        [id],
      ));
    if (threadId && sessionBudgeted && (await running('thread_id', threadId)))
      return [
        false,
        undefined,
        'session_budget_pending: a delegate of this session is still running and the session has a budget; try again when it has finished',
      ];
    const projectBudgeted =
      !!projectId &&
      !!(await one(tx, 'SELECT 1 FROM projects WHERE id=$1 AND budget_micros IS NOT NULL', [projectId]));
    if (projectId && projectBudgeted && (await running('project_id', projectId)))
      return [
        false,
        undefined,
        'project_budget_pending: a delegate of this project is still running and the project has a budget; try again when it has finished',
      ];
    await tx.query(
      `INSERT INTO delegate_begins (delegate_id, caller_id, org_id, thread_id, project_id, begun_at, workstation_id, target,
         target_kind, target_name, runtime, model, profile, native, caller_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        delegateId,
        row.id,
        row.org_id,
        threadId,
        projectId,
        now,
        workstationId,
        info.target.handle,
        info.target.kind,
        info.target.name,
        info.model.runtime,
        info.model.model,
        info.profile,
        info.native,
        caller.kind,
      ],
    );
    return [true, answer];
  });
}

async function cost(
  ctx: Ctx,
  workstationId: string,
  caller: Caller,
  params: Record<string, unknown>,
): Promise<Reply> {
  const p = DelegateCostParamsSchema.safeParse(params);
  if (!p.success) return [false, undefined, 'invalid delegate cost report'];
  // Idempotent: a retried report is booked once.
  const had = await one(ctx.pool, 'SELECT 1 FROM shift_costs WHERE shift_id=$1', [p.data.delegateId]);
  // Only a delegate this caller began on this workstation can be costed: the runner cannot book usage for an id of its own
  // choosing (another caller's delegate, one never begun) against the organization's spend and caps.
  const begun = await one(
    ctx.pool,
    'SELECT * FROM delegate_begins WHERE delegate_id=$1 AND caller_id=$2 AND workstation_id=$3',
    [p.data.delegateId, caller.row.id, workstationId],
  );
  if (had) {
    if (begun) await ctx.pool.query('DELETE FROM delegate_begins WHERE delegate_id=$1', [p.data.delegateId]);
    return [true, { recorded: false }];
  }
  if (!begun)
    return [false, undefined, 'unknown delegate: it was not begun by this caller on this workstation'];
  await ctx.store.append([
    {
      streamId: streamId.delegate(p.data.delegateId),
      event: {
        type: 'DelegateCompleted',
        payload: {
          delegateId: p.data.delegateId,
          callerKind: caller.kind,
          callerId: caller.row.id,
          ...(caller.kind === 'session_turn' ? { threadId: caller.row.thread_id } : {}),
          personaKey: p.data.target,
          usage: p.data.usage,
          outcome: p.data.outcome,
          ...(p.data.durationMs !== undefined ? { durationMs: p.data.durationMs } : {}),
          ...(begun?.target_kind ? { targetKind: begun.target_kind } : {}),
          ...(begun?.target_name ? { targetName: begun.target_name } : {}),
          ...((p.data.profile ?? begun?.profile) ? { profile: p.data.profile ?? begun?.profile } : {}),
          ...(p.data.summary ? { summary: p.data.summary } : {}),
          ...(p.data.native || begun?.native ? { native: true } : {}),
          ...(p.data.narrowedFrom ? { narrowedFrom: p.data.narrowedFrom } : {}),
        },
      },
      actor: runnerActor(workstationId),
      scope: orgScope(caller.row.org_id),
    },
  ]);
  await ctx.pool.query('DELETE FROM delegate_begins WHERE delegate_id=$1', [p.data.delegateId]);
  return [true, { recorded: true }];
}
