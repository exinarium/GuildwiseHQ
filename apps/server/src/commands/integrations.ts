import { randomUUID } from 'node:crypto';
import {
  checkIntegrationRequest,
  ENVELOPE_COMMANDS,
  ENVELOPE_TTL_MS,
  type IntegrationActionRequest,
  type IntegrationCommandResult,
  IntegrationCommandResultSchema,
  type IntegrationConnectRequest,
  type IntegrationInputRequest,
  type IntegrationRequestDto,
  IntegrationSessionMsgSchema,
  type IntegrationSessionRequest,
  type IntegrationStatus,
  IntegrationStatusSchema,
  IntegrationsPolicySchema,
  type IntegrationWorkstationSummary,
  integrationKind,
  integrationsSupportedBy,
  MAX_INTEGRATION_STATUSES,
  type RunnerCommandName,
  streamId,
  type WorkstationIntegrationsResponse,
} from '@aom/shared';
import { z } from 'zod';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { userActor, userScope } from './common.ts';
import { deliver } from './workstation-setup.ts';

/**
 * The Integrations page (docs/design/integrations-page.md). The server stores facts the runner reports and relays sealed
 * envelopes: it never holds a token, key or code in the clear, never logs the envelope, and empties the command payload as
 * soon as the runner answered (or after ten minutes).
 */

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const TERMINAL = new Set(['done', 'connected', 'failed', 'cancelled', 'expired']);
const MAX_SESSION_INPUTS = 3;
const REQUEST_TTL_MS = 10 * 60_000;

// ------------------------------------------------------------------------------------------------ ownership

interface OwnWs {
  id: string;
  name: string;
  integrations_version: number | null;
  integrations_policy: unknown;
  runner_version: string | null;
}

/** The workstation of this user (active). Anyone else gets a 404, as with sudo and git ssh. */
async function ownWorkstation(ctx: Ctx, userId: string, workstationId: string): Promise<OwnWs> {
  const w = await one<OwnWs>(
    ctx.pool,
    `SELECT id, name, integrations_version, integrations_policy, runner_version FROM workstations
      WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, userId],
  );
  if (!w) throw notFound('workstation not found');
  return w;
}

async function keyOf(ctx: Ctx, workstationId: string) {
  const k = await one<{ key_id: string; public_key: string }>(
    ctx.pool,
    'SELECT key_id, public_key FROM workstation_keys WHERE workstation_id=$1',
    [workstationId],
  );
  return k ? { keyId: k.key_id, publicKey: k.public_key } : null;
}

// ------------------------------------------------------------------------------------------------ reports

/** `integrations.report`: replaces the facts held for the workstation. Invalid entries are dropped. */
export async function applyIntegrationsReport(
  ctx: Ctx,
  workstationId: string,
  report: unknown,
): Promise<void> {
  const parsed = z
    .object({
      integrations: z.array(z.unknown()).max(MAX_INTEGRATION_STATUSES),
      policy: IntegrationsPolicySchema.optional(),
    })
    .safeParse(report);
  if (!parsed.success) return;
  const statuses = parsed.data.integrations.flatMap((s) => {
    const p = IntegrationStatusSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });
  const now = ctx.clock.now();
  await withAppendTx(ctx.pool, async (tx) => {
    await exec(tx, 'DELETE FROM workstation_integrations WHERE workstation_id=$1', [workstationId]);
    for (const s of statuses)
      await exec(
        tx,
        `INSERT INTO workstation_integrations (workstation_id, kind, instance, status, checked_at)
         VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (workstation_id, kind, instance) DO UPDATE
           SET status=EXCLUDED.status, checked_at=EXCLUDED.checked_at`,
        [workstationId, s.kind, s.instance, JSON.stringify(s), s.checkedAt],
      );
    await exec(
      tx,
      `UPDATE workstations SET integrations_policy=$2::jsonb, integrations_checked_at=$3 WHERE id=$1`,
      [workstationId, parsed.data.policy ? JSON.stringify(parsed.data.policy) : null, now],
    );
  });
}

async function upsertStatus(ctx: Ctx, workstationId: string, s: IntegrationStatus): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO workstation_integrations (workstation_id, kind, instance, status, checked_at)
     VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (workstation_id, kind, instance) DO UPDATE
       SET status=EXCLUDED.status, checked_at=EXCLUDED.checked_at`,
    [workstationId, s.kind, s.instance, JSON.stringify(s), s.checkedAt],
  );
}

