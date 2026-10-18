import {
  defaultPushPreferences,
  PUSH_CATEGORIES,
  type PushCategory,
  type PushPreferences,
  type PushPreferencesUpdate,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';

/** The row that holds a person's default for every organization. */
export const ALL_ORGS = '00000000-0000-0000-0000-000000000000';

/** Preferences of `userId` in `orgId`: that organization's row, else the person's default row, else the defaults. */
export async function loadPreferences(
  ctx: Ctx,
  userId: string,
  orgId: string | null,
): Promise<PushPreferences> {
  const base = defaultPushPreferences();
  const row =
    (orgId
      ? await one(ctx.pool, 'SELECT categories, quiet FROM push_prefs WHERE user_id=$1 AND org_id=$2', [
          userId,
          orgId,
        ])
      : undefined) ??
    (await one(ctx.pool, 'SELECT categories, quiet FROM push_prefs WHERE user_id=$1 AND org_id=$2', [
      userId,
      ALL_ORGS,
    ]));
  if (!row) return base;
  for (const c of PUSH_CATEGORIES) {
    const v = (row.categories as Record<string, unknown>)[c];
    if (typeof v === 'boolean') base.categories[c] = v;
  }
  const q = row.quiet as Partial<PushPreferences['quietHours']>;
  if (typeof q.enabled === 'boolean') base.quietHours.enabled = q.enabled;
  if (typeof q.start === 'string') base.quietHours.start = q.start;
  if (typeof q.end === 'string') base.quietHours.end = q.end;
  return base;
}

export async function savePreferences(
  ctx: Ctx,
  userId: string,
  orgId: string,
  update: PushPreferencesUpdate,
): Promise<PushPreferences> {
  const current = await loadPreferences(ctx, userId, orgId);
  const target = update.allOrgs ? ALL_ORGS : orgId;
  const next: PushPreferences = {
    categories: { ...current.categories, ...(update.categories as Record<PushCategory, boolean>) },
    quietHours: update.quietHours ?? current.quietHours,
  };
  await exec(
    ctx.pool,
    `INSERT INTO push_prefs (user_id, org_id, categories, quiet, updated_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, org_id) DO UPDATE SET categories=EXCLUDED.categories, quiet=EXCLUDED.quiet, updated_at=EXCLUDED.updated_at`,
    [userId, target, JSON.stringify(next.categories), JSON.stringify(next.quietHours), ctx.clock.now()],
  );
  // "All my organizations": the per-organization overrides are dropped, so the one default applies everywhere.
  if (update.allOrgs)
    await exec(ctx.pool, 'DELETE FROM push_prefs WHERE user_id=$1 AND org_id<>$2', [userId, ALL_ORGS]);
  return next;
}

/** Minutes since local midnight of `at` in `timeZone` (UTC when the zone is unknown). */
export function localMinutes(at: Date, timeZone: string | null | undefined): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return localMinutes(at, 'UTC');
  }
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return n('hour') * 60 + n('minute');
}

/** `now` falls within the quiet hours (which may wrap midnight); equal start and end is an empty window. */
export function inQuietHours(
  q: PushPreferences['quietHours'],
  at: Date,
  timeZone: string | null | undefined,
): boolean {
  if (!q.enabled) return false;
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const from = m(q.start);
  const to = m(q.end);
  if (from === to) return false;
  const now = localMinutes(at, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}
