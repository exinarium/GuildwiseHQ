import { randomUUID } from 'node:crypto';
import {
  type ActionClass,
  CEO_DECISION_SUBKIND,
  type CeoActionName,
  type DeskActor,
  deskMode,
  reservedKeyOfDesk,
  streamId,
  WORKING_BRANCH_SUBKIND,
} from '@aom/shared';
import { z } from 'zod';
import { loadVisibleCard } from '../authz/scope.ts';
import { patchCard, releaseBackoff, releaseCard } from '../commands/cards.ts';
import { cardMessage, orgScope, projectScope, userActor } from '../commands/common.ts';
import { createDevOpsRequestIn, devopsAgentOn } from '../commands/devops.ts';
import { mergedAnswerNotes } from '../commands/escalation.ts';
import { runHygieneForConfirmedRepo, workingBranchAnsweredEvents } from '../commands/hygiene.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import type { ActionDef, ActionEnv, Prepared } from './types.ts';

export const itemScope = (item: Row) =>
  item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id);

export const truncate = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** How a message looks on a desk item or a thread: the CEO's own identity. */
export const ceoBy = (env: Pick<ActionEnv, 'agentId'>): DeskActor => ({
  kind: 'agent',
  agentId: env.agentId,
  role: 'ceo',
});

/** Appends in its own transaction; with `openItem` the desk item must still be open (row locked): nobody answered meanwhile. */
export async function appendLocked(env: ActionEnv, events: AppendInput[], openItem?: string): Promise<void> {
  await withAppendTx(env.ctx.pool, async (tx) => {
    if (openItem) {
      const cur = await one(tx, 'SELECT status FROM desk_items WHERE id=$1 FOR UPDATE', [openItem]);
      if (cur?.status !== 'open')
        throw conflict('already_closed', `this item is already ${cur?.status ?? 'gone'}`);
    }
    await env.ctx.store.append(events, { tx });
  });
}

export const refuse = (message: string): Prepared => ({
  subjectKind: '',
  subjectId: '',
  subjectLabel: '',
  refuse: message,
});

/** The desk item of this organization (held items included: the CEO triages those). */
export async function deskItem(tx: Queryable, orgId: string, id: string): Promise<Row | undefined> {
  return one(
    tx,
    `SELECT d.*, c.ref AS card_ref, c.owner_user_id AS card_owner, c.decision_policy AS card_policy,
            o.owner_user_id AS org_owner
       FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id JOIN organizations o ON o.id = d.org_id
      WHERE d.id=$1 AND d.org_id=$2`,
    [id, orgId],
  );
}

export async function cardOf(tx: Queryable, env: ActionEnv, ref: string) {
  try {
    return (await loadVisibleCard(tx, env.owner.id, ref)).card;
  } catch {
    return undefined;
  }
}

export async function agentByName(tx: Queryable, orgId: string, name: string): Promise<Row | undefined> {
  return one(tx, `SELECT * FROM agents WHERE org_id=$1 AND (lower(name)=lower($2) OR id::text=$2)`, [
    orgId,
    name,
  ]);
}

// ------------------------------------------------------------------------------------------------ answers

const AnswerP = z
  .object({
    item: z.uuid(),
    option: z.string().max(40).optional(),
    text: z.string().trim().max(20000).optional(),
  })
  .refine((p) => p.option || p.text, { message: 'give --option or --text' });