async function audit(
  ctx: Ctx,
  workstationId: string,
  userId: string,
  event:
    | {
        type: 'WorkstationIntegrationConnected';
        kind: string;
        instance: string;
        method?: string;
        account?: string;
      }
    | { type: 'WorkstationIntegrationRemoved'; kind: string; instance: string }
    | { type: 'WorkstationIntegrationSignInStarted'; kind: string; instance: string; method: string },
): Promise<void> {
  const { type, ...rest } = event;
  await ctx.store.append([
    {
      streamId: streamId.workstation(workstationId),
      event: { type, payload: { workstationId, by: userId, ...rest } } as never,
      actor: userActor(userId),
      scope: userScope(userId),
    },
  ]);
}

// ------------------------------------------------------------------------------------------------ sessions from the runner

/** `integration.session`: progress of an interactive sign-in. */
export async function applyIntegrationSession(ctx: Ctx, workstationId: string, msg: unknown): Promise<void> {
  const parsed = IntegrationSessionMsgSchema.safeParse(msg);
  if (!parsed.success) return;
  const m = parsed.data;
  const req = await one(
    ctx.pool,
    `SELECT id, user_id, state, kind, instance, method FROM integration_requests
      WHERE id::text=$1 AND workstation_id=$2 AND op='session'`,
    [m.sessionId, workstationId],
  );
  if (!req) return;
  if (TERMINAL.has(req.state)) return;
  // a sign-in the runner calls connected carries the status; the tile shows it at once
  await exec(
    ctx.pool,
    `UPDATE integration_requests SET state=$2, prompt=$3::jsonb, status=$4::jsonb, error=$5, updated_at=$6 WHERE id=$1`,
    [
      req.id,
      m.state,
      m.prompt ? JSON.stringify(m.prompt) : null,
      m.status ? JSON.stringify(m.status) : null,
      m.error ?? null,
      ctx.clock.now(),
    ],
  );
  if (m.state === 'connected' && m.status) {
    await upsertStatus(ctx, workstationId, m.status);
    await audit(ctx, workstationId, req.user_id, {
      type: 'WorkstationIntegrationConnected',
      kind: m.kind,
      instance: m.instance,
      ...(req.method ? { method: req.method } : {}),
      ...(m.status.account ? { account: m.status.account } : {}),
    });
  }
}

// ------------------------------------------------------------------------------------------------ command results

