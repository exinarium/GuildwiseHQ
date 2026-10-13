import { MAX_TOOLCHAINS, type RemoveToolchainRequest, ToolchainInfoSchema } from '@aom/shared';
import { z } from 'zod';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/**
 * Agent toolchains (docs/RUNNER.md "Agent toolchains"). The runner decides what the sandboxed agents may use (detected
 * tools, `toolchainPaths`, what the DevOps engineer registered with `aom toolchain add`); the server only shows the
 * list on the Workstations page and relays the owner's "remove".
 */

/** `toolchains.report` from the runner: replaces what the workstation reported before. Invalid entries are dropped. */
export async function applyToolchainsReport(ctx: Ctx, workstationId: string, report: unknown): Promise<void> {
  const parsed = z.object({ toolchains: z.array(z.unknown()).max(MAX_TOOLCHAINS) }).safeParse(report);
  if (!parsed.success) return;
  const items = parsed.data.toolchains.flatMap((t) => {
    const p = ToolchainInfoSchema.safeParse(t);
    return p.success ? [p.data] : [];
  });
  await exec(ctx.pool, `UPDATE workstations SET toolchains=$2::jsonb, toolchains_checked_at=$3 WHERE id=$1`, [
    workstationId,
    JSON.stringify(items),
    ctx.clock.now(),
  ]);
}

/** Queues `toolchain.remove` for the workstation's owner. The runner answers with a fresh report. */
export async function requestToolchainRemove(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: RemoveToolchainRequest,
): Promise<void> {
  const w = await one(
    ctx.pool,
    `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!w) throw notFound('workstation not found');
  await enqueueRunnerCommand(ctx.pool, workstationId, 'toolchain.remove', { name: body.name });
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
}