const answer: ActionDef<z.infer<typeof AnswerP>> = {
  cls: 'desk.answer_question',
  schema: AnswerP,
  describe: (p, pr) =>
    `Answer "${pr.subjectLabel}" with ${p.option ? `option ${p.option}` : `"${truncate(p.text ?? '', 80)}"`}`,
  async prepare(env, p) {
    const tx = env.ctx.pool;
    const item = await deskItem(tx, env.orgId, p.item);
    if (!item) return refuse('that desk item does not exist');
    const base = {
      subjectKind: 'desk',
      subjectId: item.id as string,
      subjectLabel: truncate(item.title, 120),
    };
    if (item.status !== 'open') return { ...base, refuse: `this item is already ${item.status}` };
    if (item.kind !== 'question' && item.kind !== 'escalation')
      return { ...base, refuse: 'approvals and alerts are resolved, not answered' };
    if (p.option && !(item.options as Array<{ id: string }>).some((o) => o.id === p.option))
      return { ...base, refuse: `option ${p.option} is not one of the item's options` };
    // A card owned by someone else than the organization Owner with "owner only": that person decides.
    const foreignOwner =
      item.card_policy === 'owner_only' && item.card_owner && item.card_owner !== item.org_owner;
    // Which branch a repository works on is routine: when the owner delegated it (the default) the CEO decides it from
    // the question alone, no cited ledger entry needed; every such decision shows on the desk for review.
    const branchDelegated =
      item.subkind === WORKING_BRANCH_SUBKIND && env.ceo.policy.delegated.includes('working_branch');
    const tableMode = deskMode(env.ceo.policy, item.kind, item.subkind);
    return {
      ...base,
      deskMode: foreignOwner
        ? 'recommend'
        : branchDelegated && tableMode === 'recommend'
          ? 'decide'
          : tableMode,
      reservedKey: reservedKeyOfDesk(item.kind, item.subkind),
      needsEvidence: !branchDelegated,
      data: { item },
    };
  },
  async execute(env, p, pr) {
    const item = pr.data?.item as Row;
    const tx = env.ctx.pool;
    const blocked = await rows<{ card_id: string }>(
      tx,
      `SELECT b.card_id FROM card_blockers b JOIN cards c ON c.id = b.card_id
        WHERE b.desk_item_id = $1 AND c.status = 'blocked'
          AND NOT EXISTS (SELECT 1 FROM card_blockers o WHERE o.card_id = b.card_id AND o.desk_item_id <> $1)`,
      [item.id],
    );
    const optionLabel = p.option
      ? (item.options as Array<{ id: string; label: string }>).find((o) => o.id === p.option)?.label
      : undefined;
    const text = (p.text?.trim() || optionLabel || p.option) as string;
    const entryId = randomUUID();
    const by = ceoBy(env);
    const events: AppendInput[] = [
      {
        streamId: streamId.desk(item.id),
        event: {
          type: 'QuestionAnswered',
          payload: {
            deskItemId: item.id,
            answer: text,
            ...(p.option ? { answerOption: p.option } : {}),
            answeredBy: by,
            ledgerEntryId: entryId,
            unblockedCardIds: blocked.map((b) => b.card_id),
          },
        },
        actor: userActor(env.owner.id),
        scope: itemScope(item),
      },
      {
        streamId: streamId.ledger(entryId),
        event: {
          type: 'LedgerEntryAdded',
          payload: {
            entryId,
            scope: 'feature',
            ...(item.project_id ? { projectId: item.project_id } : {}),
            ...(item.card_id ? { cardId: item.card_id } : {}),
            title: truncate(item.title, 120),
            body: `Question: ${String(item.title).trim()}\n\nAnswer (CEO decision, ${env.agentName}): ${text}`,
            tags: ['ceo-decision'],
            sourceDeskItemId: item.id,
          },
        },
        actor: userActor(env.owner.id),
        scope: itemScope(item),
      },
    ];
    const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
    if (card)
      events.push(
        cardMessage(card, { kind: 'agent', agentId: env.agentId }, 'answer', `CEO decision: ${text}`, {
          deskItemId: item.id,
          answeredBy: `${env.agentName} (ceo)`,
        }),
      );
    events.push(
      ...(await mergedAnswerNotes(
        tx as unknown as Tx, // reads only
        item,
        blocked.map((b) => b.card_id),
        { kind: 'agent', agentId: env.agentId },
        text,
        { answeredBy: `${env.agentName} (ceo)` },
      )),
    );
    // A working-branch answer also stores the branch on the repository, exactly as the owner's own answer would.
    if (item.subkind === WORKING_BRANCH_SUBKIND) {
      const hygieneRepo = await withAppendTx(env.ctx.pool, async (tx) => {
        const cur = await one(tx, 'SELECT status FROM desk_items WHERE id=$1 FOR UPDATE', [item.id]);
        if (cur?.status !== 'open')
          throw conflict('already_closed', `this item is already ${cur?.status ?? 'gone'}`);
        const b = await workingBranchAnsweredEvents(tx, item, env.owner, {
          answer: text,
          optionId: p.option,
        });
        await env.ctx.store.append([...events, ...b.events], { tx });
        return b.hygieneForRepo;
      });
      if (hygieneRepo) await runHygieneForConfirmedRepo(env.ctx, hygieneRepo);
    } else await appendLocked(env, events, item.id);
    env.ctx.services.dispatcher.trigger();
    return {
      message: `Answered. ${blocked.length ? `${blocked.length} card(s) go back to the queue. ` : ''}The owner can undo it.`,
      result: {
        itemId: item.id,
        unblocked: blocked.map((b) => b.card_id),
        ledgerEntryId: entryId,
        answer: text,
      },
      inverse: {
        kind: 'compensating',
        action: 'reopen-question',
        params: { item: item.id, unblocked: blocked.map((b) => b.card_id) },
        preconditions: { itemStatus: 'answered' },
        label: 'Re-open the question',
      },
    };
  },
};

