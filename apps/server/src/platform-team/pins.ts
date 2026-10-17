import { PLATFORM_DESK_SUBKIND, RUNNER_PIN_CAPABILITY, type RunnerPinDto } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, rows } from '../db/sql.ts';
import { badRequest, notFound } from '../errors.ts';
import { findRelease } from '../installer/release.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { notifyPlatformDesk } from './desk.ts';

/**
 * Safe mode (Lean Team v3, design 8.5): the super admin or the platform organisation pins one workstation (or all of
 * them) to a runner version, for example to roll back to the last good one. It rides on the runner's own update
 * mechanism: the server tells the runner which version to run (`welcome.runnerPin` on connect, the `runner.pin` command
 * while connected); the runner's updater then downloads exactly that release from `GET /api/runner/release?version=`,
 * verifies it and switches (an older version too), with the same probation and rollback as any update. While pinned the
 * runner does not follow newer releases.
 */

/** `platform_settings` key of the pin that applies to every workstation without its own. */
export const ALL_PIN_KEY = 'runners.version_pin';

export interface EffectivePin {
  version: string;
  reason: string | null;
  scope: 'workstation' | 'all';
}

/** The pin that applies to a workstation: its own, else the all-workstations pin, else none. */
export async function effectivePin(db: Queryable, workstationId: string): Promise<EffectivePin | null> {
  const own = await one(db, 'SELECT version, reason FROM workstation_runner_pins WHERE workstation_id=$1', [
    workstationId,
  ]);
  if (own) return { version: own.version, reason: own.reason, scope: 'workstation' };
  const all = await one(db, 'SELECT value FROM platform_settings WHERE key=$1', [ALL_PIN_KEY]);
  const v = all?.value as { version?: string; reason?: string | null } | null | undefined;
  return v?.version ? { version: v.version, reason: v.reason ?? null, scope: 'all' } : null;
}

/** What `welcome` carries: the pinned version or null. */
export async function pinForWelcome(
  db: Queryable,
  workstationId: string,
): Promise<{ version: string } | null> {
  const p = await effectivePin(db, workstationId);
  return p ? { version: p.version } : null;
}

export async function listPins(ctx: Ctx): Promise<RunnerPinDto[]> {
  const out: RunnerPinDto[] = [];
  const all = await one(ctx.pool, 'SELECT value, updated_at FROM platform_settings WHERE key=$1', [
    ALL_PIN_KEY,
  ]);
  const v = all?.value as { version?: string; reason?: string | null } | null | undefined;
  if (v?.version)
    out.push({
      workstationId: null,
      version: v.version,
      reason: v.reason ?? null,
      pinnedAt: iso(all?.updated_at) as string,
    });
  for (const r of await rows(ctx.pool, 'SELECT * FROM workstation_runner_pins ORDER BY pinned_at DESC'))
    out.push({
      workstationId: r.workstation_id,
      version: r.version,
      reason: r.reason,
      pinnedAt: iso(r.pinned_at) as string,
    });
  return out;
}

/** Tells the connected runners their pin changed (a `runner.pin` command, delivered now or when they connect). */
async function deliverPin(ctx: Ctx, workstationIds: string[]): Promise<void> {
  for (const id of workstationIds) {
    const caps = await one(
      ctx.pool,
      'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
      [id],
    );
    if (!((caps?.capabilities ?? []) as string[]).includes(RUNNER_PIN_CAPABILITY)) continue;
    // A newer pin replaces older ones still waiting.
    await exec(
      ctx.pool,
      `UPDATE runner_commands SET status='failed', last_error='superseded'
        WHERE workstation_id=$1 AND type='runner.pin' AND status IN ('pending','sent')`,
      [id],
    );
    const pin = await pinForWelcome(ctx.pool, id);
    await enqueueRunnerCommand(ctx.pool, id, 'runner.pin', { version: pin?.version ?? null });
    void Promise.resolve(ctx.services.gateway.deliverPending(id)).catch(() => undefined);
  }
}

/**
 * Pins (or, with `version` null, unpins) one workstation or all of them. The version must be a release this server
 * has. Returns how many workstations were told.
 */
export async function setRunnerPin(
  ctx: Ctx,
  who: AuthSession['user'],
  req: { workstationId: string | null; version: string | null; reason?: string | undefined },
): Promise<{ notified: number }> {
  if (req.version && !(await findRelease(ctx.config, req.version)))
    throw badRequest('unknown_release', `this server has no runner release ${req.version}`);
  const now = ctx.clock.now();
  let affected: string[];
  if (req.workstationId) {
    const ws = await one(ctx.pool, `SELECT id, name FROM workstations WHERE id=$1 AND status='active'`, [
      req.workstationId,
    ]);
    if (!ws) throw notFound('workstation not found');
    if (req.version)
      await exec(
        ctx.pool,
        `INSERT INTO workstation_runner_pins (workstation_id, version, reason, pinned_by, pinned_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workstation_id) DO UPDATE SET version=EXCLUDED.version, reason=EXCLUDED.reason,
           pinned_by=EXCLUDED.pinned_by, pinned_at=EXCLUDED.pinned_at`,
        [req.workstationId, req.version, req.reason ?? null, who.id, now],
      );
    else
      await exec(ctx.pool, 'DELETE FROM workstation_runner_pins WHERE workstation_id=$1', [
        req.workstationId,
      ]);
    affected = [req.workstationId];
  } else {
    if (req.version)
      await exec(
        ctx.pool,
        `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [ALL_PIN_KEY, JSON.stringify({ version: req.version, reason: req.reason ?? null }), who.id, now],
      );
    else await exec(ctx.pool, 'DELETE FROM platform_settings WHERE key=$1', [ALL_PIN_KEY]);
    affected = (await rows(ctx.pool, `SELECT id FROM workstations WHERE status='active'`)).map((r) => r.id);
  }
  await deliverPin(ctx, affected);
  await notifyPlatformDesk(ctx, {
    subjectKey: `platform_runner_pin:${req.workstationId ?? 'all'}`,
    subkind: PLATFORM_DESK_SUBKIND.runnerPin,
    title: req.version
      ? `Safe mode: ${req.workstationId ? 'a workstation' : 'all workstations'} pinned to runner ${req.version}`
      : `Safe mode ended for ${req.workstationId ? 'a workstation' : 'all workstations'}`,
    body: `${req.version ? `Runners run exactly ${req.version} and do not follow newer releases.` : 'Runners follow the latest release again.'}${req.reason ? ` Reason: ${req.reason}` : ''}`,
    data: { workstationId: req.workstationId, version: req.version },
  });
  return { notified: affected.length };
}
