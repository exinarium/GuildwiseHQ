import {
  type ActionClass,
  CLASS_LABEL,
  type CeoActionDto,
  type CeoActionsQuery,
  type CeoStatusDto,
  agreementScores,
  sumScores,
  trainingDaysLeft,
} from '@aom/shared';
import { ceoReachable, loadCeo } from '../ceo/state.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { CEO_CAPABILITY } from '../ceo/state.ts';

export function toActionDto(r: Row): CeoActionDto {
  const inv = r.inverse as { kind: 'inverse' | 'compensating'; label?: string } | null;
  const undone = r.status === 'undone';
  return {
    id: r.id,
    at: iso(r.created_at) as string,
    class: r.class,
    classLabel: CLASS_LABEL[r.class as ActionClass] ?? r.class,
    action: r.action,
    mode: r.mode,
    status: r.status,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    subjectLabel: r.subject_label,
    reason: r.reason,
    confidence: r.confidence,
    evidence: r.evidence ?? [],
    policyVersion: r.policy_version,
    verdictReason: r.verdict_reason,
    cause: r.cause ?? null,
    untrusted: !!r.untrusted,
    undo: {
      available: r.status === 'done' && !!inv,
      kind: inv?.kind ?? null,
      label: r.status === 'done' ? (inv?.label ?? null) : null,
      reason:
        undone
          ? 'already undone'
          : r.mode === 'recommended'
            ? 'a recommendation: nothing was done'
            : r.mode === 'refused'
              ? 'refused: nothing was done'
              : inv
                ? null
                : 'not reversible: the work continues',
    },
    deskItemId: r.desk_item_id ?? null,
    response: r.response ?? null,
    responseNote: r.response_note ?? null,
    responseChoice: r.response_choice ?? null,
    undoneAt: iso(r.undone_at),
    acceptedFrom: r.accepted_from ?? null,
  };
}

export async function listActions(
  db: Queryable,
  orgId: string,
  q: CeoActionsQuery,
): Promise<{ actions: CeoActionDto[]; next: string | null }> {
  const list = await rows(
    db,
    `SELECT * FROM ceo_actions WHERE org_id=$1
        AND ($2::text IS NULL OR class=$2) AND ($3::text IS NULL OR mode=$3)
        AND ($4::text IS NULL OR subject_id=$4 OR subject_label ILIKE '%' || $4 || '%')
        AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at <= $6)
        AND ($7::timestamptz IS NULL OR created_at < $7)
      ORDER BY created_at DESC, event_seq DESC LIMIT $8`,
    [orgId, q.class ?? null, q.mode ?? null, q.subject ?? null, q.from ?? null, q.to ?? null, q.before ?? null, q.limit + 1],
  );
  const more = list.length > q.limit;
  const page = list.slice(0, q.limit);
  return { actions: page.map(toActionDto), next: more ? (iso(page[page.length - 1]?.created_at) ?? null) : null };
}

export function actionsCsv(list: CeoActionDto[]): string {
  const f = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [
    'time,class,action,mode,status,subject,reason,confidence,policy_version,verdict',
    ...list.map((a) =>
      [a.at, a.classLabel, a.action, a.mode, a.status, f(a.subjectLabel), f(a.reason), a.confidence, a.policyVersion, f(a.verdictReason)].join(','),
    ),
  ].join('\n');
}

