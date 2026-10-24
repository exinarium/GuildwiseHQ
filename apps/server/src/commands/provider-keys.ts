import {
  BACKEND_IDS,
  DIRECT_MODEL_CAPABILITY,
  DIRECT_RUNTIME,
  normalizePrivateEndpoints,
  PRIVATE_ENDPOINTS_CAPABILITY,
  PROVIDER_KEYS_BOUND_CAPABILITY,
  type ProviderKeyId,
  ProviderKeyResultSchema,
  type ReportedProvider,
  type SetProviderKeyRequest,
  type WorkstationProvidersResponse,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { providersOf, runtimeReports } from '../sessions/offer.ts';
import { applyOrgKeyResult } from './org-provider-keys.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Provider keys of the direct-model runtime (docs/ARCHITECTURE.md section 38.3). The browser seals the API key with the
 * workstation runner's public key (the one the sudo password uses); the server relays the ciphertext in the durable command
 * queue, empties the payload once the runner answered, and keeps nothing of the key. What is configured (names and models) comes
 * back in the runner's runtime report, so this module stores no provider state of its own. Only the owner of a workstation sets
 * keys for it.
 */
const KEY_TTL_MS = 24 * 3600_000;

/** The last answer of a runner to a key command, per workstation and provider: transient, for the page right after a save. */
const lastResults = new Map<
  string,
  { provider: ProviderKeyId; stored: boolean; error?: string; warning?: string; at: Date }
>();

async function ownWorkstation(
  ctx: Ctx,
  db: Parameters<typeof one>[0],
  user: AuthSession['user'],
  id: string,
) {
  const ws = await one(db, `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`, [
    id,
    user.id,
  ]);
  if (!ws) throw notFound('workstation not found');
  void ctx;
}

export async function setProviderKey(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  provider: ProviderKeyId,
  body: SetProviderKeyRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await ownWorkstation(ctx, tx, user, workstationId);
    const k = await one(tx, 'SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [workstationId]);
    if (!k || k.key_id !== body.keyId)
      throw conflict('sudo_key_changed', "the runner's key changed: reload the page and enter the key again");
    // Bedrock, Vertex and a gateway (Claude Code backends) need a runner that knows them; a direct provider needs the direct-model adapter.
    // Every key is sealed bound to its purpose (`h2`): a runner that cannot open that form is told to update.
    const backend = (BACKEND_IDS as readonly string[]).includes(provider);
    const caps = await one(
      tx,
      `SELECT ($2 = ANY(capabilities) AND $3 = ANY(capabilities)) AS ok FROM workstation_capabilities WHERE workstation_id=$1`,
      [
        workstationId,
        backend ? PROVIDER_KEYS_BOUND_CAPABILITY : DIRECT_MODEL_CAPABILITY,
        PROVIDER_KEYS_BOUND_CAPABILITY,
      ],
    );
    if (!caps?.ok)
      throw unprocessable(
        'runner_too_old',
        backend
          ? 'update the runner on this workstation to use Amazon Bedrock, Google Vertex AI or a gateway with Claude Code'
          : 'update the runner on this workstation to use direct API models',
      );
    // One key per provider is pending at a time.
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb
        WHERE workstation_id=$1 AND type='provider.key.set' AND status IN ('pending','sent') AND payload->>'provider' = $2
          AND payload->>'source' IS DISTINCT FROM 'org'`,
      [workstationId, provider],
    );
    await enqueueRunnerCommand(
      tx,
      workstationId,
      'provider.key.set',
      {
        provider,
        keyId: body.keyId,
        ...(body.ciphertext ? { ciphertext: body.ciphertext } : {}),
        ...(body.ciphertext && body.generation ? { generation: body.generation } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        models: body.models,
      },
      new Date(ctx.clock.now().getTime() + KEY_TTL_MS),
    );
  });
  deliver(ctx, [workstationId]);
}

/**
 * The workstation's private-endpoint allow-list (R2, Q47): exact `host:port` entries of private-network endpoints (a LAN Ollama)
 * its agents' sandboxes and its direct-model runtime may reach. Not a secret, so it travels as a plain durable command; the
 * runner stores it and reports it back with its runtimes. Only the workstation's owner edits it; every entry is checked here
 * and again on the runner.
 */
export async function setPrivateEndpoints(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  endpoints: string[],
): Promise<string[]> {
  const n = normalizePrivateEndpoints(endpoints);
  if (!n.ok) throw unprocessable('bad_endpoint', n.error);
  await withAppendTx(ctx.pool, async (tx) => {
    await ownWorkstation(ctx, tx, user, workstationId);
    const caps = await one(
      tx,
      'SELECT $2 = ANY(capabilities) AS ok FROM workstation_capabilities WHERE workstation_id=$1',
      [workstationId, PRIVATE_ENDPOINTS_CAPABILITY],
    );
    if (!caps?.ok)
      throw unprocessable('runner_too_old', 'update the runner on this workstation to use private endpoints');
    // the newest list replaces one that has not been delivered yet
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', last_error='superseded'
        WHERE workstation_id=$1 AND type='provider.endpoints.set' AND status IN ('pending','sent')`,
      [workstationId],
    );
    await enqueueRunnerCommand(tx, workstationId, 'provider.endpoints.set', { endpoints: n.entries });
  });
  deliver(ctx, [workstationId]);
  return n.entries;
}

