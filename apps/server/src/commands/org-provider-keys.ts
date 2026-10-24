import { randomUUID } from 'node:crypto';
import {
  BUDGET,
  budgetStatus,
  formatMoney,
  isOrgManager,
  type KeyUseReport,
  ORG_KEY_PROVIDERS,
  type OrgProvider,
  type OrgProvidersResponse,
  PROVIDER_KEY_LABEL,
  PROVIDER_KEYS_BOUND_CAPABILITY,
  type ProviderKeyId,
  ProviderKeyResealResultSchema,
  ProviderKeyResultSchema,
  type ReshareOrgProviderKeyRequest,
  type SetOrgProviderKeyRequest,
  type ShareOrgProviderKeyRequest,
  streamId,
  toMicros,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { providerCapState } from '../provider-keys/caps.ts';
import { dropLiveUsage } from '../provider-keys/live-usage.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Organization-wide provider keys (docs/ARCHITECTURE.md section 38.5). The Owner or an Admin seals the key in the browser to each
 * target workstation's public key (the sudo key); this module stores only those ciphertexts, one per workstation, relays them in
 * the durable command queue, and forgets each copy once its runner stored it. Revocation deletes every copy and sends a clear
 * command to every workstation. Nothing here ever sees a plain key. The monthly cap and its notices mirror the project budgets.
 */
const KEY_TTL_MS = 24 * 3600_000;

/** Desk subkinds of the cap notices (an org-level alert for the Owner and Admins). */
export const PROVIDER_CAP_DESK = { warning: 'provider_cap_warning', paused: 'provider_cap_paused' } as const;

const isProvider = (p: string): p is ProviderKeyId => (ORG_KEY_PROVIDERS as readonly string[]).includes(p);

async function requireManager(db: Queryable, user: AuthSession['user'], orgId: string): Promise<void> {
  const role = await orgRoleOf(db, user.id, orgId);
  if (role === null) throw notFound('organization not found');
  if (!isOrgManager({ orgRole: role }))
    throw forbidden('only the organization Owner and Admins can manage the organization’s provider keys');
}

function assertProvider(provider: string): asserts provider is ProviderKeyId {
  if (!isProvider(provider)) throw badRequest('unknown_provider', 'unknown provider');
}

/** Refuses an endpoint that carries credentials, a query or a non-http scheme (it is shown to admins and logged). */
function checkBaseUrl(provider: ProviderKeyId, raw: string | undefined): string | null {
  const needs = provider === 'openai-compatible' || provider === 'gateway';
  if (!raw?.trim()) {
    if (needs && provider === 'openai-compatible')
      throw badRequest('base_url_required', 'enter the endpoint (base URL)');
    return null;
  }
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    if (u.username || u.password || u.search || u.hash) throw new Error('parts');
    return u.toString().replace(/\/+$/, '');
  } catch {
    throw badRequest(
      'invalid_base_url',
      'the endpoint must be a plain http:// or https:// URL without credentials or query',
    );
  }
}

/** The workstations a key of this organization may be sealed to: active workstations of its active members, serving it. */
async function targetWorkstations(db: Queryable, orgId: string) {
  return rows(
    db,
    `SELECT ws.id, ws.name, ws.runtimes, u.display_name AS owner_name, k.key_id, k.public_key,
            COALESCE($2 = ANY(c.capabilities), false) AS supported
       FROM workstations ws
       JOIN users u ON u.id = ws.user_id AND u.status = 'active'
       JOIN org_members om ON om.user_id = ws.user_id AND om.org_id = $1 AND om.status = 'active'
       LEFT JOIN workstation_keys k ON k.workstation_id = ws.id
       LEFT JOIN workstation_capabilities c ON c.workstation_id = ws.id
      WHERE ws.status = 'active' AND ${wsServesOrgSql('ws', '$1::uuid')}
      ORDER BY u.display_name, ws.name, ws.id`,
    [orgId, PROVIDER_KEYS_BOUND_CAPABILITY],
  );
}

