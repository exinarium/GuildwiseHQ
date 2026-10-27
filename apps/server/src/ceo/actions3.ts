import { type CeoActionName, ORDER_SUBJECT_HOURS, ORDER_TURNS_PER_DAY } from '@aom/shared';
import { z } from 'zod';
import { orgOwnerId } from '../auth/org-context.ts';
import { workstationFullPower } from '../chat/ceo-turns.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { refuse, truncate } from './actions.ts';
import { currentAuthority, orderVersionHash } from './orders.ts';
import type { ActionDef } from './types.ts';

// ------------------------------------------------------------------------------------------------ draft-cards

const DraftCardsP = z.object({
  project: z.string().min(2).max(10),
  cards: z
    .array(
      z.object({
        title: z.string().trim().min(3).max(300),
        text: z.string().trim().min(3).max(8000),
        cardType: z.enum(['feature', 'bug', 'support', 'refactor', 'docs']).default('feature'),
        ticket: z.string().trim().max(200).optional(),
        priority: z.coerce.number().int().min(1).max(9).optional(),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * `aom ceo act draft-cards --project KEY --file cards.json`: up to ten DRAFT cards (never specified). The owner, or the CEO
 * with `specify`, moves them on later; the BA writes the spec where text is missing.
 */
const draftCards: ActionDef<z.infer<typeof DraftCardsP>> = {
  cls: 'card.create_via_ba',
  schema: DraftCardsP,
  describe: (p) =>
    `Draft ${p.cards.length} card${p.cards.length === 1 ? '' : 's'} in ${p.project.toUpperCase()}: ${truncate(p.cards.map((c) => c.title).join('; '), 100)}`,
  async prepare(env, p) {
    const base = {
      subjectKind: 'project',
      subjectId: '',
      subjectLabel: `${p.project.toUpperCase()}: ${p.cards.length} drafts`,
    };
    const pr = await one(env.ctx.pool, 'SELECT id FROM projects WHERE org_id=$1 AND key=upper($2)', [
      env.orgId,
      p.project,
    ]);
    if (!pr) return { ...base, refuse: `project ${p.project.toUpperCase()} not found` };
    return { ...base, subjectId: pr.id as string, data: { pid: pr.id } };
  },
  async execute(env, p, pr) {
    const { createCardIn } = await import('../commands/cards.ts');
    const made = await withAppendTx(env.ctx.pool, async (tx) => {
      const out: Array<{ cardId: string }> = [];
      for (const c of p.cards) {
        const r = await createCardIn(env.ctx, tx, env.owner, {
          projectId: pr.data?.pid as string,
          title: c.title,
          cardType: c.cardType,
          fields: { context: c.text, ...(c.ticket ? { externalRef: c.ticket } : {}) },
          specify: false,
          ...(c.priority ? { priority: c.priority } : {}),
        } as never);
        out.push({ cardId: r.cardId });
      }
      return out;
    });
    const refs = await rows(env.ctx.pool, 'SELECT ref FROM cards WHERE id = ANY($1::uuid[]) ORDER BY ref', [
      made.map((m) => m.cardId),
    ]);
    return {
      message: `${made.length} draft card${made.length === 1 ? '' : 's'} created (${refs.map((r) => r.ref).join(', ')}): they are drafts; specify them when they are ready.`,
      result: { cardIds: made.map((m) => m.cardId), refs: refs.map((r) => r.ref) },
    };
  },
};

// ---------------------------------------------------------------------------------------------- invoke-order

const InvokeOrderP = z.object({
  entryId: z.uuid(),
  wake: z.uuid().optional(),
  why: z.string().max(2000).default(''),
});

/** The keys a wake can be matched by in an order's `scope.triggers`: its reason, and `reason:subkind` for desk items. */
export function wakeTriggerKeys(w: Row): string[] {
  const keys = [String(w.reason)];
  const sub = (w.detail as { subkind?: string } | null)?.subkind;
  if (sub) keys.push(`${w.reason}:${sub}`);
  return keys;
}

/** The project a wake is about, when it names one (a card, a desk item or a project). */
async function wakeProject(db: Queryable, w: Row): Promise<string | null> {
  const d = w.detail as { projectId?: string } | null;
  if (d?.projectId) return d.projectId;
  if (w.subject_kind === 'card')
    return (
      (await one(db, 'SELECT project_id FROM cards WHERE id::text=$1', [w.subject_id]))?.project_id ?? null
    );
  if (w.subject_kind === 'desk')
    return (
      (await one(db, 'SELECT project_id FROM desk_items WHERE id::text=$1', [w.subject_id]))?.project_id ??
      null
    );
  if (w.subject_kind === 'project') return w.subject_id;
  return null;
}

/**
 * `aom ceo order invoke`: a wake's CEO judged that an event falls under an Owner-authorized standing order; the server starts
 * a separate full-power `order` turn (docs section 3.4). Goes through the engine like every action: idempotency, policy
 * (an untrusted wake only recommends unless the order's trigger pre-filter matched, and a low confidence recommends), limits and audit.
 */
const invokeOrder: ActionDef<z.infer<typeof InvokeOrderP>> = {
  cls: 'order.invoke',
  schema: InvokeOrderP,
  describe: (_p, pr) => `Start a full-power turn for the standing order ${pr.subjectLabel}`,
  async prepare(env, p) {
    const entry = await one(
      env.ctx.pool,
      `SELECT id, title, body, org_id FROM ledger_entries WHERE id=$1 AND org_id=$2 AND scope='standing_order'`,
      [p.entryId, env.orgId],
    );
    if (!entry) return refuse('that standing order does not exist');
    const base = {
      subjectKind: 'order',
      subjectId: entry.id as string,
      subjectLabel: truncate(entry.title, 100),
    };
    if (!env.batchId) return { ...base, refuse: 'only a wake may start an order turn' };
    const auth = await currentAuthority(env.ctx.pool, entry.id);
    if (!auth)
      return {
        ...base,
        refuse:
          'this order does not carry full power (it was never marked by the Owner, its wording changed, it was revoked or retired): act in restricted mode and ask the owner',
      };
    if (auth.versionHash !== orderVersionHash(entry.title, entry.body))
      return { ...base, refuse: 'the order was edited since the Owner marked it' };
    const all = await rows(env.ctx.pool, 'SELECT * FROM ceo_wakes WHERE batch_id=$1', [env.batchId]);
    const candidates = p.wake ? all.filter((w) => w.id === p.wake) : all;
    if (p.wake && candidates.length === 0) return { ...base, refuse: 'that wake is not part of this shift' };
    const triggers = auth.scope.triggers ?? [];
    const matching: Row[] = [];
    for (const w of candidates) {
      if (triggers.length && !wakeTriggerKeys(w).some((k) => triggers.includes(k))) continue;
      if (auth.scope.projectIds?.length) {
        const proj = await wakeProject(env.ctx.pool, w);
        if (!proj || !auth.scope.projectIds.includes(proj)) continue;
      }
      matching.push(w);
    }
    if (matching.length === 0)
      return {
        ...base,
        refuse: `this event is outside the order's scope${triggers.length ? ` (it is limited to: ${triggers.join(', ')})` : ''}`,
      };
    const wake = matching[0] as Row;
    const subject = `${wake.subject_kind}:${wake.subject_id}`;
    // The audit and the per-subject limits are about the event the order is invoked for, not the order itself.
    const eventBase = {
      subjectKind: String(wake.subject_kind || 'order'),
      subjectId: String(wake.subject_id || entry.id),
      subjectLabel: truncate(`${entry.title} <- ${wake.subject_label || wake.reason}`, 140),
    };
    const day = await one<{ n: string }>(
      env.ctx.pool,
      `SELECT count(*)::text AS n FROM ceo_turns WHERE order_entry_id=$1 AND mode='order' AND queued_at > $2`,
      [entry.id, new Date(env.now.getTime() - 86_400_000)],
    );
    const recent = await one(
      env.ctx.pool,
      `SELECT 1 FROM ceo_turns WHERE order_entry_id=$1 AND mode='order' AND order_subject=$2 AND queued_at > $3 LIMIT 1`,
      [entry.id, subject, new Date(env.now.getTime() - ORDER_SUBJECT_HOURS * 3_600_000)],
    );
    const running = await one(
      env.ctx.pool,
      `SELECT 1 FROM ceo_turns WHERE order_entry_id=$1 AND mode='order' AND status IN ('queued','running') LIMIT 1`,
      [entry.id],
    );
    const limit = running
      ? 'an earlier turn of this order is still running'
      : Number(day?.n ?? 0) >= ORDER_TURNS_PER_DAY
        ? `${ORDER_TURNS_PER_DAY} turns of this order per day`
        : recent
          ? `one turn per subject every ${ORDER_SUBJECT_HOURS} hours`
          : undefined;
    // The machine must be the Owner's and have switched full power on: otherwise the turn could not run as authorized.
    const agent = await one(env.ctx.pool, 'SELECT workstation_id FROM agents WHERE id=$1', [env.agentId]);
    const ws = agent?.workstation_id
      ? await one(env.ctx.pool, 'SELECT id, name, user_id FROM workstations WHERE id=$1', [
          agent.workstation_id,
        ])
      : undefined;
    const owner = await orgOwnerId(env.ctx.pool, env.orgId);
    if (!ws || ws.user_id !== owner)
      return { ...base, refuse: "the CEO is not on the Owner's own workstation" };
    if (!env.ctx.services.runners.isOnline(ws.id))
      return { ...base, refuse: `${ws.name} is offline: an order turn does not wait; ask the owner` };
    if (!(await workstationFullPower(env.ctx.pool, ws.id)))
      return {
        ...base,
        refuse: `full power is off on ${ws.name} (\`guildwise-runner ceo full-power on\`): act in restricted mode and ask the owner`,
      };
    return {
      ...eventBase,
      limitReached: limit,
      trustedByScope: triggers.length > 0,
      data: { entry, auth, wake, workstationId: ws.id, wakes: matching },
    };
  },
  async execute(env, p, pr) {
    const { startOrderTurn } = await import('./order-turns.ts');
    const d = pr.data as {
      entry: Row;
      auth: { versionHash: string; covers: string[] };
      wake: Row;
      wakes: Row[];
    };
    const started = await startOrderTurn(env.ctx, {
      orgId: env.orgId,
      entry: d.entry,
      versionHash: d.auth.versionHash,
      wake: d.wake,
      wakes: d.wakes,
      why: p.why,
    });
    return {
      message: started
        ? "The order turn started on the owner's workstation: it runs separately with full power and reports in the daily report. Finish your own wake now."
        : 'The order turn could not start (the workstation went away). Ask the owner.',
      result: { turnId: started, entryId: p.entryId },
    };
  },
};

export const ACTIONS3: Partial<Record<CeoActionName, ActionDef>> = {
  'draft-cards': draftCards,
  'invoke-order': invokeOrder,
};