export async function clearProviderKey(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  provider: ProviderKeyId,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await ownWorkstation(ctx, tx, user, workstationId);
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb
        WHERE workstation_id=$1 AND type='provider.key.set' AND status IN ('pending','sent') AND payload->>'provider' = $2
          AND payload->>'source' IS DISTINCT FROM 'org'`,
      [workstationId, provider],
    );
    await enqueueRunnerCommand(tx, workstationId, 'provider.key.clear', { provider });
  });
  deliver(ctx, [workstationId]);
}

/** `command.result` of `provider.key.set` and `.clear`: forget the ciphertext, remember the answer for the page. */
export async function applyProviderKeyResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [commandId]);
  // The organization's key: only the fact that the copy was stored goes to the share row (the page of the Owner and Admins).
  if (payload.source === 'org') return applyOrgKeyResult(ctx, workstationId, commandId, payload, ok, result);
  const parsed = ok ? ProviderKeyResultSchema.safeParse(result).data : undefined;
  const provider = String(payload.provider) as ProviderKeyId;
  lastResults.set(workstationId, {
    provider,
    stored: parsed?.stored ?? ok,
    ...(parsed?.error
      ? { error: parsed.error }
      : ok
        ? {}
        : { error: 'the workstation could not store the key' }),
    ...(parsed?.warning ? { warning: parsed.warning } : {}),
    at: ctx.clock.now(),
  });
}

export async function workstationProviders(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<WorkstationProvidersResponse> {
  const ws = await one(
    ctx.pool,
    `SELECT id, connected FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!ws) throw notFound('workstation not found');
  const caps = await one(
    ctx.pool,
    'SELECT $2 = ANY(capabilities) AS ok FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId, DIRECT_MODEL_CAPABILITY],
  );
  const reports = await runtimeReports(ctx.pool, workstationId);
  const providers: ReportedProvider[] = providersOf(reports);
  const ep = await one(
    ctx.pool,
    'SELECT $2 = ANY(capabilities) AS ok FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId, PRIVATE_ENDPOINTS_CAPABILITY],
  );
  const last = lastResults.get(workstationId);
  return {
    workstationId,
    supported: !!caps?.ok,
    online: ctx.services.runners.isOnline(workstationId),
    providers,
    privateEndpoints: reports.find((r) => r.id === DIRECT_RUNTIME)?.privateEndpoints ?? [],
    privateEndpointsSupported: !!ep?.ok,
    lastResult: last
      ? {
          provider: last.provider,
          stored: last.stored,
          ...(last.error ? { error: last.error } : {}),
          ...(last.warning ? { warning: last.warning } : {}),
          at: last.at.toISOString(),
        }
      : null,
  };
}
