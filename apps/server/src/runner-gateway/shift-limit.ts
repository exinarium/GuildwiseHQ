import { SHIFT_LIMIT_CAPABILITY, type ShiftLimitSetting, UNLIMITED_SHIFTS } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable } from '../db/sql.ts';

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