// ------------------------------------------------------------------------------------- triage and notices

const TriageP = z.object({
  item: z.uuid(),
  do: z.enum(['dismiss', 'annotate', 'merge']),
  note: z.string().trim().max(4000).optional(),
  into: z.uuid().optional(),
});

const triage: ActionDef<z.infer<typeof TriageP>> = {
  cls: 'desk.triage',
  schema: TriageP,
  describe: (p, pr) => `${p.do} "${pr.subjectLabel}"`,
  async prepare(env, p) {
    const tx = env.ctx.pool;
    const item = await deskItem(tx, env.orgId, p.item);
    if (!item) return refuse('that desk item does not exist');
    const base = {
      subjectKind: 'desk',
      subjectId: item.id as string,
      subjectLabel: truncate(item.title, 120),
    };
    if (item.status !== 'open') return { ...base, refuse: `this item is already ${item.status}` };
    if (item.subkind === CEO_DECISION_SUBKIND)
      return { ...base, refuse: 'this is one of your own decisions: the owner reviews it' };
    if (p.do !== 'annotate' && (item.kind !== 'alert' || item.blocking || item.pinned))
      return { ...base, refuse: 'only plain alerts can be dismissed or merged; this one needs the owner' };
    if (p.do === 'merge') {
      if (item.triage !== 'pending') return { ...base, refuse: 'only held items can be merged' };
      const into = p.into ? await deskItem(tx, env.orgId, p.into) : undefined;
      if (!into || into.status !== 'open' || into.id === item.id)
        return { ...base, refuse: '"into" must be another open item' };
    }
    return {
      ...base,
      deskMode: deskMode(env.ceo.policy, item.kind, item.subkind),
      reservedKey: reservedKeyOfDesk(item.kind, item.subkind),
      data: { item },
    };
  },
  async execute(env, p, pr) {
    const item = pr.data?.item as Row;
    const by = ceoBy(env);
    const held = item.triage === 'pending';
    const events: AppendInput[] = [];
    if (held) {
      events.push({
        streamId: streamId.desk(item.id),
        event: {
          type: 'DeskItemTriaged',
          payload: {
            deskItemId: item.id,
            outcome: p.do === 'annotate' ? 'passed' : p.do === 'dismiss' ? 'dismissed' : 'merged',
            ...(p.note ? { note: p.note } : {}),
            ...(p.into ? { intoDeskItemId: p.into } : {}),
            by,
          },
        },
        actor: userActor(env.owner.id),
        scope: itemScope(item),
      });
    } else if (p.do === 'dismiss') {
      events.push({
        streamId: streamId.desk(item.id),
        event: {
          type: 'DeskItemResolved',
          payload: { deskItemId: item.id, resolution: 'dismissed', ...(p.note ? { note: p.note } : {}), by },
        },
        actor: userActor(env.owner.id),
        scope: itemScope(item),
      });
    } else {
      events.push({
        streamId: streamId.desk(item.id),
        event: {
          type: 'DeskItemAnnotated',
          payload: { deskItemId: item.id, note: p.note ?? 'Seen by the CEO.', by, relatedDeskItemIds: [] },
        },
        actor: userActor(env.owner.id),
        scope: itemScope(item),
      });
    }
    await appendLocked(env, events, item.id);
    return { message: `Done (${p.do}).`, result: { itemId: item.id, did: p.do } };
  },
};

