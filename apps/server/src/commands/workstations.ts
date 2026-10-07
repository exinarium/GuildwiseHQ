import { randomUUID } from 'node:crypto';
import { canUnlinkWorkstation, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { generatePairingCode, normalizePairingCode, randomToken, sha256Hex } from '../crypto.ts';
import { exec, one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, orgScope, runnerActor, SYSTEM_ACTOR, userActor, userScope } from './common.ts';
import { devopsHireEvents as devopsHireEventsNew, threadMessage } from './devops.ts';

const CODE_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_CODES = 3;
const MAX_CODE_ATTEMPTS = 5;

export async function createPairingCode(
  ctx: Ctx,
  user: AuthSession['user'],
  opts: { ttlMs?: number; supersedeIds?: string[] } = {},
) {
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? CODE_TTL_MS));
  const code = generatePairingCode();
  const id = await withAppendTx(ctx.pool, async (tx) => {
    // A wizard that starts over retires its earlier unused codes first, so they do not count against the limit.
    if (opts.supersedeIds?.length)
      await exec(
        tx,
        `UPDATE pairing_codes SET expires_at = $2 WHERE id = ANY($1::uuid[]) AND used_at IS NULL`,
        [opts.supersedeIds, now],
      );
    const active = await one(
      tx,
      `SELECT count(*)::int AS n FROM pairing_codes WHERE user_id=$1 AND used_at IS NULL AND expires_at > $2 AND attempts < $3`,
      [user.id, now, MAX_CODE_ATTEMPTS],
    );
    if (Number(active?.n) >= MAX_ACTIVE_CODES) {
      throw new HttpError(
        429,
        'too_many_codes',
        'too many active pairing codes; use or wait for one to expire',
      );
    }
    const row = await one(
      tx,
      `INSERT INTO pairing_codes (user_id, code_hash, expires_at, created_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, sha256Hex(normalizePairingCode(code)), expiresAt, now],
    );
    return String(row?.id);
  });
  return { id, code, expiresAt: expiresAt.toISOString() };
}

export class PairingError extends HttpError {
  constructor(message = 'invalid or expired pairing code') {
    super(401, 'invalid_pairing_code', message);
  }
}

export async function pairRunner(
  ctx: Ctx,
  input: { code: string; name: string; platform: string; hostname: string; runnerVersion: string },
) {
  const now = ctx.clock.now();
  const runnerToken = `aomr_${randomToken(32)}`;
  const workstationId = randomUUID();
  const hash = sha256Hex(normalizePairingCode(input.code));
  // The attempt counter is bumped in its own committed statement so a failure cannot roll it back.
  const bumped = await one(
    ctx.pool,
    `UPDATE pairing_codes SET attempts = attempts + 1 WHERE code_hash=$1 RETURNING id, attempts`,
    [hash],
  );
  if (!bumped) throw new PairingError();
  await withAppendTx(ctx.pool, async (tx) => {
    const c = await one(
      tx,
      `SELECT id, user_id, expires_at, used_at, attempts FROM pairing_codes WHERE id=$1 FOR UPDATE`,
      [bumped.id],
    );
    if (!c || c.used_at || new Date(c.expires_at) <= now || c.attempts > MAX_CODE_ATTEMPTS)
      throw new PairingError();
    await exec(tx, 'UPDATE pairing_codes SET used_at=$2, workstation_id=$3 WHERE id=$1', [
      c.id,
      now,
      workstationId,
    ]);
    // Every workstation gets its own DevOps engineer, hired in the same append (docs/ARCHITECTURE.md section 16.2).
    // One DevOps engineer per organization the user belongs to (owner decision 15), hired in the same append.
    const devopsHires = await devopsHireEventsNew(tx, c.user_id, workstationId);
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(workstationId),
          event: {
            type: 'WorkstationPaired',
            payload: {
              workstationId,
              userId: c.user_id,
              name: input.name,
              platform: input.platform,
              hostname: input.hostname,
              runnerVersion: input.runnerVersion,
              tokenHash: sha256Hex(runnerToken),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: userScope(c.user_id),
        },
        ...devopsHires,
      ],
      { tx },
    );
  });
  return { workstationId, runnerToken };
}

export async function renameWorkstation(ctx: Ctx, user: AuthSession['user'], id: string, name: string) {
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT user_id FROM workstations WHERE id=$1 AND status='active'`, [id]);
    if (!ws || ws.user_id !== user.id) throw notFound('workstation not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(id),
          event: { type: 'WorkstationRenamed', payload: { workstationId: id, name } },
          actor: userActor(user.id),
          scope: userScope(user.id),
        },
      ],
      { tx },
    );
  });
}

