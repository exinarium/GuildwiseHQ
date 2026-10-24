import { randomUUID } from 'node:crypto';
import {
  isOrgManager,
  MENTION_LIMITS,
  type MentionableAgentDto,
  type MentionPolicy,
  type MentionResult,
  mentionedHandles,
  mentionHandles,
  mentionRefusalText,
  mentionTaskPrompt,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { notFound } from '../errors.ts';
import { manageableAgent } from './agents.ts';
import { cardMessage, orgScope, userActor } from './common.ts';

/**
 * @agent in card comments (S-B2, docs/ARCHITECTURE.md section 38.13). Who may mention which agent:
 * - Owners and Admins of the organization: any active hired agent that may work on the card's project;
 * - other project members: only agents whose manager enabled "Members may mention this agent" (`agent_mention_policy`), a
 *   grant that is off by default.
 * A mention is always a read-only task (a chat turn about the card); it never edits, runs commands or delegates.
 */

interface AgentRow extends Row {
  id: string;
  name: string;
}

/** The agents of the card's organization that can be asked at all: active, not DevOps or the CEO, allowed on the project. */
async function candidateAgents(db: Queryable, card: Row): Promise<AgentRow[]> {
  return rows<AgentRow>(
    db,
    `SELECT a.*, COALESCE(mp.allow_members, false) AS allow_members
       FROM agents a LEFT JOIN agent_mention_policy mp ON mp.agent_id = a.id
      WHERE a.org_id = $1 AND a.status = 'active' AND NOT a.is_devops AND a.role_key <> 'ceo'
        AND a.workstation_id IS NOT NULL
        AND (a.allowed_project_ids IS NULL OR $2::uuid = ANY (a.allowed_project_ids))
      ORDER BY a.hired_at, a.id`,
    [card.org_id, card.project_id],
  );
}

/** Handles are unique over all active agents of the organization, so a handle never changes with who is looking. */
async function handlesOfOrg(db: Queryable, orgId: string): Promise<Map<string, string>> {
  const all = await rows<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM agents WHERE org_id=$1 AND status='active' ORDER BY hired_at, id`,
    [orgId],
  );
  return mentionHandles(all);
}

const mayMention = (manager: boolean, a: Row): boolean => manager || a.allow_members === true;

/** The agents the viewer may mention on this card (for the comment box's autocomplete). */
export async function listMentionable(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
): Promise<MentionableAgentDto[]> {
  const { card } = await loadVisibleCard(ctx.pool, user.id, idOrRef);
  const manager = isOrgManager({ orgRole: await orgRoleOf(ctx.pool, user.id, card.org_id) });
  const handles = await handlesOfOrg(ctx.pool, card.org_id);
  return (await candidateAgents(ctx.pool, card))
    .filter((a) => mayMention(manager, a))
    .map((a) => ({ agentId: a.id, name: a.name, handle: handles.get(a.id) ?? a.name, roleKey: a.role_key }));
}

/** Counts of accepted mentions inside the window, for the three caps. */
async function usage(db: Queryable, userId: string, cardId: string, now: Date) {
  const since = new Date(now.getTime() - MENTION_LIMITS.windowMs);
  const r = await one<{ user_card: number; user_all: number; card_all: number }>(
    db,
    `SELECT count(*) FILTER (WHERE requested_by=$1 AND card_id=$2)::int AS user_card,
            count(*) FILTER (WHERE requested_by=$1)::int AS user_all,
            count(*) FILTER (WHERE card_id=$2)::int AS card_all
       FROM card_mentions WHERE created_at > $3 AND (requested_by=$1 OR card_id=$2)`,
    [userId, cardId, since],
  );
  return { userCard: r?.user_card ?? 0, userAll: r?.user_all ?? 0, cardAll: r?.card_all ?? 0 };
}

/**
 * Starts the mentions in a comment that was just posted. Never throws for a refused mention: each one is answered in the result
 * and, so the thread tells the same story, in a system comment. Unknown handles are left alone (they may be a person).
 */
export async function handleMentions(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  commentId: string,
  body: string,
): Promise<MentionResult[]> {
  const typed = mentionedHandles(body);
  if (typed.length === 0) return [];
  const { card } = await loadVisibleCard(ctx.pool, user.id, idOrRef);
  const handles = await handlesOfOrg(ctx.pool, card.org_id);
  const byHandle = new Map<string, string>([...handles].map(([id, h]) => [h, id]));
  const candidates = new Map((await candidateAgents(ctx.pool, card)).map((a) => [a.id, a]));
  const known = await rows<AgentRow>(
    ctx.pool,
    `SELECT a.*, COALESCE(mp.allow_members, false) AS allow_members FROM agents a
       LEFT JOIN agent_mention_policy mp ON mp.agent_id = a.id WHERE a.org_id=$1 AND a.status='active'`,
    [card.org_id],
  );
  const knownById = new Map(known.map((a) => [a.id, a]));
  const manager = isOrgManager({ orgRole: await orgRoleOf(ctx.pool, user.id, card.org_id) });
  const results: MentionResult[] = [];
  const notes: string[] = [];
  const refuse = (handle: string, name: string, reason: string) => {
    results.push({ handle, agentName: name, status: 'refused', reason });
    notes.push(mentionRefusalText(name, reason));
  };
  let started = 0;
  for (const handle of typed) {
    const id = byHandle.get(handle);
    const agent = id ? knownById.get(id) : undefined;
    if (!agent) continue;
    if (started >= MENTION_LIMITS.perComment) {
      refuse(handle, agent.name, `one comment starts at most ${MENTION_LIMITS.perComment} agents`);
      continue;
    }
    if (!candidates.has(agent.id)) {
      refuse(handle, agent.name, 'it is not available for this project');
      continue;
    }
    if (!mayMention(manager, agent)) {
      refuse(handle, agent.name, 'you may not mention this agent; ask its manager or an Admin');
      continue;
    }
    const u = await usage(ctx.pool, user.id, card.id, ctx.clock.now());
    if (
      u.userCard >= MENTION_LIMITS.perUserPerCard ||
      u.userAll >= MENTION_LIMITS.perUser ||
      u.cardAll >= MENTION_LIMITS.perCard
    ) {
      refuse(handle, agent.name, 'too many mentions this hour; try again later');
      continue;
    }
    const prompt = mentionTaskPrompt({
      agentName: agent.name,
      commenterName: user.displayName,
      cardRef: card.ref,
      cardTitle: card.title,
      comment: body,
    });
    const r = await ctx.services.chat.startMention({
      userId: user.id,
      card,
      agent,
      commentId,
      mentionId: randomUUID(),
      prompt,
    });
    if (r.ok) {
      started++;
      results.push({ handle, agentName: agent.name, status: 'started' });
    } else refuse(handle, agent.name, r.reason);
  }
  if (notes.length)
    await ctx.store.append(
      notes.map((n) => cardMessage(card, { kind: 'system' }, 'system', n, { replyTo: commentId })),
    );
  return results;
}

export async function getMentionPolicy(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
): Promise<MentionPolicy> {
  const a = await one(ctx.pool, 'SELECT org_id FROM agents WHERE id=$1', [agentId]);
  // an agent of another organization looks the same as one that does not exist
  if (!a || !(await orgRoleOf(ctx.pool, user.id, a.org_id))) throw notFound('agent not found');
  const r = await one(ctx.pool, 'SELECT allow_members FROM agent_mention_policy WHERE agent_id=$1', [
    agentId,
  ]);
  return { allowMembers: r?.allow_members === true };
}

/** Who manages the agent decides (the HR rule: Owner, Admin, the hiring manager). */
export async function setMentionPolicy(
  ctx: Ctx,
  user: AuthSession['user'],
  agentId: string,
  p: MentionPolicy,
): Promise<MentionPolicy> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await manageableAgent(tx, user, agentId);
    const cur = await one(tx, 'SELECT allow_members FROM agent_mention_policy WHERE agent_id=$1', [agentId]);
    if ((cur?.allow_members === true) === p.allowMembers && cur) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.agent(agentId),
          event: {
            type: 'AgentMentionPolicySet',
            payload: { agentId, orgId: a.org_id, allowMembers: p.allowMembers, changedBy: user.id },
          },
          actor: userActor(user.id),
          scope: orgScope(a.org_id),
        },
      ],
      { tx },
    );
  });
  return p;
}