const ResolveP = z.object({ item: z.uuid(), note: z.string().trim().max(2000).optional() });
const resolveNotice: ActionDef<z.infer<typeof ResolveP>> = {
  cls: 'desk.resolve_notice',
  schema: ResolveP,
  describe: (_p, pr) => `Acknowledge "${pr.subjectLabel}"`,
  async prepare(env, p) {
    const tx = env.ctx.pool;
    const item = await deskItem(tx, env.orgId, p.item);
    if (!item) return refuse('that desk item does not exist');
    const base = {
      subjectKind: 'desk',
      subjectId: item.id as string,
      subjectLabel: truncate(item.title, 120),
    };
    if (item.status !== 'open') return { ...base, refuse: `this item is already ${item.status}` };
    if (item.subkind === CEO_DECISION_SUBKIND)
      return { ...base, refuse: 'this is one of your own decisions: the owner reviews it' };
    if (item.kind !== 'alert' || item.blocking)
      return { ...base, refuse: 'only non-blocking alerts can be acknowledged' };
    return {
      ...base,
      deskMode: deskMode(env.ceo.policy, item.kind, item.subkind),
      reservedKey: reservedKeyOfDesk(item.kind, item.subkind),
      data: { item },
    };
  },
  async execute(env, p, pr) {
    const item = pr.data?.item as Row;
    await appendLocked(
      env,
      [
        {
          streamId: streamId.desk(item.id),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId: item.id,
              resolution: 'acknowledged',
              ...(p.note ? { note: p.note } : {}),
              by: ceoBy(env),
            },
          },
          actor: userActor(env.owner.id),
          scope: itemScope(item),
        },
      ],
      item.id,
    );
    return { message: 'Acknowledged.', result: { itemId: item.id } };
  },
};

// ---------------------------------------------------------------------------------------------- cards

const CardP = z.object({ card: z.string().min(1).max(40), note: z.string().trim().max(1000).optional() });

function cardPrepare(
  needs: (c: Row) => string | undefined,
): (env: ActionEnv, p: z.infer<typeof CardP>) => Promise<Prepared> {
  return async (env, p) => {
    const tx = env.ctx.pool;
    const card = await cardOf(tx, env, p.card);
    if (!card) return refuse(`card ${p.card} not found`);
    const base = {
      subjectKind: 'card',
      subjectId: card.id as string,
      subjectLabel: `${card.ref} ${truncate(card.title, 80)}`,
    };
    const why = needs(card);
    return why ? { ...base, refuse: why } : { ...base, data: { card } };
  };
}

const release: ActionDef<z.infer<typeof CardP>> = {
  cls: 'card.release',
  schema: CardP,
  describe: (_p, pr) => `Release the claim on ${pr.subjectLabel} (back to the queue)`,
  prepare: cardPrepare((c) => (c.claim_id ? undefined : 'the card is not claimed')),
  async execute(env, p, pr) {
    const card = pr.data?.card as Row;
    await releaseCard(env.ctx, env.owner, card.id, p.note ?? 'released by the CEO');
    return { message: `${card.ref} is back in the queue.`, result: { cardId: card.id } };
  },
};

const releaseBackoffAction: ActionDef<z.infer<typeof CardP>> = {
  cls: 'card.release_backoff',
  schema: CardP,
  describe: (_p, pr) => `End the back-off of ${pr.subjectLabel}`,
  prepare: cardPrepare((c) =>
    c.retry_after && c.retry_episode_id ? undefined : 'the card is not in back-off',
  ),
  async execute(env, p, pr) {
    const card = pr.data?.card as Row;
    await releaseBackoff(env.ctx, env.owner, card.id, p.note ?? 'released by the CEO');
    env.ctx.services.dispatcher.trigger();
    return { message: `${card.ref} can be dispatched again.`, result: { cardId: card.id } };
  },
};