/**
 * Unpair (the web app's word for unlinking): owner or admin. The workstation is marked unlinked and its runner token
 * is revoked (no connection is accepted any more, a pending rotated token is dropped); claims held on it are
 * released, its shifts stop, and DevOps requests that were waiting for it fail with the reason. The gateway closes
 * the socket (4403, "workstation unpaired"), which the runner turns into a clean exit with a message.
 */
export async function unlinkWorkstation(ctx: Ctx, user: AuthSession['user'], id: string) {
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, 'SELECT user_id, status FROM workstations WHERE id=$1', [id]);
    if (!ws || !canUnlinkWorkstation(user, ws.user_id)) throw notFound('workstation not found');
    if (ws.status === 'unlinked') throw conflict('already_unlinked', 'workstation is already unlinked');
    await unlinkWorkstationIn(ctx, tx, user.id, id, ws.user_id, ws.user_id === user.id ? 'owner' : 'admin');
  });
}

/** The unlink itself, inside the caller's transaction (also used when an administrator deactivates a user). */
export async function unlinkWorkstationIn(
  ctx: Ctx,
  tx: Tx,
  actorUserId: string,
  id: string,
  wsOwnerId: string,
  by: 'owner' | 'admin',
): Promise<void> {
  const ws = { user_id: wsOwnerId };
  const user = { id: actorUserId };
  {
    const events: AppendInput[] = [
      {
        streamId: streamId.workstation(id),
        event: { type: 'WorkstationUnlinked', payload: { workstationId: id, by } },
        actor: userActor(user.id),
        scope: userScope(ws.user_id),
      },
    ];
    const claimed = await rows(
      tx,
      `SELECT c.id, c.org_id, c.project_id, c.claim_id, c.claimed_by_agent_id, c.claim_shift_id
         FROM cards c WHERE c.claim_workstation_id=$1 AND c.claim_id IS NOT NULL`,
      [id],
    );
    for (const c of claimed) {
      events.push({
        streamId: streamId.card(c.id),
        event: {
          type: 'ClaimReleased',
          payload: {
            cardId: c.id,
            claimId: c.claim_id,
            agentId: c.claimed_by_agent_id,
            reason: 'workstation_unlinked',
          },
        },
        actor: userActor(user.id),
        scope: { orgId: c.org_id, projectId: c.project_id, audience: 'project' },
      });
      events.push(
        cardMessage(c, { kind: 'system' }, 'system', 'Claim released: the workstation was unlinked.'),
      );
    }
    // End shifts that were still open on this workstation.
    const open = await rows(
      tx,
      `SELECT id, org_id, agent_id, card_id, started_at FROM shifts WHERE workstation_id=$1 AND status <> 'ended'`,
      [id],
    );
    for (const s of open) {
      events.push({
        streamId: streamId.shift(s.id),
        event: {
          type: 'ShiftEnded',
          payload: {
            shiftId: s.id,
            agentId: s.agent_id,
            cardId: s.card_id ?? undefined,
            outcome: 'lost',
            durationMs: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            guardViolations: [],
          },
        },
        actor: runnerActor(id),
        scope: orgScope(s.org_id),
      });
    }
    // DevOps requests that were queued or in progress for this workstation can never run: fail them with the reason.
    const wsName = (await one<{ name: string }>(tx, 'SELECT name FROM workstations WHERE id=$1', [id]))?.name;
    const why = `The workstation${wsName ? ` "${wsName}"` : ''} was unpaired${by === 'admin' ? ' by a platform administrator' : ''}, so this request cannot run. Pair the machine again and ask once more.`;
    const requests = await rows(
      tx,
      `SELECT id, thread_id, approval FROM devops_requests
        WHERE workstation_id=$1 AND status IN ('queued','running','needs_approval') ORDER BY created_at`,
      [id],
    );
    for (const r of requests) {
      events.push(
        {
          streamId: streamId.thread(r.id),
          event: {
            type: 'DevOpsRequestCompleted',
            payload: { requestId: r.id, status: 'failed', summary: why },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(r.org_id),
        },
        threadMessage(r.thread_id, r.org_id, { kind: 'system' }, 'system', why),
      );
      const deskItemId = (r.approval as { deskItemId?: string } | null)?.deskItemId;
      if (deskItemId)
        events.push({
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId,
              resolution: 'acknowledged',
              note: 'The workstation was unpaired; the request failed.',
              by: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(r.org_id),
        });
    }
    await ctx.store.append(events, { tx });
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', last_error='workstation unpaired' WHERE workstation_id=$1 AND status IN ('pending','sent')`,
      [id],
    );
    // A pending rotated token must not let the runner back in.
    await exec(tx, 'DELETE FROM runner_token_rotations WHERE workstation_id=$1', [id]);
  }
}