type Target = Awaited<ReturnType<typeof targetWorkstations>>[number];

async function targetOf(db: Queryable, orgId: string, workstationId: string): Promise<Target> {
  const t = (await targetWorkstations(db, orgId)).find((x) => x.id === workstationId);
  if (!t) throw notFound('workstation not found in this organization');
  return t;
}

function assertSealableTo(t: Target, keyId: string): void {
  if (!t.supported)
    throw unprocessable(
      'runner_too_old',
      `update the runner on ${t.name} to share organization keys with it`,
    );
  if (!t.key_id || t.key_id !== keyId)
    throw conflict(
      'sudo_key_changed',
      `the runner key of ${t.name} changed: reload the page and enter the key again`,
    );
}

/**
 * Serialises changes to one organization key (set, share, revoke, reshare) and returns its current generation: the number of
 * times it was set. The browser binds a new key to `generation + 1`, a share of the current key to `generation`.
 */
async function lockGeneration(tx: Tx, orgId: string, provider: string): Promise<number> {
  await exec(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `org-provider-key:${orgId}:${provider}`,
  ]);
  const row = await one(tx, 'SELECT key_generation FROM org_providers WHERE org_id=$1 AND provider=$2', [
    orgId,
    provider,
  ]);
  return Number(row?.key_generation ?? 0);
}

/**
 * A reshare that is waiting for its source runner (or being answered) must not outlive a change to the key: its answer would
 * resurrect a key that was replaced or revoked. Its payload (with the admin's sealed approval) is emptied too.
 */
async function failPendingReshares(tx: Tx, orgId: string, provider: string): Promise<void> {
  await exec(
    tx,
    `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='superseded'
      WHERE type='provider.key.reseal' AND status IN ('pending','sent')
        AND payload->>'orgId' = $1 AND payload->>'provider' = $2`,
    [orgId, provider],
  );
}

/** One key per organization, provider and workstation is pending at a time. */
async function supersedePending(
  tx: Tx,
  workstationId: string,
  orgId: string,
  provider: string,
): Promise<void> {
  await exec(
    tx,
    `UPDATE runner_commands SET status='failed', payload='{}'::jsonb
      WHERE workstation_id=$1 AND type='provider.key.set' AND status IN ('pending','sent')
        AND payload->>'provider' = $3 AND payload->>'orgId' = $2`,
    [workstationId, orgId, provider],
  );
}

async function queueShare(
  ctx: Ctx,
  tx: Tx,
  a: {
    orgId: string;
    provider: ProviderKeyId;
    workstationId: string;
    keyId: string;
    ciphertext: string;
    baseUrl: string | null;
    models: string[];
    /** The generation the blob is bound to (`org_providers.key_generation`). */
    generation: number;
    by: string;
    via: 'browser' | 'runner';
  },
): Promise<void> {
  await supersedePending(tx, a.workstationId, a.orgId, a.provider);
  const commandId = await enqueueRunnerCommand(
    tx,
    a.workstationId,
    'provider.key.set',
    {
      provider: a.provider,
      keyId: a.keyId,
      source: 'org',
      orgId: a.orgId,
      ciphertext: a.ciphertext,
      ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
      models: a.models,
      generation: a.generation,
    },
    new Date(ctx.clock.now().getTime() + KEY_TTL_MS),
  );
  await exec(
    tx,
    `INSERT INTO org_provider_key_shares (org_id, provider, workstation_id, key_id, ciphertext, status, error, via, shared_by, command_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'queued',NULL,$6,$7,$8,$9,$9)
     ON CONFLICT (org_id, provider, workstation_id) DO UPDATE
       SET key_id = EXCLUDED.key_id, ciphertext = EXCLUDED.ciphertext, status = 'queued', error = NULL, via = EXCLUDED.via,
           shared_by = EXCLUDED.shared_by, command_id = EXCLUDED.command_id, updated_at = EXCLUDED.updated_at`,
    [a.orgId, a.provider, a.workstationId, a.keyId, a.ciphertext, a.via, a.by, commandId, ctx.clock.now()],
  );
}