const PriorityP = z.object({ card: z.string().min(1).max(40), to: z.coerce.number().int().min(1).max(9) });
const priority: ActionDef<z.infer<typeof PriorityP>> = {
  cls: 'card.reprioritise',
  schema: PriorityP,
  describe: (p, pr) => `Set the priority of ${pr.subjectLabel} to ${p.to}`,
  async prepare(env, p) {
    const tx = env.ctx.pool;
    const card = await cardOf(tx, env, p.card);
    if (!card) return refuse(`card ${p.card} not found`);
    const base = {
      subjectKind: 'card',
      subjectId: card.id as string,
      subjectLabel: `${card.ref} ${truncate(card.title, 80)}`,
    };
    if (['cancelled'].includes(card.status)) return { ...base, refuse: 'a cancelled card takes no priority' };
    if (card.priority === p.to) return { ...base, refuse: `the priority is already ${p.to}` };
    return { ...base, data: { card } };
  },
  async execute(env, p, pr) {
    const card = pr.data?.card as Row;
    await patchCard(env.ctx, env.owner, card.id, { priority: p.to });
    return {
      message: `${card.ref} priority ${card.priority} -> ${p.to}.`,
      result: { cardId: card.id, from: card.priority, to: p.to },
      inverse: {
        kind: 'inverse',
        action: 'priority',
        params: { card: card.id, to: card.priority },
        preconditions: { priority: p.to },
        label: `Set the priority back to ${card.priority}`,
      },
    };
  },
};

const MessageP = z.object({ card: z.string().min(1).max(40), text: z.string().trim().min(1).max(4000) });
const message: ActionDef<z.infer<typeof MessageP>> = {
  cls: 'message.agent',
  schema: MessageP,
  describe: (p, pr) => `Comment on ${pr.subjectLabel}: "${truncate(p.text, 80)}"`,
  async prepare(env, p) {
    const tx = env.ctx.pool;
    const card = await cardOf(tx, env, p.card);
    if (!card) return refuse(`card ${p.card} not found`);
    const sent = await one<{ n: string }>(
      tx,
      `SELECT count(*)::text AS n FROM ceo_actions WHERE org_id=$1 AND class='message.agent' AND status='done'
         AND subject_id=$2 AND created_at > $3`,
      [env.orgId, card.id, new Date(env.now.getTime() - 86_400_000)],
    );
    const cap = env.ceo.policy.limits.maxMessagesPerAgentPerDay;
    return {
      subjectKind: 'card',
      subjectId: card.id as string,
      subjectLabel: `${card.ref} ${truncate(card.title, 80)}`,
      limitReached: Number(sent?.n ?? 0) >= cap ? `${cap} messages per card per day` : undefined,
      data: { card },
    };
  },
  async execute(env, p, pr) {
    const card = pr.data?.card as Row;
    await appendLocked(env, [
      cardMessage(card, { kind: 'agent', agentId: env.agentId }, 'comment', p.text, { viaCeo: true }),
    ]);
    return { message: 'Posted on the card thread.', result: { cardId: card.id } };
  },
};

// ------------------------------------------------------------------------------------------------ shifts

const ShiftP = z.object({ shift: z.uuid(), keepCard: z.coerce.boolean().optional() });

function shiftPrepare(): (env: ActionEnv, p: z.infer<typeof ShiftP>) => Promise<Prepared> {
  return async (env, p) => {
    const s = await one(
      env.ctx.pool,
      `SELECT s.*, c.ref AS card_ref, a.name AS agent_name FROM shifts s LEFT JOIN cards c ON c.id = s.card_id
         JOIN agents a ON a.id = s.agent_id WHERE s.id=$1 AND s.org_id=$2`,
      [p.shift, env.orgId],
    );
    if (!s) return refuse('shift not found');
    const base = {
      subjectKind: 'shift',
      subjectId: s.id as string,
      subjectLabel: `${s.agent_name}${s.card_ref ? ` on ${s.card_ref}` : ` (${s.kind})`}`,
    };
    if (s.status === 'ended') return { ...base, refuse: 'the shift has already ended' };
    if (s.kind === 'ceo' || s.agent_id === env.agentId)
      return { ...base, refuse: 'the CEO does not stop its own shifts' };
    return { ...base, data: { shift: s } };
  };
}

