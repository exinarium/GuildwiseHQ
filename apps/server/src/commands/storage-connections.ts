import { randomUUID } from 'node:crypto';
import {
  ENVELOPE_TTL_MS,
  STORAGE_CAPABILITY,
  STORAGE_OAUTH_KINDS,
  type StorageConnectionCreate,
  type StorageConnectionDto,
  type StorageErrorCode,
  StorageErrorCodeSchema,
  type StorageHealthReport,
  type StorageRequestDto,
  type StorageWriteError,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { orgScope, userActor } from './common.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Storage connections (docs/investigations/GWP-63). The server keeps a connection's id, kind, label, workstation and
 * health. A token, key, endpoint, bucket, folder or file content is never here: the runner holds them, sealed.
 */

const REQUEST_TTL_MS = 10 * 60_000;
const DEVICE_TTL_MS = 20 * 60_000;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'expired']);

const code = (v: unknown): StorageErrorCode | null => {
  const p = StorageErrorCodeSchema.safeParse(v);
  return p.success ? p.data : null;
};

async function ownWorkstation(ctx: Ctx, userId: string, workstationId: string) {
  const w = await one<{ id: string; name: string }>(
    ctx.pool,
    `SELECT id, name FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, userId],
  );
  if (!w) throw notFound('workstation not found');
  return w;
}

async function supportsStorage(ctx: Ctx, workstationId: string): Promise<boolean> {
  const r = await one<{ capabilities: string[] }>(
    ctx.pool,
    'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId],
  );
  return !!r?.capabilities?.includes(STORAGE_CAPABILITY);
}

interface ConnRow {
  id: string;
  org_id: string;
  kind: string;
  label: string;
  workstation_id: string;
  status: string;
}

async function ownConnection(ctx: Ctx, orgId: string, id: string): Promise<ConnRow> {
  const r = await one<ConnRow>(
    ctx.pool,
    `SELECT id, org_id, kind, label, workstation_id, status FROM storage_connections
      WHERE id=$1 AND org_id=$2 AND status='active'`,
    [id, orgId],
  );
  if (!r) throw notFound('storage connection not found');
  return r;
}

/** The connection plus the check that the user owns its workstation and that workstation is ready for a command. */
async function gate(ctx: Ctx, user: AuthSession['user'], orgId: string, id: string): Promise<ConnRow> {
  const c = await ownConnection(ctx, orgId, id);
  await ownWorkstation(ctx, user.id, c.workstation_id);
  if (!ctx.services.runners.isOnline(c.workstation_id))
    throw conflict('workstation_offline', 'this workstation is offline: start its runner and try again');
  if (!(await supportsStorage(ctx, c.workstation_id)))
    throw conflict('runner_too_old', 'update the runner on this workstation to connect storage from here');
  return c;
}

// ------------------------------------------------------------------------------------------------ list / create

export async function listStorageConnections(
  ctx: Ctx,
  orgId: string,
  userId: string,
): Promise<StorageConnectionDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT c.id, c.kind, c.label, c.created_at, c.workstation_id, w.name AS ws_name, w.user_id AS ws_user,
            h.state, h.error_code, h.message, h.checked_at, h.last_ok_at
       FROM storage_connections c
       JOIN workstations w ON w.id = c.workstation_id
       LEFT JOIN storage_connection_health h ON h.connection_id = c.id
      WHERE c.org_id=$1 AND c.status='active' ORDER BY c.created_at, c.id`,
    [orgId],
  );
  return list.map((r) => {
    const online = ctx.services.runners.isOnline(r.workstation_id);
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      workstation: { id: r.workstation_id, name: r.ws_name, online },
      health: online
        ? {
            state: r.state ?? 'pending',
            errorCode: code(r.error_code),
            message: r.message ?? null,
            checkedAt: iso(r.checked_at),
            lastOkAt: iso(r.last_ok_at),
          }
        : {
            state: 'runner_offline' as const,
            errorCode: 'runner_offline' as const,
            message: 'The workstation is offline.',
            checkedAt: iso(r.checked_at),
            lastOkAt: iso(r.last_ok_at),
          },
      createdAt: iso(r.created_at) as string,
      canConnect: r.ws_user === userId,
    };
  });
}