/** `generation` is the one being revoked or replaced: the runner refuses to take it (or an older one) again. */
async function queueClear(
  tx: Tx,
  orgId: string,
  provider: string,
  workstationId: string,
  generation: number,
): Promise<void> {
  await supersedePending(tx, workstationId, orgId, provider);
  await enqueueRunnerCommand(tx, workstationId, 'provider.key.clear', {
    provider,
    source: 'org',
    orgId,
    ...(generation > 0 ? { generation } : {}),
  });
}

// ------------------------------------------------------------------------------------------------ the page

export async function listOrgProviders(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
): Promise<OrgProvidersResponse> {
  await requireManager(ctx.pool, user, orgId);
  const now = ctx.clock.now();
  const targets = await targetWorkstations(ctx.pool, orgId);
  const saved = await rows(
    ctx.pool,
    `SELECT p.*, u.display_name AS set_by_name FROM org_providers p LEFT JOIN users u ON u.id = p.set_by WHERE p.org_id = $1`,
    [orgId],
  );
  const shares = await rows(
    ctx.pool,
    'SELECT provider, workstation_id, key_id, status, error FROM org_provider_key_shares WHERE org_id = $1',
    [orgId],
  );
  const providers: OrgProvider[] = [];
  for (const provider of ORG_KEY_PROVIDERS) {
    const row = saved.find((r) => r.provider === provider);
    const cap = await providerCapState(ctx.pool, orgId, provider, now);
    providers.push({
      provider,
      label: PROVIDER_KEY_LABEL[provider] ?? provider,
      configured: row?.configured === true,
      detail: row?.detail ?? null,
      baseUrl: row?.base_url ?? null,
      models: Array.isArray(row?.models) ? (row?.models as string[]) : [],
      setAt: row?.set_at ? new Date(row.set_at).toISOString() : null,
      setByName: row?.set_by_name ?? null,
      generation: Number(row?.key_generation ?? 0),
      cap: {
        monthlyMicros: cap.capMicros,
        spendMicros: cap.spendMicros,
        unknownCostTurns: cap.unknownCostTurns,
        percent: cap.percent,
        state: cap.state,
        month: cap.month,
        resetsAt: cap.resetsAt.toISOString(),
      },
      workstations: targets.map((t) => {
        const share = shares.find((s) => s.provider === provider && s.workstation_id === t.id);
        const reports = Array.isArray(t.runtimes) ? (t.runtimes as KeyUseReport[]) : [];
        const own = reports.find((r) => r.id === 'direct-model')?.keys?.find((k) => k.provider === provider);
        const stale = !!share && !!t.key_id && share.key_id !== t.key_id;
        const status = !t.supported
          ? ('too_old' as const)
          : !share || stale
            ? ('not_shared' as const)
            : (share.status as 'stored' | 'queued' | 'failed');
        const online = ctx.services.runners.isOnline(t.id);
        return {
          workstationId: t.id as string,
          name: t.name as string,
          ownerName: (t.owner_name as string | null) ?? '',
          online,
          supported: t.supported === true,
          status,
          ...(share?.error && status === 'failed' ? { error: share.error as string } : {}),
          overriddenByOwn: own?.source === 'workstation',
          keyId: (t.key_id as string | null) ?? null,
          publicKey: (t.public_key as string | null) ?? null,
          canShare: online && t.supported === true && status === 'stored',
        };
      }),
    });
  }
  return { providers };
}

// ------------------------------------------------------------------------------------------------ set, share, revoke

