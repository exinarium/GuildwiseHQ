import { Readable } from 'node:stream';
import {
  AUDIT_COLUMNS,
  AUDIT_EXPORT_MAX_DAYS,
  type AuditExportQuery,
  redactForExport,
  streamId,
} from '@aom/shared';
import { orgScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { badRequest, HttpError } from '../errors.ts';

/**
 * What the export contains (decided by default, see the design doc): the actions people took in the organization (events with a
 * user actor) plus the governance events the system writes about them. Message bodies, drafts, read marks and other
 * content or telemetry are not audit and stay out.
 */
const SYSTEM_AUDIT_TYPES = [
  'GatedActionRequested',
  'GatedActionUsed',
  'OffboardingPurgeRan',
  'UserDeactivated',
];
const NOT_AUDIT = (col = 'e.type'): string =>
  `NOT (${col} = ANY(ARRAY['ThreadMessagePosted','ChatRead','UserWhatsNewSeen','UserDigestPreferenceSet','ChatThreadModelSet','ChatThreadDirsSet']) OR ${col} ~ '(Draft|Note|Seen|Read)(Updated|Saved|Added|Removed|Merged|Voted|Discarded)?$')`;

const BATCH = 500;
/** At most this many exports per person per hour, and one at a time: an export reads a year of events. */
export const EXPORTS_PER_HOUR = 10;
const running = new Set<string>();

/** `YYYY-MM-DD` is the start (or, for `to`, the end) of that day in UTC; a date-time is taken as given. */
function parseBound(v: string | undefined, fallback: Date, endOfDay: boolean): Date {
  if (!v) return fallback;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T00:00:00.000Z` : v);
  if (Number.isNaN(d.getTime()))
    throw badRequest('bad_date', `"${v}" is not a date (use YYYY-MM-DD or an ISO date-time)`);
  return dateOnly && endOfDay ? new Date(d.getTime() + 86_400_000) : d;
}

export function auditRange(ctx: Ctx, q: AuditExportQuery): { from: Date; to: Date } {
  const now = ctx.clock.now();
  const to = parseBound(q.to, now, true);
  const from = parseBound(q.from, new Date(to.getTime() - 30 * 86_400_000), false);
  if (from >= to) throw badRequest('bad_range', 'the start must be before the end');
  if (to.getTime() - from.getTime() > AUDIT_EXPORT_MAX_DAYS * 86_400_000)
    throw badRequest(
      'range_too_long',
      `an export covers at most ${AUDIT_EXPORT_MAX_DAYS} days: export in pieces`,
    );
  return { from, to };
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // a spreadsheet would run a cell that starts with these as a formula
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const humanType = (t: string): string => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

interface AuditRow {
  at: string;
  type: string;
  actor_kind: string;
  actor_id: string | null;
  actor_name: string | null;
  stream: string;
  project_id: string | null;
  summary: string;
  payload: unknown;
}

async function* batches(
  ctx: Ctx,
  orgId: string,
  q: AuditExportQuery,
  from: Date,
  to: Date,
): AsyncGenerator<AuditRow[]> {
  let last = '0';
  for (;;) {
    const r = await rows(
      ctx.pool,
      `SELECT e.seq, e.created_at, e.type, e.actor_kind, e.actor_id, e.stream_id, e.project_id, e.payload, u.display_name AS actor_name
         FROM events e LEFT JOIN users u ON u.id = e.actor_id AND e.actor_kind = 'user'
        WHERE e.org_id = $1 AND e.seq > $2 AND e.created_at >= $3 AND e.created_at < $4
          AND (e.actor_kind = 'user' OR e.type = ANY($5::text[]))
          AND ${NOT_AUDIT()}
          AND ($6::uuid IS NULL OR e.actor_id = $6)
          AND ($7::text IS NULL OR e.type = $7)
        ORDER BY e.seq LIMIT ${BATCH}`,
      [orgId, last, from, to, SYSTEM_AUDIT_TYPES, q.actorUserId ?? null, q.type ?? null],
    );
    if (r.length === 0) return;
    last = String(r[r.length - 1]?.seq);
    yield r.map((e) => ({
      at: new Date(e.created_at).toISOString(),
      type: e.type as string,
      actor_kind: e.actor_kind as string,
      actor_id: (e.actor_id as string | null) ?? null,
      actor_name: (e.actor_name as string | null) ?? null,
      stream: e.stream_id as string,
      project_id: (e.project_id as string | null) ?? null,
      summary: humanType(e.type as string),
      payload: redactForExport(e.payload),
    }));
    if (r.length < BATCH) return;
  }
}

/**
 * Streams the organization's audit log as CSV or JSON, a batch at a time (an export of a year never sits in memory). The payload
 * of every event goes through the export redaction (secret-looking keys and text are masked). The export is itself an event.
 */
export async function auditExport(
  ctx: Ctx,
  orgId: string,
  byUserId: string,
  q: AuditExportQuery,
): Promise<{ contentType: string; filename: string; stream: Readable }> {
  const { from, to } = auditRange(ctx, q);
  if (running.has(byUserId))
    throw new HttpError(429, 'export_running', 'an export of yours is still running: wait for it to finish');
  const recent = await rows<{ n: number }>(
    ctx.pool,
    `SELECT count(*)::int AS n FROM events WHERE type='AuditExported' AND org_id=$1 AND actor_id=$2 AND created_at > $3`,
    [orgId, byUserId, new Date(ctx.clock.now().getTime() - 3_600_000)],
  );
  if (Number(recent[0]?.n ?? 0) >= EXPORTS_PER_HOUR)
    throw new HttpError(429, 'rate_limited', `at most ${EXPORTS_PER_HOUR} exports an hour: try again later`);
  running.add(byUserId);
  try {
    await ctx.store.append([
      {
        streamId: streamId.org(orgId),
        event: {
          type: 'AuditExported',
          payload: {
            orgId,
            by: byUserId,
            format: q.format,
            from: from.toISOString(),
            to: to.toISOString(),
            ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
            ...(q.type ? { type: q.type } : {}),
          },
        },
        actor: userActor(byUserId),
        scope: orgScope(orgId),
      },
    ]);
  } catch (err) {
    running.delete(byUserId);
    throw err;
  }
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const filename = `audit-${day(from)}-to-${day(to)}.${q.format}`;
  async function* chunks(): AsyncGenerator<string> {
    try {
      if (q.format === 'csv') yield `${AUDIT_COLUMNS.join(',')}\r\n`;
      else yield '[';
      let first = true;
      try {
        for await (const batch of batches(ctx, orgId, q, from, to)) {
          for (const row of batch) {
            if (q.format === 'csv') yield `${AUDIT_COLUMNS.map((c) => csvCell(row[c])).join(',')}\r\n`;
            else {
              yield `${first ? '\n' : ',\n'}${JSON.stringify(row)}`;
              first = false;
            }
          }
        }
      } catch (err) {
        ctx.log.error({ err }, 'audit export failed half-way');
        // Say so inside the file, then abort the response: a truncated file must not look complete (the JSON is left without its
        // closing bracket, the CSV ends with a marker row).
        const note = 'EXPORT ABORTED: this file is incomplete, export again';
        yield q.format === 'csv'
          ? `${csvCell('#ERROR')},${csvCell(note)}\r\n`
          : `${first ? '\n' : ',\n'}${JSON.stringify({ error: note })}`;
        throw err;
      }
      if (q.format === 'json') yield '\n]\n';
    } finally {
      running.delete(byUserId);
    }
  }
  const stream = Readable.from(chunks());
  // a client that goes away before the first chunk never starts the generator: release the slot when the stream closes
  stream.once('close', () => running.delete(byUserId));
  return {
    contentType: q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    filename,
    stream,
  };
}