/** `command.result` of `integration.*`: forget the payload (it may hold ciphertext), record the answer. Terminal. */
export async function applyIntegrationCommandResult(
  ctx: Ctx,
  workstationId: string,
  cmd: { id: string; type: RunnerCommandName; payload: Record<string, unknown> },
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [cmd.id]);
  const parsed = ok ? IntegrationCommandResultSchema.safeParse(result) : null;
  const res: IntegrationCommandResult = parsed?.success ? parsed.data : {};
  const failure =
    res.error ??
    (!ok
      ? (error ?? 'the workstation could not do this').slice(0, 300)
      : parsed && !parsed.success
        ? 'the workstation sent an answer this server could not read'
        : undefined);
  const now = ctx.clock.now();
  const req = await one(
    ctx.pool,
    `SELECT id, user_id, kind, instance, op, method, state FROM integration_requests WHERE command_id=$1 AND workstation_id=$2`,
    [cmd.id, workstationId],
  );
  if (cmd.type === 'integration.cancel') return;
  if (cmd.type === 'integration.input') {
    // the paste is answered; the session itself reports what follows. A refusal is shown on the session.
    const sid = String(cmd.payload.sessionId ?? '');
    if (failure && sid)
      await exec(
        ctx.pool,
        `UPDATE integration_requests SET error=$2, updated_at=$3,
                state = CASE WHEN $4 IN ('expired','key') THEN 'failed' ELSE state END
          WHERE id::text=$1 AND workstation_id=$5 AND state NOT IN ('done','connected','failed','cancelled','expired')`,
        [sid, failure.slice(0, 300), now, res.code ?? '', workstationId],
      );
    return;
  }
  if (!req || TERMINAL.has(req.state)) return;
  if (cmd.type === 'integration.begin') {
    if (failure)
      await exec(
        ctx.pool,
        `UPDATE integration_requests SET state='failed', error=$2, updated_at=$3 WHERE id=$1`,
        [req.id, failure.slice(0, 300), now],
      );
    return; // accepted: the runner's session messages drive the state
  }
  // connect, test, remove: one answer
  const status = res.status;
  await exec(
    ctx.pool,
    `UPDATE integration_requests SET state=$2, status=$3::jsonb, error=$4, updated_at=$5 WHERE id=$1`,
    [
      req.id,
      failure ? 'failed' : 'done',
      status ? JSON.stringify(status) : null,
      failure ? failure.slice(0, 300) : null,
      now,
    ],
  );
  if (status) await upsertStatus(ctx, workstationId, status);
  if (!failure && cmd.type === 'integration.connect')
    await audit(ctx, workstationId, req.user_id, {
      type: 'WorkstationIntegrationConnected',
      kind: req.kind,
      instance: req.instance,
      ...(req.method ? { method: req.method } : {}),
      ...(status?.account ? { account: status.account } : {}),
    });
  if (!failure && cmd.type === 'integration.remove')
    await audit(ctx, workstationId, req.user_id, {
      type: 'WorkstationIntegrationRemoved',
      kind: req.kind,
      instance: req.instance,
    });
}

// ------------------------------------------------------------------------------------------------ expiry

/**
 * Once a minute: sealed commands nobody collected are emptied and failed, requests that ran out are marked expired, and
 * requests older than a day are deleted.
 */
export async function sweepIntegrations(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const dead = await rows<{ id: string }>(
    ctx.pool,
    `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='expired'
      WHERE type = ANY($1::text[]) AND status IN ('pending','sent') AND expires_at IS NOT NULL AND expires_at < $2
      RETURNING id`,
    [[...ENVELOPE_COMMANDS], now],
  );
  if (dead.length > 0)
    await exec(
      ctx.pool,
      `UPDATE integration_requests SET state='expired', error='The workstation did not pick this up in time. Try again.', updated_at=$2
        WHERE command_id = ANY($1::uuid[]) AND state NOT IN ('done','connected','failed','cancelled','expired')`,
      [dead.map((d) => d.id), now],
    );
  await exec(
    ctx.pool,
    `UPDATE integration_requests SET state='expired', error=COALESCE(error, 'This took too long. Try again.'), updated_at=$1
      WHERE expires_at < $1 AND state NOT IN ('done','connected','failed','cancelled','expired')`,
    [now],
  );
  await exec(ctx.pool, `DELETE FROM integration_requests WHERE created_at < $1`, [
    new Date(now.getTime() - 24 * 3_600_000),
  ]);
}

// ------------------------------------------------------------------------------------------------ reading

const requestDto = (r: any): IntegrationRequestDto => ({
  id: r.id,
  op: r.op,
  kind: r.kind,
  instance: r.instance,
  method: r.method ?? null,
  state: r.state,
  prompt: r.prompt ?? null,
  status: r.status ?? null,
  error: r.error ?? null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  expiresAt: iso(r.expires_at),
});