/** Sets or replaces the organization's key for a provider; `shares` is the full set of workstations that hold it afterwards. */
export async function setOrgProviderKey(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  provider: string,
  req: SetOrgProviderKeyRequest,
): Promise<void> {
  assertProvider(provider);
  const baseUrl = checkBaseUrl(provider, req.baseUrl);
  if (provider === 'gateway' && req.models.length === 0)
    throw badRequest('models_required', 'add at least one model id: a gateway serves what it is set up with');
  const touched: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, orgId);
    const current = await lockGeneration(tx, orgId, provider);
    // the blobs are bound to the generation the page saw plus one: a page that is out of date seals for the wrong one
    if (req.generation !== current + 1)
      throw conflict(
        'stale_generation',
        'the key changed since this page was loaded: reload the page and enter it again',
      );
    await failPendingReshares(tx, orgId, provider);
    const targets = await targetWorkstations(tx, orgId);
    const wanted = new Set<string>();
    for (const s of req.shares) {
      const t = targets.find((x) => x.id === s.workstationId);
      if (!t) throw notFound('workstation not found in this organization');
      assertSealableTo(t, s.keyId);
      if (wanted.has(s.workstationId))
        throw badRequest('duplicate_workstation', 'a workstation appears twice');
      wanted.add(s.workstationId);
    }
    // Replacing means replacing everywhere: a workstation that held the old key and is not in the new set forgets it.
    const held = await rows<{ workstation_id: string }>(
      tx,
      'SELECT workstation_id FROM org_provider_key_shares WHERE org_id = $1 AND provider = $2',
      [orgId, provider],
    );
    for (const h of held)
      if (!wanted.has(h.workstation_id)) {
        await queueClear(tx, orgId, provider, h.workstation_id, current);
        await exec(
          tx,
          'DELETE FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2 AND workstation_id=$3',
          [orgId, provider, h.workstation_id],
        );
        touched.push(h.workstation_id);
      }
    for (const s of req.shares) {
      await queueShare(ctx, tx, {
        orgId,
        provider,
        workstationId: s.workstationId,
        keyId: s.keyId,
        ciphertext: s.ciphertext,
        baseUrl,
        models: req.models,
        generation: current + 1,
        by: user.id,
        via: 'browser',
      });
      touched.push(s.workstationId);
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgProviderKeySet',
            payload: {
              orgId,
              provider,
              by: user.id,
              detail: req.detail?.trim() || null,
              baseUrl,
              models: req.models,
              workstationIds: [...wanted],
              generation: current + 1,
            },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  deliver(ctx, [...new Set(touched)]);
  ctx.services.dispatcher.trigger();
}

/** Seals the key to one more workstation: the admin entered it again for a workstation that joined later. */
export async function shareOrgProviderKey(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  provider: string,
  req: ShareOrgProviderKeyRequest,
): Promise<void> {
  assertProvider(provider);
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, orgId);
    const current = await lockGeneration(tx, orgId, provider);
    const row = await one(
      tx,
      'SELECT configured, base_url, models FROM org_providers WHERE org_id=$1 AND provider=$2',
      [orgId, provider],
    );
    if (!row?.configured)
      throw conflict('no_org_key', 'the organization has no key for this provider yet: set it first');
    if (req.generation !== current)
      throw conflict(
        'stale_generation',
        'the key changed since this page was loaded: reload the page and enter it again',
      );
    const t = await targetOf(tx, orgId, req.workstationId);
    assertSealableTo(t, req.keyId);
    await queueShare(ctx, tx, {
      orgId,
      provider,
      workstationId: req.workstationId,
      keyId: req.keyId,
      ciphertext: req.ciphertext,
      baseUrl: row.base_url ?? null,
      models: Array.isArray(row.models) ? (row.models as string[]) : [],
      generation: current,
      by: user.id,
      via: 'browser',
    });
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgProviderKeyShared',
            payload: { orgId, provider, workstationId: req.workstationId, by: user.id, via: 'browser' },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  deliver(ctx, [req.workstationId]);
}

/**
 * An Owner or Admin approves sharing the organization's key from a workstation that holds it to one that does not: the server
 * relays a `provider.key.reseal` to the source runner, which opens its own copy and seals it to the target's public key. The
 * answer is relayed on as a `provider.key.set` (see `applyResealResult`). No admin has to type the key again.
 */
