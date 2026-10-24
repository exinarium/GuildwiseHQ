import { inOfficeHours, type OfficeHours } from '@aom/shared';
import { decryptSecret } from '../auth/secrets.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { accountForAgent, accountScope, loadProjectAccounts } from '../dispatcher/accounts.ts';
import { agentView, candidateCards } from '../dispatcher/candidates.ts';
import { GithubError } from './github.ts';
import { problem, stopRow, wakeRow } from './service.ts';

const MIN = 60_000;

/** Is a card waiting that an agent on this workstation could take? (The dispatcher's own eligibility test.) */
async function hasQueuedWork(ctx: Ctx, workstationId: string): Promise<boolean> {
  const agents = await rows(
    ctx.pool,
    `SELECT a.*, ws.runtimes FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
       JOIN users wu ON wu.id = ws.user_id AND wu.status='active'
      WHERE a.workstation_id=$1 AND a.status='active' AND NOT a.is_devops AND ws.status='active'`,
    [workstationId],
  );
  const now = ctx.clock.now();
  const settings = await loadProjectAccounts(ctx.pool);
  for (const a of agents) {
    const rt = (a.runtimes as Array<{ id: string; capabilities: string[] }>).find((r) => r.id === a.runtime);
    const cands = await candidateCards(
      ctx.pool,
      agentView(a, rt?.capabilities ?? []),
      now,
      accountScope(settings, a as never, now),
    );
    // A card whose account is out on this workstation (as last reported) does not justify waking it.
    if (cands.some((c) => accountForAgent(settings, c.project_id, a as never, now))) return true;
  }
  return false;
}

/**
 * Every 15 seconds (docs/RUNNER.md "Cloud workstations"): Codespaces are woken when a card is queued for them (inside
 * the office hours), stopped after `idle_minutes` without a shift (or outside the office hours), and their state
 * follows reality. A VPS is never started or stopped by us. Returns what it did, for tests.
 */
export async function cloudTick(ctx: Ctx): Promise<{ woke: string[]; stopped: string[] }> {
  const woke: string[] = [];
  const stopped: string[] = [];
  const now = ctx.clock.now();
  const list = await rows(
    ctx.pool,
    `SELECT cw.*, w.connected AS ws_connected FROM cloud_workstations cw
       LEFT JOIN workstations w ON w.id = cw.workstation_id
      WHERE cw.removed_at IS NULL AND cw.provider='codespaces' AND cw.state <> 'installing'`,
  );
  for (const r of list) {
    try {
      const hours = (r.office_hours ?? null) as OfficeHours | null;
      const connected = r.ws_connected === true;
      if (r.state === 'starting' || r.state === 'stopped') {
        if (connected) {
          await ctx.pool.query(
            `UPDATE cloud_workstations SET state='running', state_detail='', problem_notified_at=NULL,
                    last_activity_at=$2, updated_at=$2 WHERE id=$1`,
            [r.id, now],
          );
          continue;
        }
      }
      if (r.state === 'starting') {
        await checkStarting(ctx, r, now);
      } else if (r.state === 'stopped') {
        if (
          r.workstation_id &&
          inOfficeHours(hours, now) &&
          (await hasQueuedWork(ctx, r.workstation_id)) &&
          (await wakeRow(ctx, r))
        )
          woke.push(r.id);
      } else if (r.state === 'running') {
        if (
          !connected &&
          r.last_activity_at &&
          now.getTime() - new Date(r.last_activity_at).getTime() > 2 * MIN
        ) {
          // GitHub stops a codespace without user activity after at most 4 hours, headless runner or not.
          const token = await tokenFor(ctx, r.user_id);
          const c = token
            ? await ctx.services.cloud.github.get(token, (r.config as Row).codespaceName).catch(() => null)
            : null;
          if (c && (c.state === 'Shutdown' || c.state === 'Archived')) {
            await ctx.pool.query(
              `UPDATE cloud_workstations SET state='stopped', state_detail='GitHub stopped the codespace', updated_at=$2 WHERE id=$1`,
              [r.id, now],
            );
            continue;
          }
        }
        const busy = r.workstation_id
          ? await one(
              ctx.pool,
              `SELECT 1 FROM shifts WHERE workstation_id=$1 AND status <> 'ended' LIMIT 1`,
              [r.workstation_id],
            )
          : undefined;
        if (busy) {
          await ctx.pool.query('UPDATE cloud_workstations SET last_activity_at=$2 WHERE id=$1', [r.id, now]);
          continue;
        }
        const lastShift = r.workstation_id
          ? await one(ctx.pool, `SELECT max(ended_at) AS at FROM shifts WHERE workstation_id=$1`, [
              r.workstation_id,
            ])
          : undefined;
        const last = Math.max(
          r.last_activity_at ? new Date(r.last_activity_at).getTime() : 0,
          r.last_wake_at ? new Date(r.last_wake_at).getTime() : 0,
          lastShift?.at ? new Date(lastShift.at).getTime() : 0,
        );
        const idleFor = now.getTime() - last;
        const outside = !inOfficeHours(hours, now);
        if (idleFor >= r.idle_minutes * MIN || (outside && idleFor >= MIN)) {
          // Work arrived in the meantime: keep running.
          if (r.workstation_id && (await hasQueuedWork(ctx, r.workstation_id)) && !outside) continue;
          if (await stopRow(ctx, r, outside ? 'Stopped (outside office hours)' : 'Stopped (idle)'))
            stopped.push(r.id);
        }
      }
    } catch (err) {
      ctx.log.warn(
        { id: r.id, err: String((err as Error)?.message ?? err) },
        'cloud workstation tick failed',
      );
    }
  }
  return { woke, stopped };
}

async function checkStarting(ctx: Ctx, r: Row, now: Date): Promise<void> {
  // GitHub reports a failed start; otherwise we wait for the runner to connect (above).
  const token = await tokenFor(ctx, r.user_id);
  if (!token) return;
  try {
    const c = await ctx.services.cloud.github.get(token, (r.config as Row).codespaceName);
    if (c.state === 'Failed' || c.state === 'Unavailable')
      await problem(ctx, r, new GithubError('other', `the codespace is ${c.state.toLowerCase()}`, 0));
    else if (
      (c.state === 'Shutdown' || c.state === 'Archived') &&
      now.getTime() - new Date(r.last_wake_at ?? now).getTime() > 2 * MIN
    )
      await problem(ctx, r, new GithubError('other', 'the codespace did not start', 0));
    else if (now.getTime() - new Date(r.last_wake_at ?? now).getTime() > 15 * MIN)
      await problem(ctx, r, new GithubError('other', 'the runner did not connect within 15 minutes', 0));
  } catch (e) {
    await problem(ctx, r, e);
  }
}

async function tokenFor(ctx: Ctx, userId: string): Promise<string | null> {
  const row = await one(ctx.pool, 'SELECT token_enc FROM cloud_github_connections WHERE user_id=$1', [
    userId,
  ]);
  return row ? decryptSecret(ctx, row.token_enc) : null;
}