/** Statuses an older runner's reports imply (read-only): git, Jira, MCP servers and the Claude login. */
export function legacyIntegrations(w: Record<string, any>, now: Date): IntegrationStatus[] {
  const out: IntegrationStatus[] = [];
  const at = now.toISOString();
  for (const c of (w.git_connections ?? []) as any[]) {
    const kind = c.provider as IntegrationStatus['kind'];
    if (!integrationKind(kind)) continue;
    const state =
      c.state === 'connected'
        ? 'connected'
        : c.state === 'unavailable'
          ? 'unavailable'
          : c.problem === 'token_refused'
            ? 'refused'
            : c.problem === 'unreachable'
              ? 'unreachable'
              : 'not_connected';
    const instance = kind === 'github' || kind === 'gitlab' ? String(c.host) : '';
    out.push({
      kind,
      instance,
      state,
      scope: kind === 'github' ? 'machine' : 'workstation',
      checkedAt: c.checkedAt ?? at,
      ...(c.method && c.method !== 'ssh' ? { method: String(c.method) } : {}),
      ...(c.account ? { account: String(c.account) } : {}),
      ...(c.detail ? { detail: String(c.detail).slice(0, 400) } : {}),
    });
    if (c.ssh)
      out.push({
        kind: 'ssh',
        instance: `${kind}@${c.host}`,
        state: c.ssh.check?.state === 'ok' ? 'connected' : 'not_connected',
        scope: 'machine',
        checkedAt: c.ssh.check?.checkedAt ?? c.checkedAt ?? at,
        site: String(c.host),
        method: 'ssh',
        ...(c.ssh.publicKey ? { publicKey: String(c.ssh.publicKey) } : {}),
        ...(c.ssh.check?.detail ? { detail: String(c.ssh.check.detail).slice(0, 400) } : {}),
      });
  }
  const j = w.jira_status;
  out.push({
    kind: 'jira',
    instance: '',
    state: j?.state === 'connected' ? 'connected' : j?.state === 'refused' ? 'refused' : 'not_connected',
    scope: 'workstation',
    checkedAt: iso(w.jira_checked_at ?? now),
    ...(j?.account ? { account: String(j.account) } : {}),
    ...(j?.baseUrl ? { site: String(j.baseUrl) } : {}),
    ...(j?.detail ? { detail: String(j.detail).slice(0, 400) } : {}),
  });
  for (const s of (w.mcp_servers ?? []) as any[])
    out.push({
      kind: 'mcp',
      instance: String(s.name),
      state:
        s.authState === 'signed_in'
          ? 'connected'
          : s.authState === 'needs_sign_in'
            ? 'needs_sign_in'
            : s.authState === 'not_needed'
              ? 'not_needed'
              : 'not_connected',
      scope: 'machine',
      checkedAt: iso(w.mcp_servers_checked_at ?? now),
      ...(s.host ? { site: String(s.host) } : {}),
    });
  const claude = ((w.runtimes ?? []) as any[]).find((r) => r.id === 'claude-code');
  if (claude)
    out.push({
      kind: 'claude-code',
      instance: '',
      state: !claude.available ? 'unavailable' : claude.auth === 'expired' ? 'expired' : 'connected',
      scope: 'machine',
      checkedAt: at,
      ...(claude.auth === 'expired' ? { detail: 'The Claude login expired.' } : {}),
    });
  return out;
}

