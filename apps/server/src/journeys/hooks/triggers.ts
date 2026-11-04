import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type HookMapping, streamId } from '@aom/shared';
import type { Who } from '../../auth/org-context.ts';
import { decryptSecret, encryptSecret } from '../../auth/secrets.ts';
import { loadVisibleProject } from '../../authz/scope.ts';
import { projectScope, userActor } from '../../commands/common.ts';
import type { Ctx } from '../../context.ts';
import { one, rows } from '../../db/sql.ts';
import { withAppendTx } from '../../db/tx.ts';
import { badRequest, forbidden, notFound } from '../../errors.ts';
import type { AppendInput } from '../../eventstore/types.ts';

export const HOOK_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
export const hashHookToken = (t: string): string => createHash('sha256').update(t).digest('hex');
const newToken = (): string => randomBytes(24).toString('base64url');
const newSecret = (): string => `jhsec_${randomBytes(32).toString('base64url')}`;
export const hookUrl = (ctx: Ctx, token: string): string =>
  `${ctx.config.publicOrigin.replace(/\/$/, '')}/hooks/in/${token}`;

export interface CreateTriggerBody {
  name: string;
  purpose: 'start' | 'resume';
  scheme?: 'guildwise' | 'body_sha256';
  mapping: HookMapping;
  onNoMatch?: 'create' | 'refuse';
}

async function author(ctx: Ctx, who: Who, journeyId: string) {
  const journey = await one(ctx.pool, 'SELECT * FROM journeys WHERE id=$1', [journeyId]);
  if (!journey) throw notFound('journey not found');
  const project = await loadVisibleProject(ctx.pool, who.userId, journey.project_id);
  if (project.my_role !== 'owner')
    throw forbidden('only the project owner and the organization Owner and Admins can manage hooks');
  return { journey, project };
}

/** Creates a trigger. The URL and the secret are returned ONCE; the list never returns them. */
export async function createTrigger(ctx: Ctx, who: Who, journeyId: string, body: CreateTriggerBody) {
  const { journey, project } = await author(ctx, who, journeyId);
  if (!body.mapping.externalId.startsWith('/'))
    throw badRequest('invalid_mapping', 'The mapping is a JSON pointer such as /client/id.');
  const token = newToken();
  const secret = newSecret();
  const triggerId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.journey(journey.id),
      event: {
        type: 'JourneyHookTriggerCreated',
        payload: {
          triggerId,
          journeyId: journey.id,
          orgId: project.org_id,
          projectId: project.id,
          purpose: body.purpose,
          name: body.name,
          tokenHash: hashHookToken(token),
          secretEnc: await encryptSecret(ctx, secret),
          scheme: body.scheme ?? 'guildwise',
          mapping: body.mapping,
          onNoMatch: body.purpose === 'resume' ? 'refuse' : (body.onNoMatch ?? 'create'),
          by: who.userId,
        },
      },
      actor: userActor(who.userId),
      scope: projectScope(project.org_id, project.id),
    },
  ]);
  return { id: triggerId, url: hookUrl(ctx, token), secret };
}

export async function rotateTrigger(ctx: Ctx, who: Who, journeyId: string, triggerId: string) {
  const { journey, project } = await author(ctx, who, journeyId);
  const t = await one(ctx.pool, 'SELECT id FROM journey_hook_triggers WHERE id=$1 AND journey_id=$2', [
    triggerId,
    journey.id,
  ]);
  if (!t) throw notFound('trigger not found');
  const token = newToken();
  const secret = newSecret();
  await ctx.store.append([
    {
      streamId: streamId.journey(journey.id),
      event: {
        type: 'JourneyHookTriggerRotated',
        payload: { triggerId, tokenHash: hashHookToken(token), secretEnc: await encryptSecret(ctx, secret) },
      },
      actor: userActor(who.userId),
      scope: projectScope(project.org_id, project.id),
    },
  ]);
  return { id: triggerId, url: hookUrl(ctx, token), secret };
}

export async function updateTrigger(
  ctx: Ctx,
  who: Who,
  journeyId: string,
  triggerId: string,
  body: {
    name?: string;
    scheme?: 'guildwise' | 'body_sha256';
    mapping?: HookMapping;
    onNoMatch?: 'create' | 'refuse';
    enabled?: boolean;
  },
) {
  const { journey, project } = await author(ctx, who, journeyId);
  const t = await one(ctx.pool, 'SELECT id FROM journey_hook_triggers WHERE id=$1 AND journey_id=$2', [
    triggerId,
    journey.id,
  ]);
  if (!t) throw notFound('trigger not found');
  const scope = projectScope(project.org_id, project.id);
  const events: AppendInput[] = [];
  const { enabled, ...rest } = body;
  if (Object.keys(rest).length)
    events.push({
      streamId: streamId.journey(journey.id),
      event: { type: 'JourneyHookTriggerUpdated' as const, payload: { triggerId, ...rest } },
      actor: userActor(who.userId),
      scope,
    });
  if (enabled === false)
    events.push({
      streamId: streamId.journey(journey.id),
      event: { type: 'JourneyHookTriggerDisabled' as const, payload: { triggerId } },
      actor: userActor(who.userId),
      scope,
    });
  if (events.length) await withAppendTx(ctx.pool, (tx) => ctx.store.append(events, { tx }));
}

export async function listTriggers(ctx: Ctx, who: Who, journeyId: string) {
  const journey = await one(ctx.pool, 'SELECT * FROM journeys WHERE id=$1', [journeyId]);
  if (!journey) throw notFound('journey not found');
  await loadVisibleProject(ctx.pool, who.userId, journey.project_id);
  const list = await rows(
    ctx.pool,
    `SELECT id, purpose, name, scheme, mapping, on_no_match, enabled, created_by, created_at, rotated_at
       FROM journey_hook_triggers WHERE journey_id=$1 ORDER BY created_at`,
    [journeyId],
  );
  const calls = await rows(
    ctx.pool,
    `SELECT trigger_id, at, status, outcome, size_bytes FROM (
       SELECT *, row_number() OVER (PARTITION BY trigger_id ORDER BY at DESC) AS rn FROM journey_hook_calls
        WHERE trigger_id = ANY($1::uuid[])) c WHERE rn <= 10 ORDER BY at DESC`,
    [list.map((l) => l.id)],
  );
  return list.map((t) => ({
    id: t.id,
    purpose: t.purpose,
    name: t.name,
    scheme: t.scheme,
    mapping: t.mapping,
    onNoMatch: t.on_no_match,
    enabled: t.enabled,
    createdAt: new Date(t.created_at).toISOString(),
    recentCalls: calls
      .filter((c) => c.trigger_id === t.id)
      .map((c) => ({
        at: new Date(c.at).toISOString(),
        status: c.status,
        outcome: c.outcome,
        sizeBytes: c.size_bytes,
      })),
  }));
}

/** The secret for verification (route only). */
export const secretOf = (ctx: Ctx, enc: string): Promise<string> => decryptSecret(ctx, enc);
