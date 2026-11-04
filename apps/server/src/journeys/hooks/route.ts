import { createHash, randomUUID } from 'node:crypto';
import { isOrgOperational, mapHookPayload, streamId } from '@aom/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SYSTEM_ACTOR, projectScope } from '../../commands/common.ts';
import { startInstanceIn } from '../../commands/journeys.ts';
import { loadDefinition, lockInstance } from '../../commands/journey-runtime.ts';
import type { Ctx } from '../../context.ts';
import { one, type Row, rows } from '../../db/sql.ts';
import { withAppendTx } from '../../db/tx.ts';
import { HttpError } from '../../errors.ts';
import { clientKey, KeyedBuckets } from '../../public-forms/limits.ts';
import { resolveAndAdvance } from '../waits.ts';
import { HOOK_TOKEN_RE, hashHookToken, secretOf } from './triggers.ts';
import { verifyHookSignature } from './signature.ts';

const envInt = (name: string, d: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

type Outcome =
  | 'started'
  | 'matched'
  | 'resumed'
  | 'duplicate'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'no_record'
  | 'ambiguous_record'
  | 'record_busy'
  | 'invalid_payload'
  | 'unsupported_type'
  | 'too_large'
  | 'rate_limited'
  | 'disabled';

interface HookCall {
  trigger: Row;
  startedAt: bigint;
}
declare module 'fastify' {
  interface FastifyRequest {
    hook: HookCall | null;
  }
}

const elapsedMs = (since: bigint): number => Number((process.hrtime.bigint() - since) / 1_000_000n);

/**
 * Inbound journey hooks, `POST /hooks/in/<token>`. Registered WITHOUT fastify-plugin so the raw-body parser, hooks and error
 * handler stay inside. The signature is checked over the raw bytes BEFORE the body is parsed. The parsed payload is read in
 * memory: only the mapped external id and display name reach the record. Nothing of the body, the headers or the query is
 * stored or logged; a call row keeps the outcome, size and latency.
 */
export function journeyHookRoutes(ctx: Ctx) {
  const maxBytes = envInt('AOM_JOURNEY_HOOK_MAX_BYTES', 65_536);
  const tolerance = envInt('AOM_JOURNEY_HOOK_TOLERANCE_SEC', 300);
  const perIp = new KeyedBuckets(120, 60);
  const perHook = new KeyedBuckets(envInt('AOM_JOURNEY_HOOK_PER_MIN', 60), envInt('AOM_JOURNEY_HOOK_BURST', 30));
  return async (fastify: FastifyInstance) => {
    fastify.decorateRequest('hook', null);
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    const record = async (
      req: FastifyRequest,
      status: number,
      outcome: Outcome,
      size: number,
      extra: { instanceId?: string; idem?: string } = {},
    ): Promise<void> => {
      const h = req.hook;
      if (!h) return;
      await ctx.pool
        .query(
          `INSERT INTO journey_hook_calls (id, trigger_id, org_id, at, status, outcome, size_bytes, latency_ms, instance_id, idempotency_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [randomUUID(), h.trigger.id, h.trigger.org_id, ctx.clock.now(), status, outcome, size, elapsedMs(h.startedAt), extra.instanceId ?? null, extra.idem ?? null],
        )
        .catch(() => undefined);
    };
    const sizeOf = (req: FastifyRequest): number => {
      const n = Number(req.headers['content-length']);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };

    fastify.setErrorHandler(async (err: { statusCode?: number; status?: number; name?: string }, req, reply) => {
      const given = err.statusCode ?? err.status;
      const status = typeof given === 'number' && given >= 400 && given < 500 ? given : 500;
      ctx.log.warn({ hook: { triggerId: req.hook?.trigger.id ?? null, status, errName: err.name } }, 'hook error');
      await record(req, status, status === 413 ? 'too_large' : 'invalid_payload', sizeOf(req));
      return reply.code(status).send();
    });

    const lookup = async (req: FastifyRequest, reply: FastifyReply) => {
      const startedAt = process.hrtime.bigint();
      const token = (req.params as { token?: string }).token ?? '';
      let trigger: Row | null = null;
      if (HOOK_TOKEN_RE.test(token)) {
        const r = await one(
          ctx.pool,
          `SELECT t.*, j.status AS journey_status, o.status AS org_status
             FROM journey_hook_triggers t JOIN journeys j ON j.id = t.journey_id
             JOIN organizations o ON o.id = t.org_id WHERE t.token_hash=$1`,
          [hashHookToken(token)],
        );
        if (r && r.enabled && r.journey_status === 'active' && isOrgOperational(r.org_status)) trigger = r;
      }
      if (!trigger) return reply.code(404).send();
      req.hook = { trigger, startedAt };
      const ip = perIp.take(`ip:${clientKey(ctx, req.ip)}`);
      const hk = ip.ok ? perHook.take(`hook:${trigger.id}`) : ip;
      if (!hk.ok) {
        await record(req, 429, 'rate_limited', sizeOf(req));
        return reply.code(429).header('retry-after', String(hk.retryAfterSec)).send();
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        await record(req, 415, 'unsupported_type', sizeOf(req));
        return reply.code(415).send();
      }
    };

    const handle = async (req: FastifyRequest, reply: FastifyReply) => {
      const h = req.hook as HookCall;
      const t = h.trigger;
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      // 2. The signature, over the raw bytes, before anything is parsed.
      const secret = await secretOf(ctx, t.secret_enc);
      const sig = verifyHookSignature(t.scheme, secret, req.headers, raw, Math.floor(ctx.clock.now().getTime() / 1000), tolerance);
      if (sig !== 'ok') {
        const outcome: Outcome = sig === 'stale' ? 'stale_timestamp' : 'bad_signature';
        ctx.log.warn({ hook: { triggerId: t.id, outcome } }, 'hook refused');
        await record(req, 401, outcome, raw.length);
        return reply.code(401).send();
      }
      // 3. Idempotency.
      const idemRaw = String(req.headers['idempotency-key'] ?? req.headers['x-guildwise-delivery'] ?? '').slice(0, 100);
      const idem = idemRaw ? createHash('sha256').update(idemRaw).digest('hex') : undefined;
      if (idem) {
        const prior = await one(ctx.pool, 'SELECT instance_id, outcome FROM journey_hook_calls WHERE trigger_id=$1 AND idempotency_hash=$2', [t.id, idem]);
        if (prior) {
          await record(req, 200, 'duplicate', raw.length);
          return reply.code(200).send({ duplicate: true, ...(prior.instance_id ? { instanceId: prior.instance_id } : {}) });
        }
      }
      // 4. Parse and map. The parsed object lives only inside this function.
      let mapped: ReturnType<typeof mapHookPayload>;
      try {
        mapped = mapHookPayload(t.mapping, JSON.parse(raw.toString('utf8')));
      } catch {
        await record(req, 400, 'invalid_payload', raw.length);
        return reply.code(400).send({ error: 'invalid_payload' });
      }
      if ('error' in mapped) {
        await record(req, 422, 'invalid_payload', raw.length);
        return reply.code(422).send({ error: mapped.error });
      }
      // 5. One transaction.
      try {
        const out = await withAppendTx(ctx.pool, async (tx) => {
          const journey = await one(tx, 'SELECT * FROM journeys WHERE id=$1', [t.journey_id]);
          if (!journey || journey.status !== 'active') return { code: 404, outcome: 'disabled' as Outcome, body: undefined };
          const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [journey.project_id]);
          if (!project) return { code: 404, outcome: 'disabled' as Outcome, body: undefined };
          const def = await loadDefinition(tx, journey.id, journey.current_version);
          const matches = await rows(
            tx,
            `SELECT * FROM journey_records WHERE project_id=$1 AND record_type=$2 AND external_id=$3 AND status='active' FOR UPDATE`,
            [project.id, def.recordType, mapped.externalId],
          );
          if (matches.length > 1) return { code: 422, outcome: 'ambiguous_record' as Outcome, body: { error: 'ambiguous_record' } };

          if (t.purpose === 'resume') {
            const rec = matches[0];
            if (!rec) return { code: 422, outcome: 'no_record' as Outcome, body: { error: 'no_record' } };
            const waits = rec.current_instance_id
              ? await rows(
                  tx,
                  `SELECT * FROM journey_waits WHERE instance_id=$1 AND trigger_id=$2 AND kind='webhook' AND status IN ('open','escalated') FOR UPDATE`,
                  [rec.current_instance_id, t.id],
                )
              : [];
            let n = 0;
            for (const w of waits) {
              const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
              if (!inst) continue;
              await resolveAndAdvance(ctx, tx, inst, w, 'webhook_received');
              n++;
            }
            return { code: 200, outcome: 'resumed' as Outcome, body: { resumed: n } };
          }

          const rec = matches[0];
          if (rec?.current_instance_id) return { code: 409, outcome: 'record_busy' as Outcome, body: { error: 'record_busy' } };
          if (!rec && t.on_no_match === 'refuse') return { code: 422, outcome: 'no_record' as Outcome, body: { error: 'no_record' } };
          let started: { id: string; recordId: string };
          try {
            started = await startInstanceIn(tx, ctx, {
              project,
              journey,
              def,
              record: rec
                ? { recordId: rec.id }
                : { create: { type: def.recordType, displayName: mapped.displayName ?? mapped.externalId, externalId: mapped.externalId } },
              startedBy: t.created_by,
              actor: SYSTEM_ACTOR,
              after: ({ instanceId, recordId, matched }) => [
                {
                  streamId: streamId.journeyInstance(instanceId),
                  event: { type: 'JourneyStartedByHook', payload: { triggerId: t.id, instanceId, recordId, recordMatched: matched } },
                  actor: SYSTEM_ACTOR,
                  scope: projectScope(project.org_id, project.id),
                },
              ],
            });
          } catch (err) {
            if (err instanceof HttpError && err.code === 'journey_invalid')
              return { code: 409, outcome: 'invalid_payload' as Outcome, body: { error: 'journey_invalid' } };
            throw err;
          }
          return {
            code: 202,
            outcome: (rec ? 'matched' : 'started') as Outcome,
            body: { instanceId: started.id, recordId: started.recordId, matched: !!rec },
            instanceId: started.id,
          };
        });
        await record(req, out.code, out.outcome, raw.length, {
          ...(idem && out.code < 300 ? { idem } : {}),
          ...('instanceId' in out && out.instanceId ? { instanceId: out.instanceId } : {}),
        });
        return out.body === undefined ? reply.code(out.code).send() : reply.code(out.code).send(out.body);
      } catch (err) {
        ctx.log.error({ hook: { triggerId: t.id }, errName: (err as Error).name }, 'hook failed');
        await record(req, 500, 'invalid_payload', raw.length);
        return reply.code(500).send();
      }
    };

    fastify.route({
      method: 'POST',
      url: '/hooks/in/:token',
      logLevel: 'silent',
      bodyLimit: maxBytes,
      exposeHeadRoute: false,
      onRequest: lookup,
      handler: handle,
    });
    for (const url of ['/hooks/in', '/hooks/in/*'])
      fastify.route({
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
        url,
        logLevel: 'silent',
        exposeHeadRoute: false,
        onRequest: async (_req, reply) => reply.code(404).send(),
        handler: async () => undefined,
      });
  };
}