export async function reshareOrgProviderKey(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  provider: string,
  req: ReshareOrgProviderKeyRequest,
): Promise<void> {
  assertProvider(provider);
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, orgId);
    const current = await lockGeneration(tx, orgId, provider);
    const kept = await one(tx, 'SELECT configured FROM org_providers WHERE org_id=$1 AND provider=$2', [
      orgId,
      provider,
    ]);
    if (!kept?.configured) throw conflict('no_org_key', 'the organization has no key for this provider');
    if (req.generation !== current)
      throw conflict(
        'stale_generation',
        'the key changed since this page was loaded: reload the page and approve again',
      );
    const source = await targetOf(tx, orgId, req.sourceWorkstationId);
    const target = await targetOf(tx, orgId, req.targetWorkstationId);
    const share = await one(
      tx,
      `SELECT status, key_id FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2 AND workstation_id=$3`,
      [orgId, provider, source.id],
    );
    if (!share || share.status !== 'stored' || share.key_id !== source.key_id)
      throw conflict('source_has_no_key', `${source.name} does not hold the organization's key`);
    if (!ctx.services.runners.isOnline(source.id))
      throw conflict('workstation_offline', `${source.name} is offline`);
    if (!target.supported || !target.key_id || !target.public_key)
      throw unprocessable(
        'runner_too_old',
        `update the runner on ${target.name} to share organization keys with it`,
      );
    await enqueueRunnerCommand(
      tx,
      source.id,
      'provider.key.reseal',
      {
        provider,
        orgId,
        targetKeyId: target.key_id,
        targetPublicKey: target.public_key,
        targetWorkstationId: target.id,
        approvedBy: user.id,
        generation: current,
        // made in the admin's browser and sealed to the source runner: it names the target key the admin was shown
        approval: req.approval,
      },
      new Date(ctx.clock.now().getTime() + 15 * 60_000),
    );
  });
  deliver(ctx, [req.sourceWorkstationId]);
}

/** Revokes the organization's key: every workstation forgets it and every sealed copy is deleted. The cap setting stays. */
export async function revokeOrgProviderKey(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  provider: string,
): Promise<void> {
  assertProvider(provider);
  const touched: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, orgId);
    const current = await lockGeneration(tx, orgId, provider);
    await failPendingReshares(tx, orgId, provider);
    const held = await rows<{ workstation_id: string }>(
      tx,
      'SELECT workstation_id FROM org_provider_key_shares WHERE org_id = $1 AND provider = $2',
      [orgId, provider],
    );
    for (const h of held) {
      await queueClear(tx, orgId, provider, h.workstation_id, current);
      touched.push(h.workstation_id);
    }
    // a copy still waiting in the command queue (a reshare answer on its way) must not arrive after the revocation either
    await exec(tx, 'DELETE FROM org_provider_key_shares WHERE org_id = $1 AND provider = $2', [
      orgId,
      provider,
    ]);
    const row = await one(tx, 'SELECT configured FROM org_providers WHERE org_id=$1 AND provider=$2', [
      orgId,
      provider,
    ]);
    if (!row?.configured && held.length === 0) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: { type: 'OrgProviderKeyRevoked', payload: { orgId, provider, by: user.id } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  deliver(ctx, touched);
}

// ------------------------------------------------------------------------------------------------ runner answers

/** `command.result` of a `provider.key.set` or `.clear` that carries an organization key: the sealed copy is forgotten. */
export async function applyOrgKeyResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  const orgId = String(payload.orgId ?? '');
  const provider = String(payload.provider ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return;
  if (payload.ciphertext === undefined && !('keyId' in payload)) return; // a clear: nothing to record
  const parsed = ok ? ProviderKeyResultSchema.safeParse(result).data : undefined;
  const stored = parsed?.stored ?? ok;
  await exec(
    ctx.pool,
    `UPDATE org_provider_key_shares
        SET status = $4, error = $5, ciphertext = NULL, updated_at = $6
      WHERE org_id = $1 AND provider = $2 AND workstation_id = $3 AND command_id = $7`,
    [
      orgId,
      provider,
      workstationId,
      stored ? 'stored' : 'failed',
      stored ? null : (parsed?.error ?? 'the workstation could not store the key').slice(0, 300),
      ctx.clock.now(),
      commandId,
    ],
  );
}

