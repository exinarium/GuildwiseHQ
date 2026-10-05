import type { FloorDigest, SignalBrief } from '@aom/shared';
import { iso, type Queryable, rows } from '../db/sql.ts';

export const toSignalBrief = (r: Record<string, any>): SignalBrief => ({
  id: r.id,
  kind: r.kind,
  urgency: r.urgency,
  fingerprint: r.fingerprint,
  count: r.count,
  status: r.status,
  firstSeenAt: iso(r.first_seen_at) as string,
  lastSeenAt: iso(r.last_seen_at) as string,
  subject: r.subject,
  evidence: r.evidence ?? {},
});

/** Time of the organization's previous floor report (null before the first). */
export async function lastFloorReportAt(db: Queryable, orgId: string): Promise<Date | null> {
  const r = await rows<{ t: Date | null }>(
    db,
    `SELECT max(created_at) AS t FROM desk_items WHERE org_id=$1 AND subkind='floor_report'`,
    [orgId],
  );
  return r[0]?.t ? new Date(r[0].t) : null;
}

/**
 * The facts of the daily floor report (owner decision B6): phases waiting or open and those held open by late bugs
 * (A6), stuck, blocked and backing-off cards, repeated approvals, failures, the open DevOps requests and what the BA
 * resolved by itself. Deterministic SQL; the BA only adds prose (or the server's template does).
 */
export async function buildFloorDigest(
  db: Queryable,
  orgId: string,
  now: Date,
  localDate: string,
): Promise<FloorDigest> {
  const since = await lastFloorReportAt(db, orgId);
  const sinceOrEpoch = since ?? new Date(0);

  const phaseRows = await rows(
    db,
    `SELECT ph.id, ph.ref, ph.name, ph.status, ph.completed_at, p.key AS project_key
       FROM phases ph JOIN projects p ON p.id = ph.project_id
      WHERE ph.org_id=$1 AND p.status='active'
        AND ph.status NOT IN ('proposed','done','done_with_failures','followups_rejected','discarded','cancelled')
      ORDER BY ph.created_at, ph.id`,
    [orgId],
  );
  const lateBugRows = phaseRows.length
    ? await rows(
        db,
        `SELECT c.phase_id, c.ref FROM cards c JOIN phases ph ON ph.id = c.phase_id
          WHERE c.phase_id = ANY($1::uuid[]) AND c.origin = 'test_failure' AND c.status NOT IN ('done','cancelled')
            AND ph.completed_at IS NOT NULL AND c.created_at > ph.completed_at
          ORDER BY c.created_at`,
        [phaseRows.map((p) => p.id)],
      )
    : [];
  const phases = phaseRows.map((p) => ({
    ref: p.ref as string,
    name: p.name as string,
    status: p.status as string,
    projectKey: p.project_key as string,
    lateBugs: lateBugRows.filter((b) => b.phase_id === p.id).map((b) => b.ref as string),
  }));

  const signalRows = await rows(
    db,
    `SELECT * FROM ba_signals WHERE org_id=$1 AND status <> 'resolved' ORDER BY first_seen_at, id`,
    [orgId],
  );
  const signals = signalRows.map((r) => ({
    ...toSignalBrief(r),
    isNew: r.status === 'open' || (r.reported_at ? new Date(r.reported_at) > sinceOrEpoch : true),
  }));

  const backing = await rows(
    db,
    `SELECT c.ref, c.title, c.retry_failures, c.retry_after FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.org_id=$1 AND p.status='active' AND c.retry_after > $2 AND c.status NOT IN ('done','cancelled')
      ORDER BY c.retry_after`,
    [orgId, now],
  );

  const devops = await rows(
    db,
    `SELECT r.id, r.summary, r.status, w.name AS ws_name FROM devops_requests r JOIN workstations w ON w.id = r.workstation_id
      WHERE r.org_id=$1 AND r.status IN ('queued','running','needs_approval') ORDER BY r.created_at`,
    [orgId],
  );

  const resolved = await rows(
    db,
    `SELECT d.id, d.title, d.triage, d.status, d.ba_note, d.answer FROM desk_items d
      WHERE d.org_id=$1 AND d.updated_at > $2
        AND (d.triage IN ('dismissed','merged')
             OR (d.status='answered' AND d.kind='question' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = d.answered_by_agent_id AND a.role_key='ba')))
      ORDER BY d.updated_at`,
    [orgId, sinceOrEpoch],
  );

  const failures = await rows(
    db,
    `SELECT c.ref, c.title, count(*)::int AS n FROM shifts s JOIN cards c ON c.id = s.card_id
      WHERE s.org_id=$1 AND s.status='ended' AND s.outcome IN ('no_report','crashed','timeout') AND s.ended_at > $2
      GROUP BY c.ref, c.title ORDER BY n DESC, c.ref`,
    [orgId, sinceOrEpoch],
  );

  return {
    generatedAt: now.toISOString(),
    localDate,
    since: since ? since.toISOString() : null,
    phases,
    signals,
    backingOff: backing.map((b) => ({
      ref: b.ref,
      title: b.title,
      failures: b.retry_failures,
      until: iso(b.retry_after) as string,
    })),
    devopsOpen: devops.map((r) => ({
      id: r.id,
      summary: r.summary,
      status: r.status,
      workstation: r.ws_name,
    })),
    resolvedByBa: resolved.map((r) => ({
      id: r.id,
      title: r.title,
      how: r.triage === 'merged' ? 'merged' : r.triage === 'dismissed' ? 'dismissed' : 'answered',
      note: r.ba_note ?? r.answer ?? null,
    })),
    failures: failures.map((f) => ({ ref: f.ref, title: f.title, failedShifts: f.n })),
  };
}
