import { DEFAULT_REPORTING, type ReportingPrefs } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

export interface OrgReporting extends ReportingPrefs {
  timezone: string | null;
  /** Local date of the last queued floor report. */
  floorReportDay: string | null;
  chatThreadId: string | null;
  createdAt: Date | null;
}

/**
 * The reporting preferences of an organization: they live on its Owner's user row (the organization is that user for
 * a migrated organization); unset keys mean the defaults. The time zone is the Owner's.
 */
export async function reportingOf(db: Queryable, orgId: string): Promise<OrgReporting> {
  const u = await one(
    db,
    `SELECT timezone, reporting, floor_report_day, ba_chat_thread_id, created_at FROM users
      WHERE id = COALESCE((SELECT owner_user_id FROM organizations WHERE id = $1), $1)`,
    [orgId],
  );
  const r = (u?.reporting ?? {}) as Partial<ReportingPrefs>;
  return {
    routeViaBa: r.routeViaBa ?? DEFAULT_REPORTING.routeViaBa,
    dailyAt: r.dailyAt ?? DEFAULT_REPORTING.dailyAt,
    interestDigestCap: r.interestDigestCap ?? null,
    timezone: u?.timezone ?? null,
    floorReportDay: u?.floor_report_day ?? null,
    chatThreadId: u?.ba_chat_thread_id ?? null,
    createdAt: u?.created_at ? new Date(u.created_at) : null,
  };
}