export async function readWorkstationIntegrations(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<WorkstationIntegrationsResponse> {
  const w = await ownWorkstation(ctx, user.id, workstationId);
  const full = await one(ctx.pool, 'SELECT * FROM workstations WHERE id=$1', [workstationId]);
  const now = ctx.clock.now();
  const legacy = w.integrations_version === null;
  const stored = legacy
    ? []
    : (
        await rows(
          ctx.pool,
          'SELECT status FROM workstation_integrations WHERE workstation_id=$1 ORDER BY kind, instance',
          [workstationId],
        )
      ).flatMap((r) => {
        const p = IntegrationStatusSchema.safeParse(r.status);
        return p.success ? [p.data] : [];
      });
  const sessions = await rows(
    ctx.pool,
    `SELECT * FROM integration_requests WHERE workstation_id=$1 AND user_id=$2 AND op='session'
        AND state NOT IN ('done','connected','failed','cancelled','expired') AND expires_at > $3 ORDER BY created_at DESC LIMIT 10`,
    [workstationId, user.id, now],
  );
  const policy = IntegrationsPolicySchema.safeParse(w.integrations_policy);
  return {
    workstation: { id: w.id, name: w.name },
    key: await keyOf(ctx, workstationId),
    serverTime: now.toISOString(),
    runner: {
      connected: ctx.services.runners.isOnline(workstationId),
      version: w.runner_version,
      integrationsVersion: w.integrations_version,
      policy: policy.success ? policy.data : null,
    },
    integrations: legacy ? legacyIntegrations(full ?? {}, now) : stored,
    activeSessions: sessions.map(requestDto),
    legacy,
  };
}

const needsAttention = (s: IntegrationStatus): boolean =>
  s.state === 'refused' || s.state === 'expired' || s.state === 'needs_sign_in' || s.state === 'unreachable';

export async function listIntegrationWorkstations(
  ctx: Ctx,
  user: AuthSession['user'],
): Promise<IntegrationWorkstationSummary[]> {
  const ws = await rows(
    ctx.pool,
    `SELECT * FROM workstations WHERE user_id=$1 AND status='active' ORDER BY last_seen_at DESC NULLS LAST, name`,
    [user.id],
  );
  const out: IntegrationWorkstationSummary[] = [];
  for (const w of ws) {
    const list =
      w.integrations_version === null
        ? legacyIntegrations(w, ctx.clock.now())
        : (
            await rows(ctx.pool, 'SELECT status FROM workstation_integrations WHERE workstation_id=$1', [
              w.id,
            ])
          ).flatMap((r) => {
            const p = IntegrationStatusSchema.safeParse(r.status);
            return p.success ? [p.data] : [];
          });
    out.push({
      id: w.id,
      name: w.name,
      connected: ctx.services.runners.isOnline(w.id),
      lastSeenAt: w.last_seen_at ? iso(w.last_seen_at) : null,
      needsAttention: list.filter(needsAttention).length,
      total: list.length,
    });
  }
  return out;
}

export async function readIntegrationRequest(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  requestId: string,
): Promise<IntegrationRequestDto> {
  const r = await one(
    ctx.pool,
    `SELECT * FROM integration_requests WHERE id=$1 AND workstation_id=$2 AND user_id=$3`,
    [requestId, workstationId, user.id],
  );
  if (!r) throw notFound('request not found');
  const late = !TERMINAL.has(r.state) && new Date(r.expires_at).getTime() < ctx.clock.now().getTime();
  return requestDto(late ? { ...r, state: 'expired' } : r);
}

// ------------------------------------------------------------------------------------------------ requests from the page

async function gate(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  kindId: string,
  instance: string,
  method: string,
  flow: 'fields' | 'interactive',
  keyId?: string,
): Promise<OwnWs> {
  const w = await ownWorkstation(ctx, user.id, workstationId);
  const bad = checkIntegrationRequest(kindId, instance, method, flow);
  if (bad) throw unprocessable('invalid_integration_request', bad);
  const kind = integrationKind(kindId);
  if (!kind) throw unprocessable('invalid_integration_request', 'unknown integration');
  if (!ctx.services.runners.isOnline(workstationId))
    throw conflict('workstation_offline', 'this workstation is offline: start its runner and try again');
  if (!integrationsSupportedBy(w.integrations_version, kind))
    throw conflict(
      'runner_too_old',
      `update the runner to ${kind.minRunner} or newer to connect this from here; until then run: ${kind.cli}`,
    );
  if (keyId !== undefined) {
    const k = await keyOf(ctx, workstationId);
    if (!k || k.keyId !== keyId)
      throw conflict(
        'runner_key_changed',
        "the runner's key changed: reload the page and enter the values again",
      );
  }
  return w;
}

async function insertRequest(
  ctx: Ctx,
  tx: Parameters<Parameters<typeof withAppendTx>[1]>[0],
  r: {
    id: string;
    workstationId: string;
    userId: string;
    kind: string;
    instance: string;
    op: string;
    method?: string;
  },
  commandId: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    tx,
    `INSERT INTO integration_requests (id, workstation_id, user_id, kind, instance, op, method, state, command_id, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$9,$10)`,
    [
      r.id,
      r.workstationId,
      r.userId,
      r.kind,
      r.instance,
      r.op,
      r.method ?? null,
      commandId,
      now,
      new Date(now.getTime() + REQUEST_TTL_MS + 5 * 60_000),
    ],
  );
}