const stopShift: ActionDef<z.infer<typeof ShiftP>> = {
  cls: 'shift.stop',
  schema: ShiftP,
  describe: (_p, pr) => `Stop the shift of ${pr.subjectLabel}`,
  prepare: shiftPrepare(),
  async execute(env, p, pr) {
    const s = pr.data?.shift as Row;
    const keep = p.keepCard === true && !!s.card_id;
    if (keep) await env.ctx.pool.query('UPDATE shifts SET stop_keep_card=true WHERE id=$1', [s.id]);
    const sent = env.ctx.services.gateway.stopShift(s.workstation_id, s.id, 'manager');
    return {
      message: sent ? 'Stop sent to the runner.' : 'The runner is not connected; the shift will be reaped.',
      result: { shiftId: s.id, sent },
    };
  },
};

const killTools: ActionDef<z.infer<typeof ShiftP>> = {
  cls: 'shift.stop',
  schema: ShiftP,
  describe: (_p, pr) => `Stop the running command of ${pr.subjectLabel}`,
  prepare: shiftPrepare(),
  async execute(env, _p, pr) {
    const s = pr.data?.shift as Row;
    const sent = env.ctx.services.gateway.killTools(s.workstation_id, s.id);
    return {
      message: sent ? 'Running commands killed; the shift goes on.' : 'The runner is not connected.',
      result: { shiftId: s.id, sent },
    };
  },
};

// ------------------------------------------------------------------------------------------------ agents

const AgentP = z.object({ agent: z.string().min(1).max(120), reason: z.string().max(500).optional() });

function agentPrepare(
  needs: (a: Row) => string | undefined,
): (env: ActionEnv, p: z.infer<typeof AgentP>) => Promise<Prepared> {
  return async (env, p) => {
    const a = await agentByName(env.ctx.pool, env.orgId, p.agent);
    if (!a) return refuse(`agent ${p.agent} not found`);
    const base = {
      subjectKind: 'agent',
      subjectId: a.id as string,
      subjectLabel: `${a.name} (${a.role_key})`,
      targetAgentId: a.id as string,
    };
    if (a.status !== 'active') return { ...base, refuse: `${a.name} is ${a.status}` };
    if (a.is_devops) return { ...base, refuse: 'the DevOps engineer is not managed this way' };
    if (a.role_key === 'ceo') return { ...base, refuse: 'the CEO does not manage itself' };
    const why = needs(a);
    return why ? { ...base, refuse: why } : { ...base, data: { agent: a } };
  };
}

const pauseAgent: ActionDef<z.infer<typeof AgentP>> = {
  cls: 'agent.pause',
  schema: AgentP,
  describe: (p, pr) => `Pause ${pr.subjectLabel}${p.reason ? ` (${p.reason})` : ''}`,
  prepare: agentPrepare((a) => (a.paused_at ? 'the agent is already paused' : undefined)),
  async execute(env, p, pr) {
    const a = pr.data?.agent as Row;
    await appendLocked(env, [
      {
        streamId: streamId.agent(a.id),
        event: {
          type: 'AgentPaused',
          payload: { agentId: a.id, by: env.owner.id, reason: p.reason ?? 'paused by the CEO', viaCeo: true },
        },
        actor: userActor(env.owner.id),
        scope: orgScope(a.org_id),
      },
    ]);
    return {
      message: `${a.name} is paused: no new work; a running shift finishes.`,
      result: { agentId: a.id },
      inverse: {
        kind: 'inverse',
        action: 'resume-agent',
        params: { agent: a.id },
        preconditions: { paused: true },
        label: `Resume ${a.name}`,
      },
    };
  },
};

