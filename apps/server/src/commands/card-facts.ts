import { branchName, DEFAULT_STOP_LOSS, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { dependencyStates } from '../dispatcher/dependencies.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';
import { dependencyCycle } from './intake.ts';
import { cardSize, cardUsage, stopLossBudget } from './stop-loss.ts';

type RpcResult = [boolean, unknown?, string?];

/** The card a facts or depend request names: `params.ref` in the shift's project, else the shift's own card. */
async function targetCard(
  ctx: Ctx,
  shift: Row,
  ref: unknown,
  scopeProjectId?: string,
): Promise<Row | undefined> {
  const own = shift.card_id
    ? await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [shift.card_id])
    : undefined;
  const wanted = typeof ref === 'string' ? ref.trim().toUpperCase() : '';
  if (!wanted || wanted === own?.ref) return own;
  const projectId = scopeProjectId ?? own?.project_id;
  if (!projectId) return undefined;
  return one(ctx.pool, 'SELECT * FROM cards WHERE project_id=$1 AND ref=$2', [projectId, wanted]);
}

/**
 * `aom card facts [<ref>]` (Lean Team v3, design 6.3): what the server knows about a card, so an agent does not spend a
 * question on it: the environment, whether each dependency has merged ("landed"), the branch, the stage and what blocks
 * the card. Another card of the same project can be named (a dependency, for example).
 */