/** Drops an earlier undelivered envelope command for the same target (only the latest is relayed). */
async function dropEarlier(
  tx: Parameters<Parameters<typeof withAppendTx>[1]>[0],
  workstationId: string,
  type: string,
  kind: string,
  instance: string,
) {
  const old = await rows<{ id: string }>(
    tx,
    `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='replaced'
      WHERE workstation_id=$1 AND type=$2 AND status='pending' AND payload->>'kind'=$3 AND payload->>'instance'=$4 RETURNING id`,
    [workstationId, type, kind, instance],
  );
  if (old.length)
    await exec(
      tx,
      `UPDATE integration_requests SET state='failed', error='Replaced by a newer request.', updated_at=now()
        WHERE command_id = ANY($1::uuid[]) AND state='pending'`,
      [old.map((o) => o.id)],
    );
}

export async function requestConnect(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: IntegrationConnectRequest,
): Promise<{ id: string; state: string }> {
  await gate(ctx, user, workstationId, body.kind, body.instance, body.method, 'fields', body.envelope.keyId);
  await withAppendTx(ctx.pool, async (tx) => {
    if (await one(tx, 'SELECT 1 AS x FROM integration_requests WHERE id=$1', [body.requestId]))
      throw conflict('request_exists', 'this request was already sent: enter the values again');
    await dropEarlier(tx, workstationId, 'integration.connect', body.kind, body.instance);
    const commandId = await enqueueRunnerCommand(
      tx,
      workstationId,
      'integration.connect',
      {
        requestId: body.requestId,
        kind: body.kind,
        instance: body.instance,
        method: body.method,
        envelope: body.envelope,
      },
      new Date(ctx.clock.now().getTime() + ENVELOPE_TTL_MS),
    );
    await insertRequest(
      ctx,
      tx,
      {
        id: body.requestId,
        workstationId,
        userId: user.id,
        kind: body.kind,
        instance: body.instance,
        op: 'connect',
        method: body.method,
      },
      commandId,
    );
  });
  deliver(ctx, [workstationId]);
  return { id: body.requestId, state: 'pending' };
}

export async function requestSession(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: IntegrationSessionRequest,
): Promise<{ id: string; state: string }> {
  await gate(ctx, user, workstationId, body.kind, body.instance, body.method, 'interactive');
  const sessionId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const live = await one(
      tx,
      `SELECT id FROM integration_requests WHERE workstation_id=$1 AND op='session' AND kind=$2 AND instance=$3
          AND state NOT IN ('done','connected','failed','cancelled','expired') AND expires_at > $4`,
      [workstationId, body.kind, body.instance, ctx.clock.now()],
    );
    if (live)
      throw conflict('session_busy', 'a sign-in for this is already running: finish or cancel it first');
    const commandId = await enqueueRunnerCommand(tx, workstationId, 'integration.begin', {
      sessionId,
      kind: body.kind,
      instance: body.instance,
      method: body.method,
      ...(body.pre ? { pre: body.pre } : {}),
    });
    await insertRequest(
      ctx,
      tx,
      {
        id: sessionId,
        workstationId,
        userId: user.id,
        kind: body.kind,
        instance: body.instance,
        op: 'session',
        method: body.method,
      },
      commandId,
    );
  });
  await audit(ctx, workstationId, user.id, {
    type: 'WorkstationIntegrationSignInStarted',
    kind: body.kind,
    instance: body.instance,
    method: body.method,
  });
  deliver(ctx, [workstationId]);
  return { id: sessionId, state: 'pending' };
}

