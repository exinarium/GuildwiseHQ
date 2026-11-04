import { createHmac, randomUUID } from 'node:crypto';
import { OfflineRequestSchema, streamId } from '@aom/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { encryptFor, signingKey } from '../auth/secrets.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { OFFLINE_EMAIL_PURPOSE } from '../commands/forms-offline.ts';
import { ev } from '../commands/journey-runtime.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { clientKey, type FormLimits } from './limits.ts';

const DAY = 86_400_000;

/** The hash that refuses a second open case for the same address on a form. Keyed, and cleared with the address. */
export async function emailKey(ctx: Ctx, email: string): Promise<string> {
  return createHmac('sha256', await signingKey(ctx, 'form-offline-email'))
    .update(email.trim().toLowerCase())
    .digest('base64url');
}

/** What the plugin in routes.ts gives the offline request handler. */
export interface OfflineDeps {
  Err: new (
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
    opts?: { retryAfter?: number; close?: boolean },
  ) => Error;
  limits: FormLimits;
  tooMany: (retry: number) => Error;
  pubOf: (req: FastifyRequest) => { formId: string; orgId: string; version: number };
  checkSession: (
    pub: { formId: string; version: number },
    b: { session: string; nonce: string; website: string },
  ) => Promise<{ nonce: string }>;
  checkLink: (
    pub: { formId: string; orgId: string; version: number },
    token: string,
  ) => Promise<{ id: string; reference: string; record_id: string | null; purpose?: string }>;
  availability: (pub: {
    formId: string;
    orgId: string;
    version: number;
  }) => Promise<{ state: 'open' | 'offline' | 'missing'; workstations: string[] }>;
}

/**
 * `POST /api/public/forms/:publicId/offline-requests`: the client leaves an email address because the firm's runner is
 * offline. The answers and files are never part of this request. Always answers 202, for a new case and a duplicate.
 */
export function offlineRequestHandler(ctx: Ctx, d: OfflineDeps) {
  const cfg = ctx.config.publicForms;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const pub = d.pubOf(req);
    const ipTake = d.limits.offlineIp.take(`ip:${clientKey(ctx, req.ip)}`);
    if (!ipTake.ok) throw d.tooMany(ipTake.retryAfterSec);
    const formTake = d.limits.offlineForm.take(`form:${pub.formId}`);
    if (!formTake.ok) throw d.tooMany(formTake.retryAfterSec);

    const parsed = OfflineRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new d.Err(400, 'invalid_answers', 'The request could not be read.');
    const body = parsed.data;
    const session = await d.checkSession(pub, body);

    const open = await one(
      ctx.pool,
      `SELECT count(*)::int AS n FROM form_offline_requests WHERE org_id=$1 AND status IN ('held','sending','sent')`,
      [pub.orgId],
    );
    if ((open?.n ?? 0) >= cfg.offlineMaxOpen) throw d.tooMany(3600);

    const link = body.link ? await d.checkLink(pub, body.link) : null;
    // The secure link itself, opened while the runner is offline again: no new case.
    if (link?.purpose === 'offline')
      throw new d.Err(
        503,
        'runner_offline',
        "This form can't accept submissions right now. Please try again later.",
        { retryable: true },
      );

    const av = await d.availability(pub);
    if (av.state === 'open')
      throw new d.Err(409, 'runner_online', 'The form can be sent now. Please reload the page.');
    if (av.state === 'missing')
      throw new d.Err(
        409,
        'destination_missing',
        "This form can't accept submissions. Please contact the firm.",
        { retryable: false },
      );

    let wait: { id: string; instance_id: string; visit: number } | null = null;
    let linkRow: { record_kind: string | null; record_id: string | null } | null = null;
    if (link) {
      linkRow = (await one(ctx.pool, 'SELECT record_kind, record_id FROM form_client_links WHERE id=$1', [
        link.id,
      ])) as any;
      wait = (await one(
        ctx.pool,
        `SELECT id, instance_id, visit FROM journey_waits WHERE link_id=$1 AND kind='form' AND status IN ('open','escalated')`,
        [link.id],
      )) as any;
    }

    const id = randomUUID();
    const now = ctx.clock.now();
    const email = body.email.trim();
    const emailEnc = await encryptFor(ctx, OFFLINE_EMAIL_PURPOSE, id, email);
    const key = await emailKey(ctx, email);
    try {
      await withAppendTx(ctx.pool, async (tx) => {
        await tx.query(
          `INSERT INTO form_offline_requests
             (id, org_id, form_id, form_version, session_nonce, origin_link_id, journey_instance_id, journey_visit, journey_wait_id,
              record_kind, record_id, workstation_ids, email_enc, email_key, status, attempted_at, hold_expires_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid[],$13,$14,'held',$15,$16,$15,$15)`,
          [
            id,
            pub.orgId,
            pub.formId,
            pub.version,
            session.nonce,
            link?.id ?? null,
            wait?.instance_id ?? null,
            wait?.visit ?? null,
            wait?.id ?? null,
            linkRow?.record_kind ?? null,
            linkRow?.record_id ?? null,
            av.workstations,
            emailEnc,
            key,
            now,
            new Date(now.getTime() + cfg.offlineHoldDays * DAY),
          ],
        );
        const events: Parameters<typeof ctx.store.append>[0] = [
          {
            streamId: streamId.form(pub.formId),
            event: {
              type: 'FormOfflineRequested',
              payload: {
                requestId: id,
                formId: pub.formId,
                orgId: pub.orgId,
                ...(link ? { linkId: link.id } : {}),
                ...(wait ? { journeyInstanceId: wait.instance_id, waitId: wait.id } : {}),
                attemptedAt: now.toISOString(),
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(pub.orgId),
          },
        ];
        if (wait) {
          const inst = await one(tx, 'SELECT * FROM journey_instances WHERE id=$1', [wait.instance_id]);
          if (inst)
            events.push(
              ev(inst, {
                type: 'JourneyWaitOfflinePending',
                payload: { waitId: wait.id, requestId: id, attemptedAt: now.toISOString() },
              }),
            );
        }
        await ctx.store.append(events, { tx });
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        if (String(err.constraint ?? '').includes('session_nonce'))
          throw new d.Err(409, 'session_used', 'This page was already used. Please try again.');
        // A duplicate (same personal link or address): nothing changes and the client is told the same thing.
        return reply.code(202).send({ status: 'pending' });
      }
      throw err;
    }
    return reply.code(202).send({ status: 'pending' });
  };
}