export async function createStorageConnection(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  body: StorageConnectionCreate,
): Promise<StorageConnectionDto> {
  await ownWorkstation(ctx, user.id, body.workstationId);
  if (!(await supportsStorage(ctx, body.workstationId)))
    throw conflict('runner_too_old', 'update the runner on this workstation to use storage connections');
  const id = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.storageConnection(id),
          event: {
            type: 'StorageConnectionCreated',
            payload: {
              connectionId: id,
              orgId,
              kind: body.kind,
              label: body.label,
              workstationId: body.workstationId,
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    await exec(
      tx,
      `INSERT INTO storage_connection_health (connection_id, state, checked_at) VALUES ($1,'pending',$2)
       ON CONFLICT (connection_id) DO NOTHING`,
      [id, ctx.clock.now()],
    );
  });
  const dto = (await listStorageConnections(ctx, orgId, user.id)).find((c) => c.id === id);
  if (!dto) throw notFound('storage connection not found');
  return dto;
}

export async function renameStorageConnection(
  ctx: Ctx,
  userId: string,
  orgId: string,
  id: string,
  label: string,
): Promise<void> {
  await ownConnection(ctx, orgId, id);
  await ctx.store.append([
    {
      streamId: streamId.storageConnection(id),
      event: { type: 'StorageConnectionRenamed', payload: { connectionId: id, label, by: userId } },
      actor: userActor(userId),
      scope: orgScope(orgId),
    },
  ]);
}