export async function requestSessionInput(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  sessionId: string,
  body: IntegrationInputRequest,
): Promise<{ id: string; state: string }> {
  const req = await one(
    ctx.pool,
    `SELECT * FROM integration_requests WHERE id=$1 AND workstation_id=$2 AND user_id=$3 AND op='session'`,
    [sessionId, workstationId, user.id],
  );
  if (!req) throw notFound('sign-in not found');
  await gate(
    ctx,
    user,
    workstationId,
    req.kind,
    req.instance,
    req.method ?? '',
    'interactive',
    body.envelope.keyId,
  );
  if (req.state !== 'awaiting_code' || new Date(req.expires_at).getTime() < ctx.clock.now().getTime())
    throw conflict('session_not_waiting', 'this sign-in is not waiting for a value now');
  await withAppendTx(ctx.pool, async (tx) => {
    const bumped = await one(
      tx,
      `UPDATE integration_requests SET inputs = inputs + 1, state='completing', error=NULL, updated_at=$2
        WHERE id=$1 AND state='awaiting_code' AND inputs < $3 RETURNING id`,
      [sessionId, ctx.clock.now(), MAX_SESSION_INPUTS],
    );
    if (!bumped) throw conflict('session_not_waiting', 'this sign-in accepts no more values: start it again');
    await enqueueRunnerCommand(
      tx,
      workstationId,
      'integration.input',
      { sessionId, kind: req.kind, instance: req.instance, envelope: body.envelope },
      new Date(ctx.clock.now().getTime() + ENVELOPE_TTL_MS),
    );
  });
  deliver(ctx, [workstationId]);
  return { id: sessionId, state: 'completing' };
}

export async function requestSessionCancel(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  sessionId: string,
): Promise<{ id: string; state: string }> {
  const req = await one(
    ctx.pool,
    `SELECT * FROM integration_requests WHERE id=$1 AND workstation_id=$2 AND user_id=$3 AND op='session'`,
    [sessionId, workstationId, user.id],
  );
  if (!req) throw notFound('sign-in not found');
  if (TERMINAL.has(req.state)) return { id: sessionId, state: req.state };
  await exec(ctx.pool, `UPDATE integration_requests SET state='cancelled', updated_at=$2 WHERE id=$1`, [
    sessionId,
    ctx.clock.now(),
  ]);
  await enqueueRunnerCommand(ctx.pool, workstationId, 'integration.cancel', { sessionId });
  deliver(ctx, [workstationId]);
  return { id: sessionId, state: 'cancelled' };
}

async function requestAction(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  op: 'test' | 'remove',
  body: IntegrationActionRequest,
): Promise<{ id: string; state: string }> {
  const w = await ownWorkstation(ctx, user.id, workstationId);
  const kind = integrationKind(body.kind);
  if (!kind) throw unprocessable('invalid_integration_request', 'unknown integration');
  if (!ctx.services.runners.isOnline(workstationId))
    throw conflict('workstation_offline', 'this workstation is offline: start its runner and try again');
  if (!integrationsSupportedBy(w.integrations_version, kind))
    throw conflict('runner_too_old', `update the runner to ${kind.minRunner} or newer to do this from here`);
  await withAppendTx(ctx.pool, async (tx) => {
    if (await one(tx, 'SELECT 1 AS x FROM integration_requests WHERE id=$1', [body.requestId]))
      throw conflict('request_exists', 'this request was already sent');
    const commandId = await enqueueRunnerCommand(tx, workstationId, `integration.${op}`, {
      requestId: body.requestId,
      kind: body.kind,
      instance: body.instance,
    });
    await insertRequest(
      ctx,
      tx,
      { id: body.requestId, workstationId, userId: user.id, kind: body.kind, instance: body.instance, op },
      commandId,
    );
  });
  deliver(ctx, [workstationId]);
  return { id: body.requestId, state: 'pending' };
}

export const requestTest = (
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: IntegrationActionRequest,
) => requestAction(ctx, user, workstationId, 'test', body);
export const requestRemove = (
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: IntegrationActionRequest,
) => requestAction(ctx, user, workstationId, 'remove', body);
