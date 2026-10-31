import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  isBusinessOrg,
  RELAY_PATH_PREFIX,
  RELAY_TOKEN_PREFIX,
  type RelayIntegrationCreate,
  type RelayIntegrationDto,
  type RelayIntegrationStatus,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import { orgScope, userActor } from './common.ts';

/** `rly_` plus 192 random bits. Shown once; only its sha256 is stored. */
export const newRelayToken = (): string => `${RELAY_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
export const hashRelayToken = (token: string): string => createHash('sha256').update(token).digest('hex');
/** `rly_` + 32 base64url characters (24 bytes). Anything else cannot be a token and is not looked up. */
export const RELAY_TOKEN_RE = /^rly_[A-Za-z0-9_-]{32}$/;

const urlOf = (ctx: Ctx, token: string) => `${ctx.config.publicOrigin}${RELAY_PATH_PREFIX}${token}`;

export function toDto(r: Row): RelayIntegrationDto {
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    label: r.label,
    status: r.status,
    createdAt: iso(r.created_at) as string,
    rotatedAt: iso(r.rotated_at),
    revokedAt: iso(r.revoked_at),
  };
}

/** 403 `business_mode_required` unless the organization works in Business mode. `FOR SHARE` serialises with a switch. */
async function assertBusiness(db: Queryable, orgId: string): Promise<void> {
  const o = await one(db, 'SELECT mode FROM organizations WHERE id=$1 FOR SHARE', [orgId]);
  if (!isBusinessOrg(o))
    throw new HttpError(
      403,
      'business_mode_required',
      'Inbound relay integrations are available in Business mode organizations.',
    );
}

async function lockOwn(tx: Queryable, orgId: string, id: string): Promise<Row> {
  const r = await one(tx, 'SELECT * FROM relay_integrations WHERE id=$1 AND org_id=$2 FOR UPDATE', [
    id,
    orgId,
  ]);
  if (!r) throw notFound('integration not found');
  return r;
}

export async function createRelayIntegration(
  ctx: Ctx,
  userId: string,
  orgId: string,
  body: RelayIntegrationCreate,
): Promise<{ integration: RelayIntegrationDto; url: string }> {
  const token = newRelayToken();
  const id = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await assertBusiness(tx, orgId);
    await ctx.store.append(
      [
        {
          streamId: streamId.relayIntegration(id),
          event: {
            type: 'RelayIntegrationCreated',
            payload: {
              integrationId: id,
              orgId,
              kind: body.kind,
              label: body.label,
              tokenHash: hashRelayToken(token),
              by: userId,
            },
          },
          actor: userActor(userId),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  const r = await one(ctx.pool, 'SELECT * FROM relay_integrations WHERE id=$1', [id]);
  return { integration: toDto(r as Row), url: urlOf(ctx, token) };
}

export async function listRelayIntegrations(ctx: Ctx, orgId: string): Promise<RelayIntegrationDto[]> {
  await assertBusiness(ctx.pool, orgId);
  const r = await rows(ctx.pool, 'SELECT * FROM relay_integrations WHERE org_id=$1 ORDER BY created_at, id', [
    orgId,
  ]);
  return r.map(toDto);
}

export async function rotateRelayIntegration(
  ctx: Ctx,
  userId: string,
  orgId: string,
  id: string,
): Promise<{ integration: RelayIntegrationDto; url: string }> {
  const token = newRelayToken();
  await withAppendTx(ctx.pool, async (tx) => {
    await assertBusiness(tx, orgId);
    const cur = await lockOwn(tx, orgId, id);
    if (cur.status === 'revoked') throw conflict('revoked', 'this integration is revoked');
    await ctx.store.append(
      [
        {
          streamId: streamId.relayIntegration(id),
          event: {
            type: 'RelayIntegrationRotated',
            payload: { integrationId: id, tokenHash: hashRelayToken(token), by: userId },
          },
          actor: userActor(userId),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  const r = await one(ctx.pool, 'SELECT * FROM relay_integrations WHERE id=$1', [id]);
  return { integration: toDto(r as Row), url: urlOf(ctx, token) };
}

export async function revokeRelayIntegration(
  ctx: Ctx,
  userId: string,
  orgId: string,
  id: string,
): Promise<RelayIntegrationDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    await assertBusiness(tx, orgId);
    const cur = await lockOwn(tx, orgId, id);
    if (cur.status === 'revoked') throw conflict('revoked', 'this integration is already revoked');
    await ctx.store.append(
      [
        {
          streamId: streamId.relayIntegration(id),
          event: { type: 'RelayIntegrationRevoked', payload: { integrationId: id, by: userId } },
          actor: userActor(userId),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  ctx.services.webhookRelay.forget(id);
  const r = await one(ctx.pool, 'SELECT * FROM relay_integrations WHERE id=$1', [id]);
  return toDto(r as Row);
}

/** Per integration: is a serving runner connected, since when not, and how many events were refused since then. */
export async function relayStatuses(ctx: Ctx, orgId: string): Promise<RelayIntegrationStatus[]> {
  await assertBusiness(ctx.pool, orgId);
  const list = await rows(
    ctx.pool,
    `SELECT i.id, i.created_at, p.last_served_at, p.offline_since,
            (SELECT count(*) FROM relay_requests q
              WHERE q.integration_id = i.id AND q.outcome = 'runner_offline'
                AND q.at >= coalesce(p.offline_since, i.created_at)) AS refused,
            (SELECT max(q.at) FROM relay_requests q
              WHERE q.integration_id = i.id AND q.outcome = 'runner_offline'
                AND q.at >= coalesce(p.offline_since, i.created_at)) AS refused_at
       FROM relay_integrations i LEFT JOIN relay_presence p ON p.integration_id = i.id
      WHERE i.org_id=$1 AND i.status='active' ORDER BY i.created_at, i.id`,
    [orgId],
  );
  return list.map((r) => {
    const serving = ctx.services.webhookRelay.isServed(r.id);
    return {
      integrationId: r.id,
      connected: serving > 0,
      servingWorkstations: serving,
      everServed: r.last_served_at != null,
      offlineSince: serving > 0 ? null : iso(r.offline_since),
      refusedSinceOffline:
        serving > 0 ? { count: 0, lastAt: null } : { count: Number(r.refused), lastAt: iso(r.refused_at) },
    };
  });
}