/** `command.result` of a `provider.key.reseal`: the key, sealed to the target's key, is relayed on to the target. */
export async function applyResealResult(
  ctx: Ctx,
  sourceWorkstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  const parsed = ok ? ProviderKeyResealResultSchema.safeParse(result).data : undefined;
  if (!parsed?.ok || !parsed.ciphertext) return;
  const orgId = String(payload.orgId ?? '');
  const provider = String(payload.provider ?? '');
  const targetId = String(payload.targetWorkstationId ?? '');
  const approvedBy = String(payload.approvedBy ?? '');
  if (!isProvider(provider) || !/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(targetId)) return;
  let delivered = false;
  await withAppendTx(ctx.pool, async (tx) => {
    const current = await lockGeneration(tx, orgId, provider);
    const org = await one(
      tx,
      'SELECT configured, base_url, models FROM org_providers WHERE org_id=$1 AND provider=$2',
      [orgId, provider],
    );
    // revoked meanwhile: the answer is dropped
    if (!org?.configured) return;
    // replaced meanwhile (or answered for another version of the key): the answer would bring back a key that is gone
    const asked = Number(payload.generation ?? 0);
    if (asked < 1 || asked !== current || parsed.generation !== current) return;
    const target = (await targetWorkstations(tx, orgId)).find((t) => t.id === targetId);
    // the target's runner key must still be the one the key was sealed to
    if (!target?.supported || target.key_id !== payload.targetKeyId) return;
    await queueShare(ctx, tx, {
      orgId,
      provider,
      workstationId: targetId,
      keyId: target.key_id,
      ciphertext: parsed.ciphertext as string,
      baseUrl: org.base_url ?? null,
      models: Array.isArray(org.models) ? (org.models as string[]) : [],
      generation: current,
      by: /^[0-9a-f-]{36}$/i.test(approvedBy) ? approvedBy : sourceWorkstationId,
      via: 'runner',
    });
    if (/^[0-9a-f-]{36}$/i.test(approvedBy))
      await ctx.store.append(
        [
          {
            streamId: streamId.org(orgId),
            event: {
              type: 'OrgProviderKeyShared',
              payload: { orgId, provider, workstationId: targetId, by: approvedBy, via: 'runner' },
            },
            actor: userActor(approvedBy),
            scope: orgScope(orgId),
          },
        ],
        { tx },
      );
    delivered = true;
  });
  if (delivered) deliver(ctx, [targetId]);
}

// ------------------------------------------------------------------------------------------------ caps

/** Sets or removes (null) the monthly cap of a provider, in whole US dollars. A cap below the spend takes effect at once. */
export async function setOrgProviderCap(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  provider: string,
  monthlyUsd: number | null,
): Promise<void> {
  assertProvider(provider);
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, orgId);
    const micros = monthlyUsd === null ? null : toMicros(monthlyUsd);
    const cur = await one(tx, 'SELECT * FROM org_providers WHERE org_id=$1 AND provider=$2 FOR UPDATE', [
      orgId,
      provider,
    ]);
    if (
      (cur?.cap_micros === null || cur?.cap_micros === undefined ? null : Number(cur.cap_micros)) === micros
    )
      return;
    const st = await providerCapState(tx, orgId, provider, ctx.clock.now());
    const lifts = micros === null || st.spendMicros < micros;
    const clearPaused = lifts && cur?.cap_paused_month === st.month;
    const clearWarned = micros === null || st.spendMicros < (micros * BUDGET.warnPercent) / 100;
    const events: AppendInput[] = [];
    if (clearPaused && cur?.cap_desk_item_id && (await noticeOpen(tx, cur.cap_desk_item_id)))
      events.push(resolveNotice(orgId, cur.cap_desk_item_id, 'The cap was changed.'));
    events.push({
      streamId: streamId.org(orgId),
      event: {
        type: 'OrgProviderCapSet',
        payload: {
          orgId,
          provider,
          monthlyMicros: micros,
          by: user.id,
          clearWarned: clearWarned && cur?.cap_warned_month === st.month,
          clearPaused,
        },
      },
      actor: userActor(user.id),
      scope: orgScope(orgId),
    });
    await ctx.store.append(events, { tx });
  });
  await evaluateProviderCap(ctx, orgId, provider);
  ctx.services.dispatcher.trigger();
}

