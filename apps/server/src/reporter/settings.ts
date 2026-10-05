import { DEFAULT_REPORTING, type ReportingPrefs } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

export interface OrgReporting extends ReportingPrefs {
  timezone: string | null;
  /** Local date of the last queued floor report. */
  floorReportDay: string | null;
  chatThreadId: string | null;
  createdAt: Date | null;
}

/** The reporting preferences of an organization (its owner's user row); unset keys mean the defaults. */
export async function reportingOf(db: Queryable, orgId: string): Promise<OrgReporting> {
  const u = await one(
    db,
    'SELECT timezone, reporting, floor_report_day, ba_chat_thread_id, created_at FROM users WHERE id=$1',
    [orgId],
  );
  const r = (u?.reporting ?? {}) as Partial<ReportingPrefs>;
  return {
    routeViaBa: r.routeViaBa ?? DEFAULT_REPORTING.routeViaBa,
    dailyAt: r.dailyAt ?? DEFAULT_REPORTING.dailyAt,
    timezone: u?.timezone ?? null,
    floorReportDay: u?.floor_report_day ?? null,
    chatThreadId: u?.ba_chat_thread_id ?? null,
    createdAt: u?.created_at ? new Date(u.created_at) : null,
  };
}
