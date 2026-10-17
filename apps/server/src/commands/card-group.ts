import { GroupIdSchema, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';

type RpcResult = [boolean, unknown?, string?];

/** Roles that may group cards and write the Card Brief (code-v6: the planner and the architect; the BA when specifying). */
export const GROUP_ROLES = new Set(['planner', 'architect', 'ba']);

const CARD_BRIEF_MAX = 4000;

async function agentOf(ctx: Ctx, shift: Row): Promise<Row | undefined> {
  const a = await one(ctx.pool, 'SELECT id, name, role_key FROM agents WHERE id=$1', [shift.agent_id]);
  return a && GROUP_ROLES.has(a.role_key) ? a : undefined;
}

/**
 * `aom group set <id> [--card <REF>]` / `aom group clear [--card <REF>]` (code-v6): puts an open card of the shift's project
 * in a group, or takes it out. Cards of one group go to one builder (hard dispatch affinity), who works them in order in one
 * resumed session. Any open card of the project may be grouped, not only the shift's own card (the planner sees them all).
 */
export async function cardGroupRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  const agent = await agentOf(ctx, shift);
  if (!agent) return [false, undefined, 'only a planner, architect or BA groups cards'];
  const own = shift.card_id
    ? await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [shift.card_id])
    : undefined;
  if (!own) return [false, undefined, 'this shift has no card'];
  const ref =
    typeof params.card === 'string' && params.card.trim() ? params.card.trim().toUpperCase() : own.ref;
  const card =
    ref === own.ref
      ? own
      : await one(ctx.pool, 'SELECT * FROM cards WHERE project_id=$1 AND ref=$2', [own.project_id, ref]);
  if (!card) return [false, undefined, `no card ${ref} in this project`];
  if (card.status === 'done' || card.status === 'cancelled')
    return [false, undefined, `${card.ref} is ${card.status}: only open cards are grouped`];
  let groupId: string | null = null;
  if (params.clear !== true) {
    const parsed = GroupIdSchema.safeParse(params.id);
    if (!parsed.success)
      return [
        false,
        undefined,
        `a group id is 1 to 60 letters, digits, dots, dashes or underscores (aom group set <id>)`,
      ];
    groupId = parsed.data;
  }
  if ((card.group_id ?? null) === groupId)
    return [
      true,
      {
        changed: false,
        message: `${card.ref} is already ${groupId ? `in group ${groupId}` : 'in no group'}.`,
      },
    ];
  // A card that is being built keeps the builder it has: the group takes effect for the cards that are not claimed yet.
  return withAppendTx(ctx.pool, async (tx): Promise<RpcResult> => {
    const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [card.id])) as Row;
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: { type: 'CardGroupSet', payload: { cardId: card.id, groupId, agentId: agent.id } },
          actor: agentActor(agent.id),
          scope: projectScope(fresh.org_id, fresh.project_id),
        },
        cardMessage(
          fresh,
          { kind: 'agent', agentId: agent.id },
          'comment',
          groupId
            ? `${agent.name} put ${card.ref} in group ${groupId}: one builder works the whole group in order.`
            : `${agent.name} took ${card.ref} out of its group.`,
        ),
      ],
      { tx },
    );
    return [
      true,
      {
        changed: true,
        message: groupId ? `${card.ref} is in group ${groupId}.` : `${card.ref} is in no group now.`,
      },
    ];
  });
}

/** `aom brief --text "<brief>"` (code-v6): the Card Brief of the shift's own card, kept as written and given to the builder. */
export async function cardBriefRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  const agent = await agentOf(ctx, shift);
  if (!agent) return [false, undefined, 'only a planner, architect or BA writes the Card Brief'];
  const card = shift.card_id
    ? await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [shift.card_id])
    : undefined;
  if (!card) return [false, undefined, 'this shift has no card'];
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  if (!text)
    return [
      false,
      undefined,
      'the Card Brief is empty: aom brief --text "<what to build, the decisions that matter, the traps>"',
    ];
  if (text.length > CARD_BRIEF_MAX)
    return [
      false,
      undefined,
      `the Card Brief is ${text.length} characters: keep it under ${CARD_BRIEF_MAX} (it is a summary, the design report has the rest)`,
    ];
  await withAppendTx(ctx.pool, async (tx) => {
    const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [card.id])) as Row;
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: { type: 'CardBriefSet', payload: { cardId: card.id, brief: text, agentId: agent.id } },
          actor: agentActor(agent.id),
          scope: projectScope(fresh.org_id, fresh.project_id),
        },
      ],
      { tx },
    );
  });
  return [true, { message: `The Card Brief of ${card.ref} is recorded (${text.length} characters).` }];
}