/** "Override for this month": runs on the organization's key go on although the cap is reached; the 1st starts fresh. */
export async function overrideOrgProviderCap(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  provider: string,
): Promise<void> {
  assertProvider(provider);
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, orgId);
    const cur = await one(tx, 'SELECT * FROM org_providers WHERE org_id=$1 AND provider=$2 FOR UPDATE', [
      orgId,
      provider,
    ]);
    if (cur?.cap_micros === null || cur?.cap_micros === undefined)
      throw conflict('no_cap', 'this provider has no cap to override');
    const st = await providerCapState(tx, orgId, provider, ctx.clock.now());
    if (cur.cap_override_month === st.month) return;
    const events: AppendInput[] = [];
    if (cur.cap_desk_item_id && (await noticeOpen(tx, cur.cap_desk_item_id)))
      events.push(resolveNotice(orgId, cur.cap_desk_item_id, 'Overridden for this month.'));
    events.push({
      streamId: streamId.org(orgId),
      event: { type: 'OrgProviderCapOverridden', payload: { orgId, provider, month: st.month, by: user.id } },
      actor: userActor(user.id),
      scope: orgScope(orgId),
    });
    await ctx.store.append(events, { tx });
  });
  ctx.services.dispatcher.trigger();
}

async function noticeOpen(tx: Queryable, id: string | null): Promise<boolean> {
  if (!id) return false;
  return !!(await one(tx, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [id]));
}

function resolveNotice(orgId: string, deskItemId: string, note: string): AppendInput {
  return {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemResolved',
      payload: { deskItemId, resolution: 'acknowledged', note, by: { kind: 'system' } },
    },
    actor: SYSTEM_ACTOR,
    scope: orgScope(orgId),
  };
}

/**
 * Looks at one provider's month and fires what is due, once per month and level: the 80% warning and the 100% pause, each a desk
 * notice for the Owner and Admins. Called after a run ends, after a cap change and on the scheduler tick. Turns with an unknown
 * cost are named in the text: the cap cannot count them.
 */
