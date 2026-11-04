import {
  SHIFT_KINDS_OUTSIDE_LIMIT,
  SHIFT_LIMIT_CAPABILITY,
  type ShiftLimitSetting,
  type ShiftLimitSource,
  shiftLimitSourceOf,
  UNLIMITED_SHIFTS,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable } from '../db/sql.ts';
import type { RunnerConn } from './registry.ts';

/** The owner's choice stored on a workstation row (null: none, the runner's own value applies). */
export const shiftLimitSettingOf = (row: {
  shift_limit?: number | null;
  shift_limit_unlimited?: boolean | null;
}): ShiftLimitSetting => (row.shift_limit_unlimited ? 'unlimited' : (row.shift_limit ?? null));

/** The platform ceiling per workstation (`AOM_MAX_SHIFTS_PER_WORKSTATION`); 0 means the super admin set none. */
export const platformShiftCap = (ctx: Ctx): number | null =>
  ctx.config.maxShiftsPerWorkstation > 0 ? ctx.config.maxShiftsPerWorkstation : null;

/**
 * How many shifts a workstation takes at once (backlog #76): the owner's number (or unlimited) when set, else what the
 * runner reported from its own config; always under the platform ceiling. `UNLIMITED_SHIFTS` stands for no limit at all.
 */
export function effectiveShiftLimit(
  ctx: Ctx,
  setting: ShiftLimitSetting,
  runnerReported: number | undefined,
): number {
  const cap = platformShiftCap(ctx) ?? UNLIMITED_SHIFTS;
  if (setting === 'unlimited') return cap;
  if (typeof setting === 'number') return Math.min(setting, cap);
  return Math.min(runnerReported ?? cap, cap);
}

/**
 * Where `effectiveShiftLimit` comes from: none chosen (null) is the runner's config; a number above the platform cap, or
 * Unlimited under a cap, is the platform cap; otherwise the owner's workstation setting.
 */
export function shiftLimitSourceFor(ctx: Ctx, setting: ShiftLimitSetting): ShiftLimitSource {
  if (setting === null) return 'runner_config';
  const cap = platformShiftCap(ctx);
  if (cap === null) return 'workstation_setting';
  if (setting === 'unlimited') return 'platform_cap';
  return setting > cap ? 'platform_cap' : 'workstation_setting';
}

/** What a heartbeat's `load` says the runner enforces (`shift-limit:2`; an older runner sends neither field). */
export function recordEnforcedLimit(
  conn: RunnerConn,
  load: { maxShifts?: number | undefined; limitSource?: string | undefined },
  now: Date,
): void {
  if (load.maxShifts === undefined) return;
  conn.enforcedMaxShifts = load.maxShifts;
  const source = shiftLimitSourceOf(load.limitSource);
  if (source) conn.enforcedSource = source;
  else delete conn.enforcedSource;
  conn.enforcedAt = now;
}

export type ShiftLimitSync = 'in_sync' | 'applying' | 'mismatch' | 'unknown';

/**
 * Whether the runner enforces what the server holds: `unknown` offline or for a runner that does not report it,
 * `applying` until the first report after a change, `mismatch` when it enforces another value (or a pairing budget).
 */
export function shiftLimitSync(conn: RunnerConn | undefined): ShiftLimitSync {
  if (!conn?.reportsShiftLimit) return 'unknown';
  if (conn.enforcedMaxShifts === undefined || !conn.enforcedAt) return 'applying';
  if (conn.limitChangedAt && conn.enforcedAt < conn.limitChangedAt) return 'applying';
  const same = (a: number, b: number) => a === b || (a >= UNLIMITED_SHIFTS && b >= UNLIMITED_SHIFTS);
  if (!same(conn.enforcedMaxShifts, conn.maxShifts) || conn.enforcedSource === 'pairing_budget') return 'mismatch';
  return 'in_sync';
}

/** SQL for "the shift takes a slot of the limit" (`takesShiftSlot`): chat and CEO turns do not. */
export const SLOT_KINDS_SQL = (alias = ''): string =>
  `${alias ? `${alias}.` : ''}kind NOT IN (${SHIFT_KINDS_OUTSIDE_LIMIT.map((k) => `'${k}'`).join(',')})`;

/**
 * Drops `shifts.limit` commands still waiting for an answer: a newer value (or a `welcome`, which carries the setting)
 * replaces them, and replaying a stale one after a reconnect would undo the owner's latest choice.
 */
export async function dropStaleShiftLimitCommands(db: Queryable, workstationId: string): Promise<void> {
  await exec(
    db,
    `UPDATE runner_commands SET status='failed', last_error='superseded' WHERE workstation_id=$1 AND type='shifts.limit' AND status IN ('pending','sent')`,
    [workstationId],
  );
}

/** Whether the workstation's runner applies the setting (it announced `shift-limit:1`); null when it never connected. */
export async function runnerAppliesShiftLimit(db: Queryable, workstationId: string): Promise<boolean | null> {
  const r = await one(db, 'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1', [
    workstationId,
  ]);
  return r ? ((r.capabilities ?? []) as string[]).includes(SHIFT_LIMIT_CAPABILITY) : null;
}
