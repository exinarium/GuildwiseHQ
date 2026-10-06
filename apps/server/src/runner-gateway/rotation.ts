import { RUNNER_TOKEN_PREFIX, streamId } from '@aom/shared';
import { SYSTEM_ACTOR, userScope } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';

/** A pending token that is never used expires after a day. */
const PENDING_TTL_MS = 24 * 3600_000;

/**
 * `token.rotate`: issues a fresh runner token. The old token stays valid; the new one replaces it
 * (`WorkstationTokenRotated`) the first time the runner connects with it, so a runner that fails to store the new
 * token is never locked out (docs/ARCHITECTURE.md section 18).
 */
export async function issueRotatedToken(ctx: Ctx, workstationId: string): Promise<string> {
  const token = `${RUNNER_TOKEN_PREFIX}${randomToken(32)}`;
  await exec(
    ctx.pool,
    `INSERT INTO runner_token_rotations (workstation_id, token_hash, issued_at) VALUES ($1,$2,$3)
     ON CONFLICT (workstation_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, issued_at = EXCLUDED.issued_at`,
    [workstationId, sha256Hex(token), ctx.clock.now()],
  );
  return token;
}

/** Connection with a pending token: it becomes the workstation's token. Returns the workstation row or undefined. */
export async function promoteRotatedToken(ctx: Ctx, token: string) {
  const hash = sha256Hex(token);
  const pending = await one(
    ctx.pool,
    `SELECT r.workstation_id, r.issued_at, w.user_id FROM runner_token_rotations r
       JOIN workstations w ON w.id = r.workstation_id WHERE r.token_hash = $1`,
    [hash],
  );
  if (!pending) return undefined;
  if (ctx.clock.now().getTime() - new Date(pending.issued_at).getTime() > PENDING_TTL_MS) return undefined;
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(pending.workstation_id),
          event: {
            type: 'WorkstationTokenRotated',
            payload: { workstationId: pending.workstation_id, tokenHash: hash },
          },
          actor: SYSTEM_ACTOR,
          scope: userScope(pending.user_id),
        },
      ],
      { tx },
    );
    await exec(tx, 'DELETE FROM runner_token_rotations WHERE workstation_id=$1', [pending.workstation_id]);
  });
  return one(ctx.pool, 'SELECT id, user_id, status FROM workstations WHERE id=$1', [pending.workstation_id]);
}