/** Everything the CEO page's Overview needs. */
export async function ceoStatus(ctx: Ctx, orgId: string, viewerRole: 'owner' | 'admin' | 'member'): Promise<CeoStatusDto> {
  const now = ctx.clock.now();
  const ceo = await loadCeo(ctx.pool, orgId);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(now.getTime() - 86_400_000);
  const spend = await one(
    ctx.pool,
    `SELECT COALESCE(sum(cost_usd_micros) FILTER (WHERE kind IN ('ceo','ceo_chat') AND ended_at >= $2),0) AS day,
            COALESCE(sum(cost_usd_micros) FILTER (WHERE kind IN ('ceo','ceo_chat')),0) AS month,
            COALESCE(sum(cost_usd_micros),0) AS org_month
       FROM shift_costs WHERE org_id=$1 AND ended_at >= $3`,
    [orgId, dayStart, monthStart],
  );
  const cur = await one(ctx.pool, 'SELECT currency FROM organizations WHERE id=$1', [orgId]);
  const emptyTraining = { on: false, startedAt: null, until: null, graduatedAt: null, extensions: 0, daysLeft: 0 };
  const base = {
    isOwner: viewerRole === 'owner',
    canPause: viewerRole === 'owner' || viewerRole === 'admin',
    spend: {
      currency: cur?.currency ?? 'USD',
      todayMicros: Number(spend?.day ?? 0),
      monthMicros: Number(spend?.month ?? 0),
      orgMonthMicros: Number(spend?.org_month ?? 0),
    },
  };
  const ws = await rows(
    ctx.pool,
    `SELECT w.id, w.name, (w.connected AND w.last_seen_at > $2) AS online,
            COALESCE((SELECT $3 = ANY(c.capabilities) FROM workstation_capabilities c WHERE c.workstation_id = w.id), false) AS capable
       FROM workstations w WHERE w.status='active' AND (w.user_id = (SELECT owner_user_id FROM organizations WHERE id=$1) OR w.simulation_org_id = $1)
      ORDER BY w.name`,
    [orgId, new Date(now.getTime() - 45_000), CEO_CAPABILITY],
  );
  if (!ceo)
    return {
      hired: false,
      state: 'none',
      offlineReason: null,
      agent: null,
      training: emptyTraining,
      scores: [],
      totals: { agreed: 0, total: 0 },
      pendingWakes: 0,
      running: null,
      openTasks: 0,
      lastReportAt: null,
      policyVersion: 0,
      undone7d: { undone: 0, decided: 0 },
      workstations: ws.map((w) => ({ id: w.id, name: w.name, online: !!w.online, capable: !!w.capable, current: false })),
      ...base,
    };
  const agent = ceo.agentId
    ? await one(
        ctx.pool,
        `SELECT a.id, a.name, a.avatar_seed, a.avatar_style, a.model, a.runtime, a.workstation_id, w.name AS ws_name
           FROM agents a LEFT JOIN workstations w ON w.id = a.workstation_id WHERE a.id=$1`,
        [ceo.agentId],
      )
    : undefined;
  const reach = ceo.enabled ? await ceoReachable(ctx.pool, orgId, now) : { ok: false };
  const scores = agreementScores(
    await rows<{ class: string; response: any }>(ctx.pool, `SELECT class, response FROM ceo_actions WHERE org_id=$1 AND mode='recommended' AND response IS NOT NULL`, [orgId]),
  );
  const pending = await one<{ n: string }>(ctx.pool, `SELECT count(*)::text AS n FROM ceo_wakes WHERE org_id=$1 AND status IN ('pending','taken')`, [orgId]);
  const running = await one(ctx.pool, `SELECT started_at, b.purpose FROM shifts s JOIN ceo_batches b ON b.shift_id = s.id WHERE s.org_id=$1 AND s.kind='ceo' AND s.status <> 'ended' LIMIT 1`, [orgId]);
  const tasks = await one<{ n: string }>(ctx.pool, `SELECT count(*)::text AS n FROM ceo_tasks WHERE org_id=$1 AND status IN ('open','in_progress','waiting_owner','waiting_work')`, [orgId]);
  const lastReport = await one<{ t: Date | null }>(ctx.pool, `SELECT max(created_at) AS t FROM desk_items WHERE org_id=$1 AND subkind='ceo_report'`, [orgId]);
  const week = await one(
    ctx.pool,
    `SELECT count(*) FILTER (WHERE mode='decided')::int AS decided, count(*) FILTER (WHERE status='undone')::int AS undone
       FROM ceo_actions WHERE org_id=$1 AND created_at > $2`,
    [orgId, new Date(now.getTime() - 7 * 86_400_000)],
  );
  const state = !ceo.enabled ? 'disabled' : ceo.paused ? 'paused' : reach.ok ? 'active' : 'offline';
  return {
    hired: true,
    state,
    offlineReason: ceo.enabled && !reach.ok ? ((reach as { reason?: string }).reason ?? null) : null,
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          avatarSeed: agent.avatar_seed,
          avatarStyle: agent.avatar_style,
          model: agent.model,
          runtime: agent.runtime,
          workstationId: agent.workstation_id ?? null,
          workstationName: agent.ws_name ?? null,
        }
      : null,
    training: { ...ceo.training, daysLeft: trainingDaysLeft(ceo.training, now) },
    scores,
    totals: sumScores(scores),
    pendingWakes: Number(pending?.n ?? 0),
    running: running ? { since: iso(running.started_at) as string, purpose: running.purpose } : null,
    openTasks: Number(tasks?.n ?? 0),
    lastReportAt: iso(lastReport?.t),
    policyVersion: ceo.policyVersion,
    undone7d: { undone: Number(week?.undone ?? 0), decided: Number(week?.decided ?? 0) },
    workstations: ws.map((w) => ({ id: w.id, name: w.name, online: !!w.online, capable: !!w.capable, current: w.id === agent?.workstation_id })),
    ...base,
  };
}
