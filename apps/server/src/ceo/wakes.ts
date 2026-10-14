import { ROUTING_EXEMPT_SUBKINDS } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { ceoActive } from './state.ts';

export type WakeUrgency = 'urgent' | 'normal' | 'scheduled';

export interface NewWake {
  reason: string;
  urgency: WakeUrgency;
  subjectKind?: string;
  subjectId?: string;
  subjectLabel?: string;
  detail?: Record<string, unknown>;
  eventSeq?: bigint | undefined;
  untrusted?: boolean;
  localDate?: string | undefined;
}

/** The same subject and reason coalesce while pending; a subject the CEO just acted on is not woken again (loop guard). */
const RECENT_ACTION_MS = 30 * 60_000;

/** Subkinds the CEO produces or that need no wake (its own output, phase items, reports). */
const NO_WAKE_SUBKINDS = new Set([...ROUTING_EXEMPT_SUBKINDS, 'ceo_recommendation', 'ceo_notice', 'ceo_report']);

export async function enqueueWake(db: Queryable, orgId: string, w: NewWake, now: Date): Promise<boolean> {
  const subjectKind = w.subjectKind ?? '';
  const subjectId = w.subjectId ?? '';
  if (subjectId) {
    const pending = await one(
      db,
      `SELECT id, urgency FROM ceo_wakes WHERE org_id=$1 AND status='pending' AND reason=$2 AND subject_kind=$3 AND subject_id=$4`,
      [orgId, w.reason, subjectKind, subjectId],
    );
    if (pending) {
      if (w.urgency === 'urgent' && pending.urgency !== 'urgent')
        await exec(db, `UPDATE ceo_wakes SET urgency='urgent' WHERE id=$1`, [pending.id]);
      return false;
    }
    if (w.urgency !== 'urgent') {
      const recent = await one(
        db,
        `SELECT 1 FROM ceo_actions WHERE org_id=$1 AND subject_kind=$2 AND subject_id=$3 AND created_at > $4 AND mode IN ('decided','recommended')`,
        [orgId, subjectKind, subjectId, new Date(now.getTime() - RECENT_ACTION_MS)],
      );
      if (recent) return false;
    }
  }
  await exec(
    db,
    `INSERT INTO ceo_wakes (org_id, reason, urgency, subject_kind, subject_id, subject_label, detail, event_seq, untrusted, local_date, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      orgId,
      w.reason,
      w.urgency,
      subjectKind,
      subjectId,
      (w.subjectLabel ?? '').slice(0, 300),
      JSON.stringify(w.detail ?? {}),
      w.eventSeq?.toString() ?? null,
      w.untrusted === true,
      w.localDate ?? null,
      now,
    ],
  );
  return true;
}

/** Wake sources (docs/design/ceo-agent-v2.md section 5.1): committed events become wakes for an active CEO. */
export function registerCeoWakes(ctx: Ctx): () => void {
  const cache = new Map<string, { at: number; active: boolean; agentId: string | null; urgentSignals: string[] }>();
  const ceoOf = async (orgId: string) => {
    const hit = cache.get(orgId);
    const now = Date.now();
    if (hit && now - hit.at < 3000) return hit;
    const c = await ceoActive(ctx.pool, orgId);
    const v = { at: now, active: !!c, agentId: c?.agentId ?? null, urgentSignals: c?.settings.urgentSignals ?? [] };
    cache.set(orgId, v);
    return v;
  };

  const handle = async (e: StoredEvent): Promise<void> => {
    const type = e.event.type;
    if (type === 'CeoEnabled' || type === 'CeoDisabled' || type === 'CeoPaused' || type === 'CeoResumed') cache.clear();
    const orgId = e.scope.orgId;
    if (!orgId) return;
    const interesting =
      type === 'DeskItemCreated' ||
      type === 'QuestionRaised' ||
      type === 'QuestionEscalated' ||
      type === 'BaSignalRaised' ||
      type === 'BaSignalUpdated' ||
      type === 'ShiftEnded' ||
      type === 'ProjectBudgetThresholdReached' ||
      type === 'CardFinalized' ||
      type === 'CardCancelled' ||
      type === 'DevOpsRequestCompleted' ||
      type === 'QuestionAnswered';
    if (!interesting) return;
    const ceo = await ceoOf(orgId);
    if (!ceo.active) return;
    // What the CEO itself caused does not wake it.
    if (e.actor.kind === 'agent' && e.actor.id === ceo.agentId) return;
    if (e.causationId && (await one(ctx.pool, 'SELECT 1 FROM ceo_actions WHERE id=$1', [e.causationId]))) return;
    const now = ctx.clock.now();
    const ev = e.event as any;
    const p = ev.payload;
    switch (type) {
      case 'DeskItemCreated': {
        const sub = p.subkind ?? '';
        if (NO_WAKE_SUBKINDS.has(sub) || p.kind === 'rating') return;
        if (p.askedBy?.agentId === ceo.agentId) return;
        const auth = sub === 'claude_auth_expired' || sub === 'mcp_needs_sign_in';
        await enqueueWake(
          ctx.pool,
          orgId,
          {
            reason: auth ? `sign_in:${sub}` : 'desk_item',
            urgency: auth || p.blocking || p.pinned || p.kind !== 'alert' ? 'urgent' : 'normal',
            subjectKind: 'desk',
            subjectId: p.deskItemId,
            subjectLabel: p.title,
            detail: { kind: p.kind, subkind: sub },
            eventSeq: e.seq,
            untrusted: p.askedBy?.kind === 'agent',
          },
          now,
        );
        break;
      }
      case 'QuestionRaised':
      case 'QuestionEscalated': {
        if (p.routedTo !== 'manager') return;
        const item = await one(ctx.pool, 'SELECT title, blocking, pinned, subkind FROM desk_items WHERE id=$1', [p.deskItemId]);
        await enqueueWake(
          ctx.pool,
          orgId,
          {
            reason: 'question',
            urgency: item?.blocking || item?.pinned || p.blocking ? 'urgent' : 'normal',
            subjectKind: 'desk',
            subjectId: p.deskItemId,
            subjectLabel: item?.title ?? p.question ?? '',
            detail: { kind: 'question', subkind: item?.subkind ?? p.subkind ?? '' },
            eventSeq: e.seq,
            untrusted: true,
          },
          now,
        );
        break;
      }
      case 'BaSignalRaised':
      case 'BaSignalUpdated': {
        const urgent = p.urgency === 'urgent' || (type === 'BaSignalRaised' && ceo.urgentSignals.includes(p.kind));
        if (type === 'BaSignalUpdated' && p.urgency !== 'urgent') return;
        await enqueueWake(
          ctx.pool,
          orgId,
          {
            reason: `signal:${p.kind ?? 'update'}`,
            urgency: urgent ? 'urgent' : 'normal',
            subjectKind: 'signal',
            subjectId: p.signalId,
            subjectLabel: p.subject?.title ?? '',
            detail: { kind: p.kind ?? null },
            eventSeq: e.seq,
          },
          now,
        );
        break;
      }
      case 'ShiftEnded': {
        if (p.outcome !== 'timeout' && p.outcome !== 'crashed') return;
        const a = await one(ctx.pool, 'SELECT name, role_key FROM agents WHERE id=$1', [p.agentId]);
        if (!a || a.role_key === 'ceo') return;
        if (p.outcome === 'crashed') {
          const n = await one<{ n: string }>(
            ctx.pool,
            `SELECT count(*)::text AS n FROM shifts WHERE agent_id=$1 AND outcome='crashed' AND ended_at > $2`,
            [p.agentId, new Date(now.getTime() - 3_600_000)],
          );
          if (Number(n?.n ?? 0) < 2) return;
        }
        await enqueueWake(
          ctx.pool,
          orgId,
          { reason: `shift_${p.outcome}`, urgency: 'normal', subjectKind: 'agent', subjectId: p.agentId, subjectLabel: a.name, eventSeq: e.seq },
          now,
        );
        break;
      }
      case 'ProjectBudgetThresholdReached':
        await enqueueWake(
          ctx.pool,
          orgId,
          {
            reason: `budget_${p.level}`,
            urgency: p.level === 'paused' ? 'urgent' : 'normal',
            subjectKind: 'project',
            subjectId: p.projectId,
            detail: { month: p.month },
            eventSeq: e.seq,
          },
          now,
        );
        break;
      case 'QuestionAnswered':
      case 'CardFinalized':
      case 'CardCancelled':
      case 'DevOpsRequestCompleted': {
        // Follow-up: something a CEO task watches changed.
        const id: string | undefined = p.cardId ?? p.requestId ?? p.deskItemId;
        if (!id) return;
        const t = await one(
          ctx.pool,
          `SELECT id, title FROM ceo_tasks WHERE org_id=$1 AND status IN ('open','in_progress','waiting_work','waiting_owner')
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(watch) w WHERE w->>'id' = $2) LIMIT 1`,
          [orgId, id],
        );
        if (t)
          await enqueueWake(
            ctx.pool,
            orgId,
            { reason: 'task_follow_up', urgency: 'normal', subjectKind: 'task', subjectId: t.id, subjectLabel: t.title, detail: { changed: type }, eventSeq: e.seq },
            now,
          );
        break;
      }
    }
  };

  return ctx.store.subscribe((e) => {
    handle(e).catch((err) => ctx.log.error({ err, type: e.event.type }, 'ceo wake source failed'));
  });
}
