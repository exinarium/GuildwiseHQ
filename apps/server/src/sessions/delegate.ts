import {
  DELEGATE_LIMITS,
  DelegateBeginParamsSchema,
  DelegateCostParamsSchema,
  isKnownChoice,
  SESSION_PURPOSE_VERBS,
  streamId,
} from '@aom/shared';
import { orgScope, runnerActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { assertProjectMayRun, sessionCost } from './cost.ts';

/** `[ok, result, error]`, as every rpc handler of the gateway answers. */
type Reply = [boolean, unknown?, string?];

/** Shift kinds whose agents may delegate. The CEO's and the DevOps engineer's own turns never do (they hold wider powers). */
const SHIFT_KINDS = new Set(['card', 'question', 'ba_task', 'chat']);

type Caller = { kind: 'session_turn'; row: Row } | { kind: 'shift'; row: Row; project: string | null };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The server side of `aom delegate`. The runner runs the delegate; it asks here first (`delegate.begin`) and reports the
 * usage after (`delegate.cost`). `begin` is where a refusal belongs: the caller must be running, its purpose (session turn)
 * or kind (shift) must allow the verb, the session's budget and the project's budget must not be used up, and the model must
 * be a known choice. `cost` books the usage under the caller (`DelegateCompleted`); it is accepted even when the caller has
 * just ended, because the tokens were spent.
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
    if (method === 'delegate.begin') return await begin(ctx, caller, params);
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

async function begin(ctx: Ctx, caller: Caller, params: Record<string, unknown>): Promise<Reply> {
  const p = DelegateBeginParamsSchema.safeParse(params);
  if (!p.success) return [false, undefined, 'invalid delegate request'];
  if (!isKnownChoice(p.data.model)) return [false, undefined, `unknown model "${p.data.model.model}"`];
  if (p.data.taskChars > DELEGATE_LIMITS.maxTaskChars)
    return [false, undefined, `the task is longer than ${DELEGATE_LIMITS.maxTaskChars} characters`];
  const now = ctx.clock.now();
  if (caller.kind === 'session_turn') {
    const turn = caller.row;
    if (turn.status !== 'running') return [false, undefined, 'this turn is over'];
    const purpose = (turn.meta as { purpose?: string } | null)?.purpose;
    if (!purpose || !SESSION_PURPOSE_VERBS[purpose]?.includes('delegate'))
      return [false, undefined, '`aom delegate` is not available in this turn'];
    const t = await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1 AND deleted_at IS NULL', [
      turn.thread_id,
    ]);
    if (!t) return [false, undefined, 'the session no longer exists'];
    const c = await sessionCost(ctx.pool, t);
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
      return [false, undefined, '`aom delegate` is not available to this agent'];
    try {
      await assertProjectMayRun(ctx.pool, caller.project, now, 'shift');
    } catch (err) {
      return [false, undefined, message(err)];
    }
  }
  const used = await one(ctx.pool, 'SELECT count(*)::int AS n FROM shift_costs WHERE parent_id=$1', [
    caller.row.id,
  ]);
  if ((used?.n ?? 0) >= DELEGATE_LIMITS.maxPerCaller)
    return [
      false,
      undefined,
      `at most ${DELEGATE_LIMITS.maxPerCaller} delegates per ${caller.kind === 'shift' ? 'shift' : 'turn'}: work with what you have`,
    ];
  return [true, { delegateId: p.data.delegateId }];
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
  if (had) return [true, { recorded: false }];
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
          personaKey: p.data.persona,
          usage: p.data.usage,
          outcome: p.data.outcome,
          ...(p.data.durationMs !== undefined ? { durationMs: p.data.durationMs } : {}),
        },
      },
      actor: runnerActor(workstationId),
      scope: orgScope(caller.row.org_id),
    },
  ]);
  return [true, { recorded: true }];
}