const resumeAgent: ActionDef<z.infer<typeof AgentP>> = {
  cls: 'agent.resume',
  schema: AgentP,
  describe: (_p, pr) => `Resume ${pr.subjectLabel}`,
  prepare: agentPrepare((a) => (a.paused_at ? undefined : 'the agent is not paused')),
  async execute(env, _p, pr) {
    const a = pr.data?.agent as Row;
    await appendLocked(env, [
      {
        streamId: streamId.agent(a.id),
        event: { type: 'AgentResumed', payload: { agentId: a.id, by: env.owner.id, viaCeo: true } },
        actor: userActor(env.owner.id),
        scope: orgScope(a.org_id),
      },
    ]);
    env.ctx.services.dispatcher.trigger();
    return {
      message: `${a.name} takes work again.`,
      result: { agentId: a.id },
      inverse: {
        kind: 'inverse',
        action: 'pause-agent',
        params: { agent: a.id },
        preconditions: { paused: false },
        label: `Pause ${a.name} again`,
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------- devops

const DESTRUCTIVE =
  /\b(delete|drop|destroy|wipe|purge|truncate|rm -rf|force[- ]?push|reset --hard|production|prod\b|deploy|release|rollback|migrate|sudo|format)\b/i;

const DevopsP = z.object({
  workstation: z.string().min(1).max(120),
  text: z.string().trim().min(3).max(4000),
  card: z.string().max(40).optional(),
});
const devops: ActionDef<z.infer<typeof DevopsP>> = {
  cls: 'devops.request',
  schema: DevopsP,
  describe: (p, pr) => `Ask DevOps on ${pr.subjectLabel}: "${truncate(p.text, 100)}"`,
  async prepare(env, p) {
    const tx = env.ctx.pool;
    const ws = await one(
      tx,
      `SELECT w.id, w.name FROM workstations w WHERE w.status='active' AND (lower(w.name)=lower($2) OR w.id::text=$2)
         AND EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.org_id=$1 AND a.is_devops AND a.status='active')`,
      [env.orgId, p.workstation],
    );
    if (!ws)
      return refuse(`no workstation named ${p.workstation} with a DevOps engineer of this organization`);
    const card = p.card ? await cardOf(tx, env, p.card) : undefined;
    if (p.card && !card) return refuse(`card ${p.card} not found`);
    return {
      subjectKind: 'workstation',
      subjectId: ws.id as string,
      subjectLabel: ws.name as string,
      reservedKey: DESTRUCTIVE.test(p.text) ? 'devops_destructive' : null,
      data: { ws, card },
    };
  },
  async execute(env, p, pr) {
    const ws = pr.data?.ws as Row;
    const card = pr.data?.card as Row | undefined;
    const agent = await devopsAgentOn(env.ctx.pool, ws.id, env.orgId);
    if (!agent) throw conflict('no_devops_agent', 'this workstation has no DevOps engineer');
    const r = await withAppendTx(env.ctx.pool, (tx) =>
      createDevOpsRequestIn(env.ctx, tx, {
        workstationId: ws.id,
        orgId: env.orgId,
        summary: p.text,
        requestedBy: { kind: 'agent', id: env.agentId, name: env.agentName },
        ...(card ? { cardId: card.id } : {}),
      }),
    );
    env.ctx.services.dispatcher.trigger();
    return { message: 'Request sent to the DevOps engineer.', result: { requestId: r.requestId } };
  },
};

export const ACTIONS: Partial<Record<CeoActionName, ActionDef>> = {
  answer,
  triage,
  'resolve-notice': resolveNotice,
  release,
  'release-backoff': releaseBackoffAction,
  priority,
  'stop-shift': stopShift,
  'kill-tools': killTools,
  'pause-agent': pauseAgent,
  'resume-agent': resumeAgent,
  devops,
  message,
};

export const classOfAction = (name: string): ActionClass | undefined =>
  (ACTIONS as Record<string, ActionDef>)[name]?.cls;
void notFound;