export async function removeStorageConnection(ctx: Ctx, userId: string, orgId: string, id: string): Promise<void> {
  const c = await ownConnection(ctx, orgId, id);
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.storageConnection(id),
          event: { type: 'StorageConnectionRemoved', payload: { connectionId: id, by: userId } },
          actor: userActor(userId),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    // Delivered whenever the workstation next connects (no expiry): the token must be deleted there.
    await enqueueRunnerCommand(tx, c.workstation_id, 'storage.remove', { connectionId: id });
    // Forget any pending sealed command of this connection.
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='removed'
        WHERE workstation_id=$1 AND type IN ('storage.connect','storage.auth.begin') AND status='pending'
          AND payload->>'connectionId'=$2`,
      [c.workstation_id, id],
    );
  });
  deliver(ctx, [c.workstation_id]);
}

// ------------------------------------------------------------------------------------------------ requests

async function insertRequest(
  ctx: Ctx,
  tx: Parameters<Parameters<typeof withAppendTx>[1]>[0],
  r: { id: string; connectionId: string; workstationId: string; userId: string; op: string },
  commandId: string | null,
  ttlMs: number,
): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    tx,
    `INSERT INTO storage_requests (id, connection_id, workstation_id, user_id, op, state, command_id, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$7,$8)`,
    [r.id, r.connectionId, r.workstationId, r.userId, r.op, commandId, now, new Date(now.getTime() + ttlMs)],
  );
}

export async function requestStorageConnect(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  id: string,
  body: { requestId: string; envelope: Record<string, unknown> },
): Promise<{ id: string; state: string }> {
  const c = await gate(ctx, user, orgId, id);
  if (STORAGE_OAUTH_KINDS.includes(c.kind as never))
    throw unprocessable('invalid_storage_request', 'this kind signs in with a code, not with typed values');
  await withAppendTx(ctx.pool, async (tx) => {
    if (await one(tx, 'SELECT 1 AS x FROM storage_requests WHERE id=$1', [body.requestId]))
      throw conflict('request_exists', 'this request was already sent: enter the values again');
    const commandId = await enqueueRunnerCommand(
      tx,
      c.workstation_id,
      'storage.connect',
      { requestId: body.requestId, connectionId: id, kind: c.kind, envelope: body.envelope },
      new Date(ctx.clock.now().getTime() + ENVELOPE_TTL_MS),
    );
    await insertRequest(
      ctx,
      tx,
      { id: body.requestId, connectionId: id, workstationId: c.workstation_id, userId: user.id, op: 'connect' },
      commandId,
      REQUEST_TTL_MS + 5 * 60_000,
    );
  });
  deliver(ctx, [c.workstation_id]);
  return { id: body.requestId, state: 'pending' };
}

/** Starts a sign-in (also the Reconnect action). */
export async function requestStorageAuth(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  id: string,
  options: { siteUrl?: string | undefined; baseFolder?: string | undefined },
): Promise<{ sessionId: string }> {
  const c = await gate(ctx, user, orgId, id);
  if (!STORAGE_OAUTH_KINDS.includes(c.kind as never))
    throw unprocessable('invalid_storage_request', 'this kind does not sign in with a code');
  const sessionId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await exec(
      tx,
      `UPDATE storage_requests SET state='cancelled', updated_at=$2
        WHERE connection_id=$1 AND op='auth' AND state IN ('pending','awaiting_user')`,
      [id, ctx.clock.now()],
    );
    const commandId = await enqueueRunnerCommand(
      tx,
      c.workstation_id,
      'storage.auth.begin',
      {
        sessionId,
        connectionId: id,
        kind: c.kind,
        options: {
          ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
          ...(options.baseFolder ? { baseFolder: options.baseFolder } : {}),
        },
      },
      new Date(ctx.clock.now().getTime() + ENVELOPE_TTL_MS),
    );
    await insertRequest(
      ctx,
      tx,
      { id: sessionId, connectionId: id, workstationId: c.workstation_id, userId: user.id, op: 'auth' },
      commandId,
      DEVICE_TTL_MS,
    );
  });
  deliver(ctx, [c.workstation_id]);
  return { sessionId };
}

export async function cancelStorageAuth(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  id: string,
  sessionId: string,
): Promise<void> {
  const c = await ownConnection(ctx, orgId, id);
  await ownWorkstation(ctx, user.id, c.workstation_id);
  await exec(
    ctx.pool,
    `UPDATE storage_requests SET state='cancelled', updated_at=$3
      WHERE id=$1 AND connection_id=$2 AND op='auth' AND state IN ('pending','awaiting_user')`,
    [sessionId, id, ctx.clock.now()],
  );
  await withAppendTx(ctx.pool, async (tx) => {
    await enqueueRunnerCommand(tx, c.workstation_id, 'storage.auth.cancel', { sessionId });
  });
  deliver(ctx, [c.workstation_id]);
}

export async function requestStorageTest(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  id: string,
  requestId: string,
): Promise<{ id: string; state: string }> {
  const c = await gate(ctx, user, orgId, id);
  await withAppendTx(ctx.pool, async (tx) => {
    if (await one(tx, 'SELECT 1 AS x FROM storage_requests WHERE id=$1', [requestId]))
      throw conflict('request_exists', 'this request was already sent');
    const commandId = await enqueueRunnerCommand(
      tx,
      c.workstation_id,
      'storage.test',
      { requestId, connectionId: id },
      new Date(ctx.clock.now().getTime() + 2 * 60_000),
    );
    await insertRequest(
      ctx,
      tx,
      { id: requestId, connectionId: id, workstationId: c.workstation_id, userId: user.id, op: 'test' },
      commandId,
      3 * 60_000,
    );
  });
  deliver(ctx, [c.workstation_id]);
  return { id: requestId, state: 'pending' };
}

export async function getStorageRequest(ctx: Ctx, userId: string, rid: string): Promise<StorageRequestDto> {
  const r = await one(
    ctx.pool,
    `SELECT id, op, state, prompt, error_code, message FROM storage_requests WHERE id=$1 AND user_id=$2`,
    [rid, userId],
  );
  if (!r) throw notFound('request not found');
  return {
    id: r.id,
    op: r.op,
    state: r.state,
    prompt: r.prompt ?? null,
    errorCode: code(r.error_code),
    message: r.message ?? null,
  };
}

// ------------------------------------------------------------------------------------------------ from the runner

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : null);

/** Writes the health the runner reported. Only for connections of that workstation. */
export async function applyStorageReport(
  ctx: Ctx,
  workstationId: string,
  list: StorageHealthReport[],
): Promise<void> {
  for (const h of list) {
    await exec(
      ctx.pool,
      `INSERT INTO storage_connection_health (connection_id, state, error_code, message, checked_at, last_ok_at)
       SELECT c.id, $2, $3, $4, $5, CASE WHEN $2='connected' THEN $5 ELSE NULL END
         FROM storage_connections c WHERE c.id=$1 AND c.workstation_id=$6 AND c.status='active'
       ON CONFLICT (connection_id) DO UPDATE SET state=EXCLUDED.state, error_code=EXCLUDED.error_code,
         message=EXCLUDED.message, checked_at=EXCLUDED.checked_at,
         last_ok_at=COALESCE(EXCLUDED.last_ok_at, storage_connection_health.last_ok_at)`,
      [h.connectionId, h.state, h.errorCode ?? null, clip(h.message, 300), new Date(h.checkedAt), workstationId],
    );
  }
}

/** A write succeeded or failed with a health-relevant error: the only thing a write leaves in the database. */
export async function recordWriteOutcome(
  ctx: Ctx,
  connectionId: string,
  outcome: { ok: true } | { ok: false; error: StorageWriteError },
): Promise<void> {
  const now = ctx.clock.now();
  if (outcome.ok) {
    await exec(
      ctx.pool,
      `UPDATE storage_connection_health SET last_ok_at=$2,
              state=CASE WHEN state='pending' THEN state ELSE 'connected' END
        WHERE connection_id=$1`,
      [connectionId, now],
    );
    return;
  }
  const state =
    outcome.error.code === 'auth_expired'
      ? 'needs_reauth'
      : outcome.error.code === 'permission'
        ? 'permission'
        : outcome.error.code === 'quota'
          ? 'quota'
          : null;
  if (!state) return;
  await exec(
    ctx.pool,
    `UPDATE storage_connection_health SET state=$2, error_code=$3, message=$4, checked_at=$5 WHERE connection_id=$1`,
    [connectionId, state, outcome.error.code, outcome.error.message.slice(0, 300), now],
  );
}

export async function applyStorageAuth(
  ctx: Ctx,
  workstationId: string,
  msg: {
    sessionId: string;
    connectionId: string;
    state: string;
    prompt?: { userCode: string; verificationUri: string; expiresAt: string } | undefined;
    error?: StorageWriteError | undefined;
  },
): Promise<void> {
  const state = msg.state === 'done' ? 'done' : msg.state;
  await exec(
    ctx.pool,
    `UPDATE storage_requests SET state=$3, prompt=COALESCE($4::jsonb, prompt), error_code=$5, message=$6, updated_at=$7
      WHERE id::text=$1 AND connection_id::text=$2 AND workstation_id=$8 AND op='auth'
        AND state NOT IN ('done','failed','cancelled','expired')`,
    [
      msg.sessionId,
      msg.connectionId,
      state,
      msg.prompt ? JSON.stringify(msg.prompt) : null,
      msg.error?.code ?? null,
      clip(msg.error?.message, 300),
      ctx.clock.now(),
      workstationId,
    ],
  );
}

/** `command.result` of a `storage.*` command: forget the payload (it may hold ciphertext) and record the answer. */
export async function applyStorageCommandResult(
  ctx: Ctx,
  workstationId: string,
  cmd: { id: string; type: string; payload: Record<string, unknown> },
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [cmd.id]);
  const r = (ok && result && typeof result === 'object' ? result : {}) as {
    error?: { code?: string; message?: string };
    health?: StorageHealthReport;
    prompt?: { userCode: string; verificationUri: string; expiresAt: string };
  };
  const failure = r.error?.message ?? (!ok ? (error ?? 'the workstation could not do this') : undefined);
  const now = ctx.clock.now();
  const req = await one(
    ctx.pool,
    `SELECT id, state FROM storage_requests WHERE command_id=$1 AND workstation_id=$2`,
    [cmd.id, workstationId],
  );
  if (!req || TERMINAL.has(req.state)) return;
  if (cmd.type === 'storage.auth.begin') {
    if (failure)
      await exec(
        ctx.pool,
        `UPDATE storage_requests SET state='failed', error_code=$2, message=$3, updated_at=$4 WHERE id=$1`,
        [req.id, code(r.error?.code) ?? 'unavailable', clip(failure, 300), now],
      );
    else if (r.prompt)
      await exec(
        ctx.pool,
        `UPDATE storage_requests SET state='awaiting_user', prompt=$2::jsonb, updated_at=$3 WHERE id=$1`,
        [req.id, JSON.stringify(r.prompt), now],
      );
    return; // the runner's storage.auth messages finish it
  }
  await exec(
    ctx.pool,
    `UPDATE storage_requests SET state=$2, error_code=$3, message=$4, updated_at=$5 WHERE id=$1`,
    [req.id, failure ? 'failed' : 'done', failure ? (code(r.error?.code) ?? 'unavailable') : null, clip(failure, 300), now],
  );
}

/** After `welcome`: tells the workstation which connections it should hold, so a removal made offline still deletes the token. */
export async function sendStorageSync(ctx: Ctx, workstationId: string): Promise<void> {
  const ids = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM storage_connections WHERE workstation_id=$1 AND status='active'`,
    [workstationId],
  );
  if (!(await supportsStorage(ctx, workstationId))) return;
  await exec(
    ctx.pool,
    `UPDATE runner_commands SET status='failed', last_error='replaced'
      WHERE workstation_id=$1 AND type='storage.sync' AND status='pending'`,
    [workstationId],
  );
  await enqueueRunnerCommand(ctx.pool, workstationId, 'storage.sync', { connectionIds: ids.map((i) => i.id) });
  deliver(ctx, [workstationId]);
}

/** Expires what ran out and deletes requests older than a day. */
export async function pruneStorage(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `UPDATE storage_requests SET state='expired', message=COALESCE(message,'This took too long. Try again.'), updated_at=$1
      WHERE expires_at < $1 AND state NOT IN ('done','failed','cancelled','expired')`,
    [now],
  );
  await exec(ctx.pool, `DELETE FROM storage_requests WHERE created_at < $1`, [new Date(now.getTime() - 24 * 3_600_000)]);
}