export async function cardFactsRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  const card = await targetCard(ctx, shift, params.ref);
  if (!card) return [false, undefined, `no such card in this project: ${String(params.ref ?? '')}`];
  const project = (await one(ctx.pool, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
  const repo = card.repo_id
    ? await one(ctx.pool, 'SELECT working_branch FROM project_repos WHERE id=$1', [card.repo_id])
    : undefined;
  const wcard = card.worktree_card_id
    ? ((await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [card.worktree_card_id])) ?? card)
    : card;
  const workstationId = (shift.workstation_id as string | null) ?? card.home_workstation_id;
  const env = workstationId
    ? await one(
        ctx.pool,
        'SELECT state, summary FROM project_environments WHERE project_id=$1 AND workstation_id=$2',
        [card.project_id, workstationId],
      )
    : undefined;
  const test = await one(
    ctx.pool,
    `SELECT state, healthy_at, sources FROM run_environments
      WHERE card_id=$1 AND purpose='test' AND verdict_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [card.id],
  );
  const deps = await dependencyStates(ctx.pool, card.id);
  const dependents = await rows(
    ctx.pool,
    `SELECT c.ref, c.title, c.status, c.stage FROM card_dependencies d JOIN cards c ON c.id = d.card_id
      WHERE d.depends_on_card_id=$1 AND c.status NOT IN ('done','cancelled') ORDER BY c.number`,
    [card.id],
  );
  const blockers = await rows(
    ctx.pool,
    `SELECT d.id, d.kind, d.subkind, d.title, d.status, d.keep_blocked_until FROM card_blockers b
       JOIN desk_items d ON d.id = b.desk_item_id WHERE b.card_id=$1 AND (d.status='open' OR d.keep_blocked_until IS NOT NULL)
      ORDER BY d.created_at`,
    [card.id],
  );
  const parked = card.parked_request_id
    ? await one(ctx.pool, 'SELECT status, summary FROM devops_requests WHERE id=$1', [card.parked_request_id])
    : undefined;
  const usage = await cardUsage(ctx.pool, card.id);
  const budget = await stopLossBudget(ctx.pool, card);
  const unlanded = deps.filter((d) => !d.landed).map((d) => d.ref);
  return [
    true,
    {
      ref: card.ref,
      title: card.title,
      project: project.key,
      stage: card.stage,
      status: card.status,
      branch: {
        name: wcard.branch_name ?? branchName(project.branch_prefix, wcard.ref, wcard.title),
        base: repo?.working_branch ?? project.working_branch,
      },
      environment: {
        project: env
          ? { state: env.state, ...(env.summary ? { summary: env.summary } : {}) }
          : { state: 'unknown' },
        test: test
          ? {
              state: test.state,
              healthy: test.state === 'healthy',
              ...(test.healthy_at ? { healthySince: test.healthy_at } : {}),
            }
          : null,
        ...(parked ? { devopsRequest: { status: parked.status, summary: parked.summary } } : {}),
      },
      dependencies: deps.map((d) => ({
        ref: d.ref,
        title: d.title,
        status: d.status,
        stage: d.stage,
        merged: d.landed,
        ...(d.landedEarly ? { note: 'merged; the card itself is not done yet' } : {}),
      })),
      allDependenciesMerged: unlanded.length === 0,
      ...(unlanded.length
        ? { waitingFor: `${unlanded.join(', ')} to merge: only the design may run until then` }
        : {}),
      dependents: dependents.map((d) => ({ ref: d.ref, title: d.title, status: d.status, stage: d.stage })),
      blockers: blockers.map((b) => ({
        kind: b.kind,
        ...(b.subkind ? { subkind: b.subkind } : {}),
        title: b.title,
        status: b.status,
        ...(b.keep_blocked_until ? { keepBlockedUntil: b.keep_blocked_until } : {}),
      })),
      budget: {
        size: cardSize(card),
        used: usage,
        limit: budget,
        defaults: DEFAULT_STOP_LOSS[cardSize(card)],
      },
    },
  ];
}

/** Roles that may record a dependency between cards. */
export const DEPEND_ROLES = new Set(['architect', 'planner', 'ba']);

/**
 * `aom block --on dependency <ref>` (Lean Team v3, design 5.2): record that the card waits for another card of its
 * project. Add only, allowed on any open card (not only a queued, unclaimed one), cycle-checked, same project. Emits
 * `CardUpdated{dependencies}` with the old set plus the new card: the heavy-edit rules belong to the edit commands
 * (`editRefusal`), not to the event, so an agent's add-only change does not need the card to be queued.
 */
export async function cardDependRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  const agent = await one(ctx.pool, 'SELECT id, name, role_key FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent || !DEPEND_ROLES.has(agent.role_key))
    return [false, undefined, 'only an architect, planner or BA records dependencies'];
  const on = typeof params.on === 'string' ? params.on.trim().toUpperCase() : '';
  if (!on) return [false, undefined, 'name the card this one depends on: aom block --on dependency <ref>'];
  const own = shift.card_id
    ? await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [shift.card_id])
    : undefined;
  const card = await targetCard(ctx, shift, params.card);
  if (!card || !own || card.project_id !== own.project_id)
    return [false, undefined, "the card to change must be a card of this shift's project"];
  const dep = await one(ctx.pool, 'SELECT * FROM cards WHERE project_id=$1 AND ref=$2', [own.project_id, on]);
  if (!dep) return [false, undefined, `no card ${on} in this project`];
  if (dep.id === card.id) return [false, undefined, 'a card cannot depend on itself'];
  if (card.status === 'done' || card.status === 'cancelled')
    return [false, undefined, `${card.ref} is ${card.status}: dependencies are recorded on open cards`];
  try {
    return await withAppendTx(ctx.pool, async (tx): Promise<RpcResult> => {
      const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [card.id])) as Row;
      const existing = (
        await rows<{ depends_on_card_id: string }>(
          tx,
          'SELECT depends_on_card_id FROM card_dependencies WHERE card_id=$1',
          [card.id],
        )
      ).map((r) => r.depends_on_card_id);
      if (existing.includes(dep.id))
        return [true, { added: false, message: `${card.ref} already depends on ${dep.ref}.` }];
      await ctx.store.append(
        [
          {
            streamId: streamId.card(card.id),
            event: {
              type: 'CardUpdated',
              payload: { cardId: card.id, changes: { dependencies: [...existing, dep.id] } },
            },
            actor: agentActor(agent.id),
            scope: projectScope(fresh.org_id, fresh.project_id),
          },
          cardMessage(
            fresh,
            { kind: 'agent', agentId: agent.id },
            'comment',
            `${agent.name} recorded that ${card.ref} depends on ${dep.ref} (${dep.title}). Only its design may run until ${dep.ref} has merged.`,
          ),
        ],
        { tx },
      );
      const cycle = await dependencyCycle(tx, card.id);
      if (cycle) throw new DependencyCycleError(`${card.ref} -> ${dep.ref}`);
      return [
        true,
        {
          added: true,
          message: `${card.ref} now depends on ${dep.ref}${dep.status === 'done' || dep.merged_into_working_at ? ' (already merged)' : '; only design may run until it has merged'}.`,
        },
      ];
    });
  } catch (err) {
    if (err instanceof DependencyCycleError)
      return [false, undefined, `that would make a dependency cycle (${err.message}); nothing was recorded`];
    throw err;
  }
}

class DependencyCycleError extends Error {}