export async function evaluateProviderCap(
  ctx: Ctx,
  orgId: string,
  provider: string,
  /** What runs in flight have used on this key so far (Q48): counted like booked spend. */
  liveMicros = 0,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await one(tx, 'SELECT * FROM org_providers WHERE org_id=$1 AND provider=$2 FOR UPDATE', [
      orgId,
      provider,
    ]);
    if (!p || p.cap_micros === null) return;
    const st = await providerCapState(tx, orgId, provider, ctx.clock.now());
    st.spendMicros += liveMicros;
    const cap = Number(p.cap_micros);
    const events: AppendInput[] = [];
    if (p.cap_paused_month && p.cap_paused_month !== st.month && (await noticeOpen(tx, p.cap_desk_item_id)))
      events.push(resolveNotice(orgId, p.cap_desk_item_id, 'A new month began: the cap starts again.'));
    const label = PROVIDER_KEY_LABEL[provider] ?? provider;
    const money = (v: number) => formatMoney(v, 'USD');
    const resets = st.resetsAt.toISOString().slice(0, 10);
    const unknown =
      st.unknownCostTurns > 0
        ? ` ${st.unknownCostTurns} run${st.unknownCostTurns === 1 ? '' : 's'} this month had no known price: they are not counted, so the real spend may be higher.`
        : '';
    const stateNow = budgetStatus(cap, st.spendMicros, st.overridden).state;
    const level =
      stateNow === 'paused' && p.cap_paused_month !== st.month
        ? 'paused'
        : stateNow === 'warning' && p.cap_warned_month !== st.month
          ? 'warning'
          : null;
    if (level) {
      const deskItemId = randomUUID();
      const pct = Math.floor((st.spendMicros / cap) * 100);
      events.push(
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgProviderCapThresholdReached',
            payload: {
              orgId,
              provider: provider as ProviderKeyId,
              month: st.month,
              level,
              spendMicros: st.spendMicros,
              capMicros: cap,
              unknownCostTurns: st.unknownCostTurns,
              ...(level === 'paused' ? { deskItemId } : {}),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        },
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'alert',
              subkind: level === 'paused' ? PROVIDER_CAP_DESK.paused : PROVIDER_CAP_DESK.warning,
              title:
                level === 'paused'
                  ? `The organization's ${label} key has reached its monthly cap`
                  : `The organization's ${label} key has used ${pct}% of its monthly cap`,
              body:
                level === 'paused'
                  ? `${money(st.spendMicros)} of the ${money(cap)} cap is spent this month. Agents and sessions that would use the organization's ${label} key do not start, and running ones on that key are stopped; work on a workstation's own key goes on. Raise the cap or override it for this month under Settings > Model providers, or it resets on ${resets}.${unknown}`
                  : `${money(st.spendMicros)} of the ${money(cap)} cap is spent this month. At 100% runs on the organization's ${label} key are stopped and do not start. It resets on ${resets}.${unknown}`,
              options: [],
              blocking: false,
              pinned: level === 'paused',
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              data: {
                orgId,
                provider,
                month: st.month,
                spendMicros: st.spendMicros,
                capMicros: cap,
                unknownCostTurns: st.unknownCostTurns,
              },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        },
      );
    }
    if (events.length) await ctx.store.append(events, { tx });
  });
}

/** The scheduler tick: every provider with a cap gets its month looked at. */
export async function evaluateAllProviderCaps(ctx: Ctx): Promise<void> {
  const list = await rows<{ org_id: string; provider: string }>(
    ctx.pool,
    'SELECT org_id, provider FROM org_providers WHERE cap_micros IS NOT NULL',
  );
  for (const r of list)
    await evaluateProviderCap(ctx, r.org_id, r.provider).catch((err) =>
      ctx.log.error({ err, orgId: r.org_id, provider: r.provider }, 'provider cap check failed'),
    );
}

/** After a run ends the provider it spent on is looked at (the spend just changed). Not on the critical path of the report. */
export function registerProviderCapHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e) => {
    const t = e.event.type;
    if (t === 'ShiftEnded') dropLiveUsage(ctx, e.event.payload.shiftId);
    else if (t === 'SessionTurnCompleted' || t === 'SessionTurnFailed')
      dropLiveUsage(ctx, e.event.payload.turnId);
    else if (t === 'DelegateCompleted') dropLiveUsage(ctx, e.event.payload.delegateId);
    const id =
      t === 'ShiftEnded' || t === 'ShiftUsageRecorded'
        ? e.event.payload.shiftId
        : t === 'SessionTurnCompleted'
          ? e.event.payload.turnId
          : t === 'DelegateCompleted'
            ? e.event.payload.delegateId
            : undefined;
    if (!id) return;
    const r = await one(
      ctx.pool,
      'SELECT org_id, key_provider, key_source FROM shift_costs WHERE shift_id=$1',
      [id],
    );
    if (r?.key_source === 'org' && r.key_provider) await evaluateProviderCap(ctx, r.org_id, r.key_provider);
  });
}
