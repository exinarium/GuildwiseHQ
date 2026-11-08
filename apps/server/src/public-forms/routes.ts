import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptedUploadExtensions,
  CompleteSchema,
  checkPublicAnswers,
  checkUploadHead,
  DESK_SUBKIND,
  DIRECT_UPLOAD_KINDS,
  directGrantTtlMs,
  FORM_UPLOAD_TYPES,
  type FormDefinition,
  GrantCancelSchema,
  GrantCompleteSchema,
  type GrantDto,
  type GrantOffsetDto,
  isOrgOperational,
  PUBLIC_FORM_ID_RE,
  type PublicFormDto,
  publicFormView,
  STORAGE_RETRYABLE,
  type StorageKind,
  type StorageReference,
  type StorageWriteError,
  type SubmissionCompleteDto,
  type SubmissionStartResultDto,
  SubmissionStartSchema,
  type SubmissionStatusDto,
  sanitiseUploadName,
  streamId,
  UPLOAD_HEAD_BYTES,
  type UploadManifestEntry,
} from '@aom/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { readFormLogo } from '../commands/forms.ts';
import { destinationWorkstations } from '../commands/forms-offline.ts';
import { deliver } from '../commands/workstation-setup.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { getFormVersion } from '../queries/forms.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { buildAnswersHtml, buildAnswersJson } from './answers-doc.ts';
import { clientKey, createFormLimits, type FormLimits } from './limits.ts';
import { offlineRequestHandler } from './offline.ts';
import { defaultRunnerOfflineHook, type RunnerOfflineEvent } from './offline-hook.ts';
import {
  powValid,
  signSession,
  signUpload,
  verifyClientLink,
  verifySession,
  verifyUpload,
} from './tokens.ts';

/** What the lookup found for a request; the only thing kept about a call besides the numbers below. */
interface PfCall {
  op:
    | 'view'
    | 'logo'
    | 'start'
    | 'part'
    | 'status'
    | 'complete'
    | 'page'
    | 'offline'
    | 'grant'
    | 'grant_status'
    | 'grant_complete'
    | 'grant_cancel';
  startedAt: bigint;
  publicId: string;
  formId: string | null;
  orgId: string | null;
  version: number;
  submissionId: string | null;
  outcome: string;
  sizeBytes: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    pf: PfCall | null;
  }
  interface FastifyContextConfig {
    op?: PfCall['op'];
  }
}

/** An answer to the public. Nothing from the request is ever put in `message`. */
export class PfError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly opts: { retryAfter?: number; close?: boolean } = {},
  ) {
    super(message);
    this.name = 'PfError';
  }
}

const NOT_AVAILABLE = () => new PfError(404, 'form_not_available', 'This form is not available.');
const OFFLINE_MSG = "This form can't accept submissions right now. Please try again later.";
const STORAGE_MSG =
  "We couldn't save your form to the firm's storage. Your answers are still here: try again.";

type Part = {
  field: string;
  index: number;
  size: number;
  sha256: string;
  ext: string;
  state: 'pending' | 'verifying' | 'stored' | 'failed';
  reference?: StorageReference;
  /** `direct`: the browser sends this file to the firm's storage (cloud destinations); `relay`: through this server. */
  mode?: 'relay' | 'direct';
  /** Grant requests made for this part (at most three). */
  grantAttempts?: number;
  /** When the check of a direct upload started (ms). */
  verifyingAt?: number;
  /** The code of the last failure of a direct upload. */
  error?: string;
};

const UPLOAD_UNAVAILABLE_MSG =
  "This form can't accept files right now. Please try again later or contact the firm.";
const GRANT_MAX_ATTEMPTS = 3;

/** The CSP of the public page: nothing from anywhere else, no inline script or style. */
/** The submitter's file name from the x-file-name header, made safe; 'file' when absent. */
export function uploadNameOf(header: unknown): string {
  let raw = '';
  if (typeof header === 'string') {
    try {
      raw = decodeURIComponent(header).slice(0, 300);
    } catch {
      raw = '';
    }
  }
  return sanitiseUploadName(raw || 'file').base || 'file';
}

export function publicPageCsp(secure: boolean, uploadOrigins: readonly string[] = []): string {
  const connect = ["'self'", ...[...new Set(uploadOrigins)].sort()].join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src ${connect}`,
    "worker-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

const SESSION_BOUND_BODY = 4 * 1024 * 1024;

/**
 * The public side of published forms: `GET /f/:publicId` (the page) and `/api/public/forms/:publicId/*`. Registered
 * WITHOUT fastify-plugin so its parsers, hooks and error handler stay inside. No cookie is read. Nothing a client sends
 * (answer, file name, token, address) reaches a log line or a table: the table gets ids, sizes, hashes and storage
 * references only, and file content is streamed to the runner and dropped.
 */
export function publicFormRoutes(
  ctx: Ctx,
  opts: { webRoot: () => string | null; limits?: FormLimits } = { webRoot: () => null },
) {
  return async (fastify: FastifyInstance) => {
    const cfg = ctx.config.publicForms;
    const limits = opts.limits ?? createFormLimits(ctx);
    const hook = () => ctx.services.publicFormsOffline ?? defaultRunnerOfflineHook;
    const defCache = new Map<string, FormDefinition>();
    fastify.decorateRequest('pf', null);

    // JSON for the small bodies; the raw stream for a file part. Nothing else is parsed.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: SESSION_BOUND_BODY },
      (_req, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(new PfError(400, 'invalid_answers', 'The request could not be read.'), undefined);
        }
      },
    );
    fastify.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

    // ---------------------------------------------------------------------------------- errors and logging
    fastify.setErrorHandler(async (err: any, req, reply) => {
      let status = 500;
      let code = 'server_error';
      let message = 'Something went wrong. Please try again.';
      let extra: Record<string, unknown> = {};
      if (err instanceof PfError) {
        ({ status, code, message, extra } = err);
        if (err.opts.retryAfter) void reply.header('retry-after', String(err.opts.retryAfter));
        if (err.opts.close) void reply.header('connection', 'close');
      } else {
        const given = err?.statusCode ?? err?.status;
        if (typeof given === 'number' && given >= 400 && given < 500) {
          status = given;
          code = typeof err.code === 'string' && err.name === 'HttpError' ? err.code : 'invalid_answers';
          message = status === 403 ? 'This request was not allowed.' : 'The request could not be accepted.';
          if (status === 413) code = 'file_too_large';
        } else {
          ctx.log.warn(
            { publicForm: { op: req.pf?.op ?? null, status, errName: err?.name } },
            'public form error',
          );
        }
      }
      if (req.pf) req.pf.outcome = code;
      return reply.code(status).send({ error: { code, message, ...extra } });
    });

    fastify.addHook('onSend', async (_req, reply, payload) => {
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
      return payload;
    });
    fastify.addHook('onResponse', async (req, reply) => {
      const c = req.pf;
      if (!c) return;
      // One line per call: numbers and ids. No address, user agent, file name, answer, token or public id.
      ctx.log.info(
        {
          publicForm: {
            op: c.op,
            formId: c.formId,
            submissionId: c.submissionId,
            status: reply.statusCode,
            outcome: reply.statusCode < 400 ? 'ok' : c.outcome,
            sizeBytes: c.sizeBytes,
            ms: Number((process.hrtime.bigint() - c.startedAt) / 1_000_000n),
          },
        },
        'public form',
      );
    });

    // ---------------------------------------------------------------------------------- lookup and limits
    const retryAfter = () => ctx.config.relay.retryAfterSec;

    /** The published form behind a public id, or null. Unknown, unpublished, archived and suspended look the same. */
    const findPublished = async (publicId: string) => {
      if (!PUBLIC_FORM_ID_RE.test(publicId)) return null;
      const r = await one(
        ctx.pool,
        `SELECT p.form_id, p.org_id, p.version, f.status AS form_status, o.status AS org_status
           FROM form_publications p
           JOIN forms f ON f.id = p.form_id
           JOIN organizations o ON o.id = p.org_id
          WHERE p.public_id=$1 AND p.status='published'`,
        [publicId],
      );
      if (!r || r.form_status !== 'active' || !isOrgOperational(r.org_status)) return null;
      return { formId: r.form_id as string, orgId: r.org_id as string, version: r.version as number };
    };

    const definitionOf = async (pub: { formId: string; orgId: string; version: number }) => {
      const key = `${pub.formId}:${pub.version}`;
      const hit = defCache.get(key);
      if (hit) return hit;
      const v = await getFormVersion(ctx, pub.orgId, pub.formId, pub.version);
      if (defCache.size > 200) defCache.clear();
      defCache.set(key, v.definition);
      return v.definition;
    };

    type Pub = NonNullable<Awaited<ReturnType<typeof findPublished>>>;
    const pubs = new WeakMap<FastifyRequest, Pub>();
    const pubOf = (req: FastifyRequest): Pub => {
      const p = pubs.get(req);
      if (!p) throw NOT_AVAILABLE();
      return p;
    };

    /** The session, minimum fill time, honeypot and proof of work: one rule for the start and the offline request. */
    const checkSession = async (
      pub: { formId: string; version: number },
      body: { session: string; nonce: string; website: string },
    ) => {
      const now = ctx.clock.now();
      const session = await verifySession(ctx, pub.formId, body.session);
      if (!session || now.getTime() - session.issuedAt > cfg.sessionTtlMin * 60_000)
        throw new PfError(400, 'session_invalid', 'This page has been open too long. Please reload it.');
      if (session.version !== pub.version)
        throw new PfError(
          409,
          'form_changed',
          'The form was updated. Please check your answers and send again.',
        );
      if (
        now.getTime() - session.issuedAt < cfg.minFillMs ||
        body.website !== '' ||
        !powValid(body.session, body.nonce, cfg.powBits)
      )
        throw new PfError(
          422,
          'submission_refused',
          'We could not accept this submission. Please try again.',
        );
      return session;
    };

    const tooMany = (retry: number) =>
      new PfError(
        429,
        'rate_limited',
        'Too many attempts. Please wait a minute and try again.',
        {},
        {
          retryAfter: retry,
        },
      );

    /** Is every storage workstation of the published form online? `missing` is a destination problem, not offline. */
    const availability = async (pub: { formId: string; orgId: string; version: number }) => {
      const dest = await destinationWorkstations(ctx, pub.orgId, await definitionOf(pub));
      if (dest.missing) return { state: 'missing' as const, workstations: [] as string[] };
      const down = dest.workstations.filter((ws) => !ctx.services.runners.isOnline(ws));
      return { state: down.length ? ('offline' as const) : ('open' as const), workstations: down };
    };

    const onRequest = async (req: FastifyRequest) => {
      const params = req.params as { publicId?: string };
      const op = (req.routeOptions.config as { op?: PfCall['op'] }).op ?? 'view';
      req.pf = {
        op,
        startedAt: process.hrtime.bigint(),
        publicId: params.publicId ?? '',
        formId: null,
        orgId: null,
        version: 0,
        submissionId: null,
        outcome: 'ok',
        sizeBytes: Math.max(0, Number(req.headers['content-length']) || 0),
      };
      const ip = limits.ip.take(`ip:${clientKey(ctx, req.ip)}`);
      if (!ip.ok) throw tooMany(ip.retryAfterSec);
      if (!params.publicId) return;
      const pub = await findPublished(params.publicId);
      if (op !== 'page' && !pub) throw NOT_AVAILABLE();
      if (pub) {
        pubs.set(req, pub);
        req.pf.formId = pub.formId;
        req.pf.orgId = pub.orgId;
        req.pf.version = pub.version;
      }
      if (op === 'start' && pub) {
        const a = limits.ipSubmit.take(`ip:${clientKey(ctx, req.ip)}`);
        if (!a.ok) throw tooMany(a.retryAfterSec);
        const b = limits.formSubmit.take(`form:${pub.formId}`);
        if (!b.ok) throw tooMany(b.retryAfterSec);
        // The firm's runner is offline: refuse before the body (answers, file list) is read. The handler checks again.
        // A replaced hook (the `link_later` answer) decides in the handler instead, as before.
        const av = ctx.services.publicFormsOffline ? null : await availability(pub);
        if (av?.state === 'offline')
          throw new PfError(
            503,
            'runner_offline',
            OFFLINE_MSG,
            { retryable: true },
            { close: true, retryAfter: retryAfter() },
          );
      }
    };

    // ---------------------------------------------------------------------------------- client links
    /** The link row for a token, or a clear refusal. Bound to this form. */
    const checkLink = async (pub: Pub, token: string) => {
      const v = await verifyClientLink(ctx, pub.formId, token);
      if (!v.ok) {
        if (v.reason === 'expired')
          throw new PfError(
            410,
            'link_expired',
            'This personal link has expired. Ask the firm for a new one.',
          );
        throw new PfError(404, 'link_invalid', 'This personal link is not valid.');
      }
      const kind = (purpose: unknown) => (purpose === 'offline' ? 'secure link' : 'personal link');
      const row = await one(
        ctx.pool,
        'SELECT * FROM form_client_links WHERE id=$1 AND form_id=$2 AND org_id=$3',
        [v.linkId, pub.formId, pub.orgId],
      );
      if (!row) throw new PfError(404, 'link_invalid', 'This personal link is not valid.');
      const what = kind(row.purpose);
      if (row.revoked_at)
        throw new PfError(
          410,
          'link_revoked',
          `This ${what} is no longer valid. Ask the firm for a new one.`,
        );
      if (row.used_at)
        throw new PfError(410, 'link_used', `This ${what} was already used to send this form.`);
      if (new Date(row.expires_at).getTime() <= ctx.clock.now().getTime())
        throw new PfError(410, 'link_expired', `This ${what} has expired. Ask the firm for a new one.`);
      return row as {
        id: string;
        reference: string;
        record_id: string | null;
        expires_at: Date;
        purpose: string;
      };
    };

    // ---------------------------------------------------------------------------------- storage helpers
    const connectionsOf = async (orgId: string, ids: string[]) => {
      const r = await rows(
        ctx.pool,
        `SELECT id, workstation_id FROM storage_connections WHERE org_id=$1 AND status='active' AND id = ANY($2::uuid[])`,
        [orgId, ids],
      );
      return new Map(r.map((x) => [x.id as string, x.workstation_id as string]));
    };

    const CLOUD = new Set<StorageKind>(DIRECT_UPLOAD_KINDS);
    const kindsOf = async (orgId: string, ids: string[]) => {
      const r = await rows(
        ctx.pool,
        `SELECT id, kind FROM storage_connections WHERE org_id=$1 AND status='active' AND id = ANY($2::uuid[])`,
        [orgId, ids],
      );
      return new Map(r.map((x) => [x.id as string, x.kind as StorageKind]));
    };

    /** The upload hosts this form's file fields can send to directly (reported by the runners, never stored). */
    const uploadOriginsOf = async (pub: Pub, def: FormDefinition): Promise<string[]> => {
      if (!cfg.directUploads) return [];
      const ids = [
        ...new Set(
          def.fields.flatMap((f) =>
            f.type === 'file' && f.destination.connectionId ? [f.destination.connectionId] : [],
          ),
        ),
      ];
      if (!ids.length) return [];
      const kinds = await kindsOf(pub.orgId, ids);
      return ids.flatMap((id) => {
        const o = CLOUD.has(kinds.get(id) as StorageKind) ? ctx.services.direct.originOf(id) : null;
        return o ? [o] : [];
      });
    };

    /** The page origin the browser sends files from (for the provider's CORS answer). */
    const pageOriginOf = (req: FastifyRequest): string => {
      const o = req.headers.origin;
      if (typeof o === 'string') {
        try {
          const u = new URL(o);
          if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
        } catch {
          // fall through
        }
      }
      return `${ctx.config.secureCookies ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
    };

    /** The grant id of each direct part that has one open, in memory only. */
    const openGrants = new Map<string, string>();

    /**
     * The scan refused a file (or could not run): the runner that got it has already removed what it wrote for this
     * submission. Tell the other workstations holding stored parts to do the same, and forget every reference, so a
     * late resume can never complete with files that were deleted.
     */
    const rollBackSubmission = async (
      pub: Pub,
      sid: string,
      parts: Part[],
      failing: number,
      code: string,
      failingConnectionId: string,
    ) => {
      const refs = parts.flatMap((p) => (p.reference ? [p.reference.connectionId] : []));
      const map = await connectionsOf(pub.orgId, [...new Set([failingConnectionId, ...refs])]);
      const own = map.get(failingConnectionId);
      const others = [...new Set(refs.map((c) => map.get(c)).filter((w): w is string => !!w && w !== own))];
      const expires = new Date(ctx.clock.now().getTime() + 25 * 3600_000);
      for (const ws of others)
        await enqueueRunnerCommand(ctx.pool, ws, 'storage.discard', { submissionId: sid }, expires);
      const reset = parts.map((p, n) => {
        const { reference: _gone, ...rest } = p;
        return { ...rest, state: n === failing ? ('failed' as const) : ('pending' as const) };
      });
      await ctx.pool.query(
        `UPDATE form_submissions SET parts=$2::jsonb, status='failed', error_code=$3, updated_at=$4 WHERE id=$1`,
        [sid, JSON.stringify(reset), code, ctx.clock.now()],
      );
      deliver(ctx, others);
    };

    const varsOf = (
      def: FormDefinition,
      sid: string,
      at: Date,
      link: { reference?: string; record_id?: string | null } | null,
      field: string,
      original: string,
      ext: string,
    ): Record<string, string> => {
      const iso = at.toISOString();
      return {
        form: def.settings.title,
        field,
        submission: sid.slice(0, 8),
        client: link?.reference ?? 'public',
        journey: link?.record_id ?? '',
        original,
        ext,
        date: iso.slice(0, 10),
        time: iso.slice(11, 19).replace(/:/g, '-'),
      };
    };

    /** An offline workstation: the hook decides. Returns the reply to send. */
    const offline = async (
      req: FastifyRequest,
      reply: FastifyReply,
      stage: RunnerOfflineEvent['stage'],
      pub: Pub,
      linkId: string | null,
      submissionId: string | null,
      connectionIds: string[],
    ) => {
      const a = await hook().onRunnerOffline(ctx, {
        orgId: pub.orgId,
        formId: pub.formId,
        formVersion: pub.version,
        linkId,
        submissionId,
        stage,
        connectionIds,
      });
      if (a.kind === 'link_later') {
        if (req.pf) req.pf.outcome = 'link_later';
        return reply.code(a.status ?? 202).send({ status: 'link_later', message: a.message });
      }
      throw new PfError(
        503,
        'runner_offline',
        OFFLINE_MSG,
        { retryable: true },
        { retryAfter: retryAfter() },
      );
    };

    /** Maps a refused storage write to what the page is told. */
    const storageFailure = (e: StorageWriteError, field?: string): PfError => {
      if (e.code === 'malware_detected')
        return new PfError(
          422,
          'malware_detected',
          'One of your files could not be accepted because it failed a security check.',
          { retryable: false, ...(field ? { fields: [{ field, code: 'malware_detected' }] } : {}) },
        );
      if (e.code === 'scan_unavailable')
        return new PfError(
          503,
          'scan_unavailable',
          'Your submission could not be checked right now. Please try again later.',
          { retryable: true },
          { retryAfter: retryAfter() },
        );
      if (e.code === 'not_found')
        return new PfError(
          409,
          'destination_missing',
          "This form can't accept submissions. Please contact the firm.",
          {
            retryable: false,
          },
        );
      if (e.code === 'too_large') return new PfError(413, 'file_too_large', 'The file is too large.');
      if (e.code === 'type_refused')
        return new PfError(415, 'file_type_refused', 'This file type is not accepted.', { retryable: false });
      return new PfError(502, 'storage_failed', STORAGE_MSG, {
        retryable: STORAGE_RETRYABLE[e.code] ?? false,
      });
    };

    const rowOf = async (pub: Pub, sid: string) => {
      if (!/^[0-9a-f-]{36}$/.test(sid))
        throw new PfError(404, 'submission_not_found', 'Submission not found.');
      const r = await one(
        ctx.pool,
        'SELECT * FROM form_submissions WHERE id=$1 AND form_id=$2 AND org_id=$3',
        [sid, pub.formId, pub.orgId],
      );
      if (!r) throw new PfError(404, 'submission_not_found', 'Submission not found.');
      return r;
    };

    const authorise = async (req: FastifyRequest, pub: Pub, sid: string) => {
      const token = req.headers['x-upload-token'];
      if (!(await verifyUpload(ctx, sid, typeof token === 'string' ? token : undefined)))
        throw new PfError(404, 'submission_not_found', 'Submission not found.');
      const r = await rowOf(pub, sid);
      if (req.pf) req.pf.submissionId = sid;
      return r;
    };

    // ---------------------------------------------------------------------------------- the page
    let pageHtml: string | null = null;
    fastify.route({
      method: 'GET',
      url: '/f/:publicId',
      logLevel: 'silent',
      config: { op: 'page' },
      onRequest,
      handler: async (req, reply) => {
        const found = pubs.has(req);
        if (pageHtml === null) {
          const root = opts.webRoot();
          try {
            pageHtml = root ? readFileSync(join(root, 'form.html'), 'utf8') : '';
          } catch {
            pageHtml = '';
          }
        }
        const secure = ctx.config.secureCookies;
        const pubFound = pubs.get(req);
        const origins = pubFound ? await uploadOriginsOf(pubFound, await definitionOf(pubFound)) : [];
        reply
          .code(found ? 200 : 404)
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-security-policy', publicPageCsp(secure, origins))
          .header('cache-control', 'no-store')
          .header('x-robots-tag', 'noindex, nofollow')
          .header('referrer-policy', 'no-referrer')
          .header('cross-origin-resource-policy', 'same-origin');
        if (!pageHtml) {
          // No built page (a server started without the web build): the same plain answer for every id.
          return reply.send('<!doctype html><title>Form</title><p>This form is not available.</p>');
        }
        return reply.send(pageHtml);
      },
    });

    // ---------------------------------------------------------------------------------- the definition
    fastify.route({
      method: 'GET',
      url: '/api/public/forms/:publicId',
      logLevel: 'silent',
      config: { op: 'view' },
      onRequest,
      handler: async (req) => {
        const pub = pubOf(req);
        const def = await definitionOf(pub);
        let link: PublicFormDto['link'] = null;
        const token = req.headers['x-form-link'];
        if (typeof token === 'string' && token) {
          const row = await checkLink(pub, token);
          link = {
            state: 'valid',
            expiresAt: new Date(row.expires_at).toISOString(),
            purpose: row.purpose === 'offline' ? 'offline' : 'client',
          };
        }
        const org = await one(ctx.pool, 'SELECT name FROM organizations WHERE id=$1', [pub.orgId]);
        const body: PublicFormDto = {
          form: publicFormView(def),
          firmName:
            String(org?.name ?? '')
              .trim()
              .slice(0, 120) || null,
          version: pub.version,
          logo: def.settings.logo
            ? `/api/public/forms/${(req.params as { publicId: string }).publicId}/logo`
            : null,
          session: await signSession(ctx, pub.formId, pub.version, ctx.clock.now()),
          powBits: cfg.powBits,
          minFillMs: cfg.minFillMs,
          availability: (await availability(pub)).state === 'offline' ? 'offline' : 'open',
          link,
          uploadOrigins: await uploadOriginsOf(pub, def),
        };
        return body;
      },
    });

    fastify.route({
      method: 'GET',
      url: '/api/public/forms/:publicId/logo',
      logLevel: 'silent',
      config: { op: 'logo' },
      onRequest,
      handler: async (req, reply) => {
        const pub = pubOf(req);
        const id = (await definitionOf(pub)).settings.logo?.imageId;
        if (!id) throw NOT_AVAILABLE();
        const img = await readFormLogo(ctx, pub.orgId, id).catch(() => null);
        if (!img) throw NOT_AVAILABLE();
        return reply
          .header('content-type', img.contentType)
          .header('content-security-policy', "sandbox; default-src 'none'")
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'public, max-age=300')
          .header('cross-origin-resource-policy', 'same-origin')
          .send(img.data);
      },
    });

    // ---------------------------------------------------------------------------------- start
    fastify.route({
      method: 'POST',
      url: '/api/public/forms/:publicId/submissions',
      logLevel: 'silent',
      config: { op: 'start' },
      bodyLimit: SESSION_BOUND_BODY,
      onRequest,
      handler: async (req, reply) => {
        const pub = pubOf(req);
        const parsed = SubmissionStartSchema.safeParse(req.body);
        if (!parsed.success) throw new PfError(400, 'invalid_answers', 'The submission could not be read.');
        const body = parsed.data;
        const now = ctx.clock.now();
        const session = await checkSession(pub, body);

        const link = body.link ? await checkLink(pub, body.link) : null;
        const def = await definitionOf(pub);

        // Size, count and type limits from the manifest; answers against the shared rules.
        if (body.files.length > cfg.maxFiles)
          throw new PfError(400, 'too_many_files', 'Too many files were attached.');
        let total = 0;
        for (const f of body.files) {
          if (f.size > ctx.config.storage.maxFileBytes)
            throw new PfError(413, 'file_too_large', 'A file is too large.', {
              fields: [{ field: f.field, code: 'file_too_large' }],
            });
          total += f.size;
        }
        if (total > cfg.maxSubmissionBytes)
          throw new PfError(413, 'file_too_large', 'The files are too large together.');
        const checked = checkPublicAnswers(def, body.answers, body.files as UploadManifestEntry[]);
        if (!checked.ok) {
          const has = (c: string) => checked.errors.some((e) => e.code === c);
          const status = has('file_type') ? 415 : has('file_too_large') ? 413 : 400;
          const code =
            status === 415 ? 'file_type_refused' : status === 413 ? 'file_too_large' : 'invalid_answers';
          throw new PfError(status, code, 'Some answers need attention.', { fields: checked.errors });
        }

        // Destinations: every one must exist, and its workstation must be online.
        const wanted = new Set<string>();
        const fileFields = new Set(body.files.map((f) => f.field));
        let missing = false;
        const add = (id: string | null) => {
          if (id) wanted.add(id);
          else missing = true;
        };
        add(def.settings.answersDestination.connectionId);
        for (const f of def.fields)
          if (f.type === 'file' && fileFields.has(f.id)) add(f.destination.connectionId);
        const conns = missing ? new Map<string, string>() : await connectionsOf(pub.orgId, [...wanted]);
        if (missing || [...wanted].some((id) => !conns.has(id)))
          throw new PfError(
            409,
            'destination_missing',
            "This form can't accept submissions. Please contact the firm.",
            {
              retryable: false,
            },
          );
        if ([...conns.values()].some((ws) => !ctx.services.runners.isOnline(ws)))
          return offline(req, reply, 'start', pub, link?.id ?? null, null, [...wanted]);

        // A cloud destination takes the file straight from the browser. With no reported upload host the form refuses
        // here, before anything is sent: there is no relay for a cloud destination (the runner offline was handled above).
        const kinds = cfg.directUploads
          ? await kindsOf(pub.orgId, [...wanted])
          : new Map<string, StorageKind>();
        const modeOf = (field: string): 'relay' | 'direct' => {
          const dest = def.fields.find((f) => f.id === field);
          const id = dest?.type === 'file' ? dest.destination.connectionId : null;
          return id && CLOUD.has(kinds.get(id) as StorageKind) ? 'direct' : 'relay';
        };
        for (const f of body.files) {
          if (modeOf(f.field) !== 'direct') continue;
          const dest = def.fields.find((x) => x.id === f.field);
          const id = dest?.type === 'file' ? dest.destination.connectionId : null;
          if (!id || !ctx.services.direct.originOf(id))
            throw new PfError(
              503,
              'upload_unavailable',
              UPLOAD_UNAVAILABLE_MSG,
              { retryable: true },
              { retryAfter: retryAfter() },
            );
        }

        const sid = randomUUID();
        const parts: Part[] = body.files.map((f, i) => ({
          field: f.field,
          index: i,
          size: f.size,
          sha256: f.sha256,
          ext: sanitiseUploadName(f.name).ext,
          state: 'pending',
          // Only a direct part is marked: a relay part is stored exactly as before direct uploads existed.
          ...(modeOf(f.field) === 'direct' ? { mode: 'direct' as const } : {}),
        }));
        const expiresAt = new Date(now.getTime() + cfg.submissionTtlMin * 60_000);
        try {
          await ctx.pool.query(
            `INSERT INTO form_submissions (id, org_id, form_id, form_version, link_id, status, session_nonce, parts, created_at, updated_at, expires_at)
             VALUES ($1,$2,$3,$4,$5,'receiving',$6,$7::jsonb,$8,$8,$9)`,
            [
              sid,
              pub.orgId,
              pub.formId,
              pub.version,
              link?.id ?? null,
              session.nonce,
              JSON.stringify(parts),
              now,
              expiresAt,
            ],
          );
        } catch (err: any) {
          if (err?.code === '23505')
            throw new PfError(409, 'session_used', 'This page was already used. Please try again.');
          throw err;
        }
        if (req.pf) req.pf.submissionId = sid;
        const out: SubmissionStartResultDto = {
          submissionId: sid,
          uploadToken: await signUpload(ctx, sid, expiresAt),
          parts: parts.map((p) => ({
            field: p.field,
            index: p.index,
            needed: true,
            mode: p.mode ?? 'relay',
          })),
        };
        return reply.code(201).send(out);
      },
    });

    // ---------------------------------------------------------------------------------- runner offline: secure link later
    fastify.route({
      method: 'POST',
      url: '/api/public/forms/:publicId/offline-requests',
      logLevel: 'silent',
      config: { op: 'offline' },
      bodyLimit: 8 * 1024,
      onRequest,
      handler: offlineRequestHandler(ctx, {
        Err: PfError,
        limits,
        tooMany,
        pubOf,
        checkSession,
        checkLink,
        availability,
      }),
    });

    // ---------------------------------------------------------------------------------- one file
    fastify.route({
      method: 'PUT',
      url: '/api/public/forms/:publicId/submissions/:sid/parts/:index',
      logLevel: 'silent',
      config: { op: 'part' },
      onRequest,
      handler: async (req, reply) => {
        const pub = pubOf(req);
        const { sid, index } = req.params as { sid: string; index: string };
        const row = await authorise(req, pub, sid);
        const close = { close: true };
        if (new Date(row.expires_at).getTime() <= ctx.clock.now().getTime() || row.status === 'expired')
          throw new PfError(
            410,
            'submission_expired',
            'This submission timed out. Please send the form again.',
            {},
            close,
          );
        if (row.status === 'complete' || row.status === 'storing')
          throw new PfError(409, 'submission_busy', 'This submission is already being processed.', {}, close);
        const parts = row.parts as Part[];
        const i = /^\d{1,3}$/.test(index) ? Number(index) : -1;
        const part = parts[i];
        if (!part) throw new PfError(404, 'submission_not_found', 'Submission not found.', {}, close);
        // A direct part never goes through this server, even for a crafted client. Refused before a body byte is read.
        if (part.mode === 'direct')
          throw new PfError(
            409,
            'upload_mode',
            'This file must be sent another way. Please reload the page.',
            { retryable: false },
            close,
          );
        if (part.state === 'stored') return reply.header('connection', 'close').send({ state: 'stored' });

        // Checked before one byte of the body is read.
        const cl = req.headers['content-length'];
        if (req.headers['transfer-encoding'] !== undefined || cl === undefined)
          throw new PfError(411, 'invalid_answers', 'The file size is required.', {}, close);
        if (!/^\d{1,10}$/.test(cl) || Number(cl) !== part.size)
          throw new PfError(400, 'invalid_answers', 'The file does not match what was announced.', {}, close);

        const def = await definitionOf(pub);
        const field = def.fields.find((f) => f.id === part.field);
        if (!field || field.type !== 'file' || !field.destination.connectionId)
          throw new PfError(
            409,
            'destination_missing',
            "This form can't accept submissions. Please contact the firm.",
            {},
            close,
          );
        const accepted = acceptedUploadExtensions(field.allowedTypes);

        const fail = async (code: string) => {
          parts[i] = { ...part, state: 'failed' };
          await ctx.pool.query(
            `UPDATE form_submissions SET parts=$2::jsonb, status='failed', error_code=$3, updated_at=$4 WHERE id=$1`,
            [sid, JSON.stringify(parts), code, ctx.clock.now()],
          );
        };

        // The body as a stream that does not destroy the request when it is left early.
        const iterator = (
          req.raw as unknown as { iterator(o: { destroyOnReturn: boolean }): AsyncIterator<Buffer> }
        ).iterator({
          destroyOnReturn: false,
        });
        const first: Buffer[] = [];
        let have = 0;
        let ended = false;
        while (have < UPLOAD_HEAD_BYTES) {
          const n = await iterator.next();
          if (n.done) {
            ended = true;
            break;
          }
          first.push(n.value as Buffer);
          have += (n.value as Buffer).length;
          if (have > part.size) {
            await fail('file_too_large');
            throw new PfError(413, 'file_too_large', 'The file is larger than announced.', {}, close);
          }
        }
        const head = Buffer.concat(first).subarray(0, UPLOAD_HEAD_BYTES);
        const sniff = checkUploadHead(part.ext, head, accepted);
        if (!sniff.ok) {
          await fail('file_type_refused');
          throw new PfError(
            415,
            'file_type_refused',
            'This file type is not accepted.',
            { retryable: false },
            close,
          );
        }

        const ac = new AbortController();
        req.raw.once('close', () => {
          if (!req.raw.complete) ac.abort();
        });
        async function* source(): AsyncGenerator<Buffer> {
          for (const b of first) yield b;
          if (ended) return;
          for (;;) {
            const n = await iterator.next();
            if (n.done) return;
            yield n.value as Buffer;
          }
        }
        const original = uploadNameOf(req.headers['x-file-name']);
        const linkRow = row.link_id
          ? await one(ctx.pool, 'SELECT reference, record_id FROM form_client_links WHERE id=$1', [
              row.link_id,
            ])
          : undefined;
        const r = await ctx.services.storage.write({
          orgId: pub.orgId,
          connectionId: field.destination.connectionId,
          folder: field.destination.folder,
          name: field.destination.name,
          vars: varsOf(def, sid, new Date(row.created_at), linkRow ?? null, field.id, original, part.ext),
          ext: part.ext,
          contentType: sniff.contentType,
          size: part.size,
          source: source(),
          signal: ac.signal,
          submission: { orgId: pub.orgId, formId: pub.formId, submissionId: sid },
          scan: { field: field.id, fileName: original },
        });
        if (!r.ok) {
          if (r.error.code === 'malware_detected' || r.error.code === 'scan_unavailable') {
            await rollBackSubmission(pub, sid, parts, i, r.error.code, field.destination.connectionId);
            throw storageFailure(r.error, field.id);
          }
          await fail(r.error.code);
          if (r.error.code === 'runner_offline')
            return offline(req, reply, 'part', pub, row.link_id, sid, [field.destination.connectionId]);
          throw storageFailure(r.error, field.id);
        }
        if (r.reference.sha256 !== part.sha256 || r.reference.size !== part.size) {
          await fail('invalid');
          throw new PfError(400, 'invalid_answers', 'The file does not match what was announced.', {
            retryable: false,
          });
        }
        parts[i] = { ...part, state: 'stored', reference: r.reference };
        await ctx.pool.query(`UPDATE form_submissions SET parts=$2::jsonb, updated_at=$3 WHERE id=$1`, [
          sid,
          JSON.stringify(parts),
          ctx.clock.now(),
        ]);
        return { state: 'stored' };
      },
    });

    // ---------------------------------------------------------------------------------- direct uploads (cloud destinations)
    /** The submission, the direct part and its field, with the same expiry rules as the relay PUT. */
    const directPart = async (req: FastifyRequest) => {
      const pub = pubOf(req);
      const { sid, index } = req.params as { sid: string; index: string };
      const row = await authorise(req, pub, sid);
      if (new Date(row.expires_at).getTime() <= ctx.clock.now().getTime() || row.status === 'expired')
        throw new PfError(
          410,
          'submission_expired',
          'This submission timed out. Please send the form again.',
        );
      if (row.status === 'complete' || row.status === 'storing')
        throw new PfError(409, 'submission_busy', 'This submission is already being processed.');
      const parts = row.parts as Part[];
      const i = /^\d{1,3}$/.test(index) ? Number(index) : -1;
      const part = parts[i];
      if (!part) throw new PfError(404, 'submission_not_found', 'Submission not found.');
      if (part.mode !== 'direct')
        throw new PfError(409, 'upload_mode', 'This file must be sent another way. Please reload the page.', {
          retryable: false,
        });
      return { pub, sid, row, parts, i, part, key: `${sid}:${i}` };
    };

    const savePart = (sid: string, i: number, part: Part) =>
      ctx.pool.query(
        `UPDATE form_submissions SET parts=jsonb_set(parts, $2::text[], $3::jsonb), updated_at=$4 WHERE id=$1`,
        [sid, [String(i)], JSON.stringify(part), ctx.clock.now()],
      );

    const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

    /**
     * A part still being checked counts as given up only after the same bound the server waits for the runner's
     * answer: the runner may read and scan the whole file, which takes far longer than a relay write.
     */
    const staleCheck = (p: Part) =>
      p.state === 'verifying' &&
      ctx.clock.now().getTime() - (p.verifyingAt ?? 0) > ctx.services.direct.verifyTimeoutMs;

    fastify.route({
      method: 'POST',
      url: '/api/public/forms/:publicId/submissions/:sid/parts/:index/grant',
      logLevel: 'silent',
      config: { op: 'grant' },
      bodyLimit: 8 * 1024,
      onRequest,
      handler: async (req, reply) => {
        const { pub, sid, row, parts, i, part, key } = await directPart(req);
        if (part.state === 'stored')
          throw new PfError(409, 'submission_busy', 'This file was already sent.', {}, {});
        const stale = staleCheck(part);
        if (part.state === 'verifying' && !stale)
          throw new PfError(409, 'submission_busy', 'This file is being checked.', {}, {});
        const def = await definitionOf(pub);
        const field = def.fields.find((f) => f.id === part.field);
        if (!field || field.type !== 'file' || !field.destination.connectionId)
          throw new PfError(
            409,
            'destination_missing',
            "This form can't accept submissions. Please contact the firm.",
          );
        const connectionId = field.destination.connectionId;
        // The same size and type rules as the start, again before an address is issued.
        const accepted = acceptedUploadExtensions(field.allowedTypes);
        if (part.size > Math.min(field.maxSizeBytes, ctx.config.storage.maxFileBytes))
          throw new PfError(413, 'file_too_large', 'A file is too large.');
        const type = FORM_UPLOAD_TYPES[part.ext];
        if (!type || !accepted.includes(part.ext))
          throw new PfError(415, 'file_type_refused', 'This file type is not accepted.', {
            retryable: false,
          });

        const attempts = (part.grantAttempts ?? 0) + 1;
        const next: Part = { ...part, state: 'pending', grantAttempts: attempts };
        delete next.verifyingAt;
        delete next.error;
        parts[i] = next;
        await savePart(sid, i, next);
        const old = openGrants.get(key);
        if (old) {
          ctx.services.direct.cancel(old, 'retry');
          openGrants.delete(key);
        }

        const linkRow = row.link_id
          ? await one(ctx.pool, 'SELECT reference, record_id FROM form_client_links WHERE id=$1', [
              row.link_id,
            ])
          : undefined;
        const original = uploadNameOf(req.headers['x-file-name']);
        const remaining = Math.max(60_000, new Date(row.expires_at).getTime() - ctx.clock.now().getTime());
        const r = await ctx.services.direct.open({
          orgId: pub.orgId,
          formId: pub.formId,
          submissionId: sid,
          index: i,
          connectionId,
          folder: field.destination.folder,
          name: field.destination.name,
          vars: varsOf(def, sid, new Date(row.created_at), linkRow ?? null, field.id, original, part.ext),
          ext: part.ext,
          contentType: type.contentType,
          size: part.size,
          sha256: part.sha256,
          accepted,
          pageOrigin: pageOriginOf(req),
          ttlMs: Math.min(directGrantTtlMs(part.size), remaining),
          scan: { field: field.id, fileName: original },
        });
        if (r.ok) {
          openGrants.set(key, r.grantId);
          noStore(reply);
          const out: GrantDto = {
            grant: {
              method: 'PUT',
              url: r.grant.url,
              headers: r.grant.headers,
              chunkBytes: r.grant.chunkBytes,
              expiresAt: new Date(r.grant.expiresAt).toISOString(),
            },
          };
          return out;
        }
        if (r.error.code === 'runner_offline')
          return offline(req, reply, 'part', pub, row.link_id, sid, [connectionId]);
        if (r.error.retryable && attempts < GRANT_MAX_ATTEMPTS)
          throw new PfError(
            503,
            'upload_unavailable',
            UPLOAD_UNAVAILABLE_MSG,
            { retryable: true },
            { retryAfter: retryAfter() },
          );
        // A final refusal, or the third failed attempt: the submission fails. There is no relay for a cloud destination.
        await rollBackSubmission(pub, sid, parts, i, 'upload_unavailable', connectionId);
        throw new PfError(
          502,
          'upload_unavailable',
          'Your files could not be sent to the firm. Please contact the firm.',
          { retryable: false },
        );
      },
    });

    fastify.route({
      method: 'GET',
      url: '/api/public/forms/:publicId/submissions/:sid/parts/:index/grant',
      logLevel: 'silent',
      config: { op: 'grant_status' },
      onRequest,
      handler: async (req, reply) => {
        const { key } = await directPart(req);
        const id = openGrants.get(key);
        noStore(reply);
        const out: GrantOffsetDto = { offset: id ? await ctx.services.direct.offset(id) : null };
        return out;
      },
    });

    fastify.route({
      method: 'POST',
      url: '/api/public/forms/:publicId/submissions/:sid/parts/:index/grant/complete',
      logLevel: 'silent',
      config: { op: 'grant_complete' },
      bodyLimit: 8 * 1024,
      onRequest,
      handler: async (req, reply) => {
        const { pub, sid, parts, i, part, key } = await directPart(req);
        const body = GrantCompleteSchema.safeParse(req.body);
        if (!body.success) throw new PfError(400, 'invalid_answers', 'The request could not be read.');
        const grantId = openGrants.get(key);
        if (part.state === 'stored') return reply.code(202).send({ state: 'stored' });
        if (!grantId || part.state !== 'pending')
          throw new PfError(409, 'submission_busy', 'This upload is not open any more.');
        if (body.data.size !== part.size || body.data.sha256 !== part.sha256) {
          ctx.services.direct.cancel(grantId, 'client_gone');
          openGrants.delete(key);
          throw new PfError(400, 'invalid_answers', 'The file does not match what was announced.', {
            retryable: false,
          });
        }
        const verifying: Part = { ...part, state: 'verifying', verifyingAt: ctx.clock.now().getTime() };
        parts[i] = verifying;
        await savePart(sid, i, verifying);
        openGrants.delete(key);
        const def = await definitionOf(pub);
        const field = def.fields.find((f) => f.id === part.field);
        const connectionId = field?.type === 'file' ? (field.destination.connectionId ?? '') : '';
        void ctx.services.direct
          .finish(grantId, body.data)
          .then(async (v) => {
            const cur = await one(ctx.pool, 'SELECT parts FROM form_submissions WHERE id=$1', [sid]);
            const now = (cur?.parts as Part[] | undefined) ?? parts;
            const fresh = now[i] ?? verifying;
            if (fresh.state !== 'verifying') return;
            if (v.ok) {
              const r = v.reference;
              if (r.sha256 !== part.sha256 || r.size !== part.size || r.connectionId !== connectionId) {
                await savePart(sid, i, { ...fresh, state: 'failed', error: 'invalid' });
                return;
              }
              await savePart(sid, i, { ...fresh, state: 'stored', reference: r });
              return;
            }
            if (v.error.code === 'malware_detected' || v.error.code === 'scan_unavailable') {
              await rollBackSubmission(pub, sid, now, i, v.error.code, connectionId);
              await ctx.pool.query(
                `UPDATE form_submissions SET parts=jsonb_set(parts, $2::text[], $3::jsonb) WHERE id=$1`,
                [sid, [String(i)], JSON.stringify({ ...fresh, state: 'failed', error: v.error.code })],
              );
              return;
            }
            await savePart(sid, i, { ...fresh, state: 'failed', error: v.error.code });
            await ctx.pool.query(
              `UPDATE form_submissions SET status='failed', error_code=$2, updated_at=$3 WHERE id=$1 AND status='receiving'`,
              [sid, v.error.code, ctx.clock.now()],
            );
          })
          .catch(() => ctx.log.warn({ publicForm: { op: 'grant_complete' } }, 'direct upload check failed'));
        noStore(reply);
        return reply.code(202).send({ state: 'verifying' });
      },
    });

    fastify.route({
      method: 'POST',
      url: '/api/public/forms/:publicId/submissions/:sid/parts/:index/grant/cancel',
      logLevel: 'silent',
      config: { op: 'grant_cancel' },
      bodyLimit: 4 * 1024,
      onRequest,
      handler: async (req, reply) => {
        const { pub, sid, parts, i, part, key } = await directPart(req);
        const body = GrantCancelSchema.safeParse(req.body ?? { reason: 'abandoned' });
        if (!body.success) throw new PfError(400, 'invalid_answers', 'The request could not be read.');
        const grantId = openGrants.get(key);
        openGrants.delete(key);
        if (grantId)
          ctx.services.direct.cancel(
            grantId,
            body.data.reason === 'retry'
              ? 'retry'
              : body.data.reason === 'blocked'
                ? 'blocked'
                : 'client_gone',
          );
        if (part.state === 'pending' || part.state === 'verifying') {
          if (body.data.reason === 'blocked') {
            // The browser could not reach the storage provider (page rules or CORS): no relay, the submission fails.
            const def = await definitionOf(pub);
            const field = def.fields.find((f) => f.id === part.field);
            const connectionId = field?.type === 'file' ? (field.destination.connectionId ?? '') : '';
            await rollBackSubmission(pub, sid, parts, i, 'upload_unavailable', connectionId);
            noStore(reply);
            return { state: 'failed' };
          }
          const back: Part = { ...part, state: 'pending' };
          delete back.verifyingAt;
          await savePart(sid, i, back);
        }
        noStore(reply);
        return { state: 'pending' };
      },
    });

    // ---------------------------------------------------------------------------------- status (to resume a retry)
    fastify.route({
      method: 'GET',
      url: '/api/public/forms/:publicId/submissions/:sid',
      logLevel: 'silent',
      config: { op: 'status' },
      onRequest,
      handler: async (req) => {
        const pub = pubOf(req);
        const row = await authorise(req, pub, (req.params as { sid: string }).sid);
        const expired =
          new Date(row.expires_at).getTime() <= ctx.clock.now().getTime() && row.status !== 'complete';
        const out: SubmissionStatusDto = {
          status: expired ? 'expired' : row.status,
          parts: (row.parts as Part[]).map((p) => {
            const stale = staleCheck(p);
            return {
              field: p.field,
              index: p.index,
              state: stale ? ('failed' as const) : p.state,
              ...(stale ? { error: 'timeout' } : p.error ? { error: p.error } : {}),
            };
          }),
        };
        return out;
      },
    });

    // ---------------------------------------------------------------------------------- complete
    fastify.route({
      method: 'POST',
      url: '/api/public/forms/:publicId/submissions/:sid/complete',
      logLevel: 'silent',
      config: { op: 'complete' },
      bodyLimit: SESSION_BOUND_BODY,
      onRequest,
      handler: async (req, reply) => {
        const pub = pubOf(req);
        const { sid } = req.params as { sid: string };
        const row = await authorise(req, pub, sid);
        const def = await definitionOf(pub);
        const done = (): SubmissionCompleteDto => ({
          status: 'complete',
          confirmation: def.settings.confirmationText,
        });
        if (row.status === 'complete') return done();
        if (row.status === 'expired' || new Date(row.expires_at).getTime() <= ctx.clock.now().getTime())
          throw new PfError(
            410,
            'submission_expired',
            'This submission timed out. Please send the form again.',
          );
        const parts = row.parts as Part[];
        const pending = parts.filter((p) => p.state !== 'stored');
        if (pending.length)
          throw new PfError(409, 'parts_missing', 'Some files still need to be sent.', {
            fields: pending.map((p) => ({ field: p.field, code: 'file_missing' })),
          });
        const body = CompleteSchema.safeParse(req.body);
        if (!body.success) throw new PfError(400, 'invalid_answers', 'The submission could not be read.');
        const manifest: UploadManifestEntry[] = parts.map((p) => ({
          field: p.field,
          index: 0,
          name: `file.${p.ext}`,
          size: p.size,
          sha256: p.sha256,
        }));
        const checked = checkPublicAnswers(def, body.data.answers, manifest);
        if (!checked.ok)
          throw new PfError(400, 'invalid_answers', 'Some answers need attention.', {
            fields: checked.errors,
          });

        // Claim: one complete at a time.
        const claimed = await one(
          ctx.pool,
          `UPDATE form_submissions SET status='storing', updated_at=$2 WHERE id=$1 AND status IN ('receiving','failed') RETURNING *`,
          [sid, ctx.clock.now()],
        );
        if (!claimed) {
          const again = await rowOf(pub, sid);
          if (again.status === 'complete') return done();
          throw new PfError(409, 'submission_busy', 'This submission is already being processed.');
        }

        try {
          const failWith = async (e: StorageWriteError) => {
            await ctx.pool.query(
              `UPDATE form_submissions SET status='failed', error_code=$2, updated_at=$3 WHERE id=$1`,
              [sid, e.code, ctx.clock.now()],
            );
          };
          const dest = def.settings.answersDestination;
          if (!dest.connectionId) {
            await failWith({ code: 'not_found', message: 'missing', retryable: false });
            throw new PfError(
              409,
              'destination_missing',
              "This form can't accept submissions. Please contact the firm.",
              { retryable: false },
            );
          }
          const linkRow = row.link_id
            ? await one(ctx.pool, 'SELECT reference, record_id FROM form_client_links WHERE id=$1', [
                row.link_id,
              ])
            : undefined;
          const at = new Date(row.created_at);
          const files = parts.map((p) => {
            const info = FORM_UPLOAD_TYPES[p.ext];
            const ref = p.reference as StorageReference;
            return {
              id: p.field,
              label: def.fields.find((f) => f.id === p.field)?.label ?? p.field,
              name: ref.path.split('/').pop() ?? p.field,
              size: p.size,
              sha256: p.sha256,
              contentType: info?.contentType ?? 'application/octet-stream',
              stored: { connectionId: ref.connectionId, path: ref.path, providerId: ref.providerId },
            };
          });
          const doc = {
            submissionId: sid,
            submittedAt: at,
            form: { id: pub.formId, title: def.settings.title, version: pub.version },
            client:
              linkRow && row.link_id
                ? { reference: linkRow.reference as string, linkId: row.link_id as string }
                : null,
            fields: def.fields,
            answers: body.data.answers,
            files,
          };
          type AnswersRefs = {
            html?: StorageReference;
            json?: StorageReference;
            pdf?: StorageReference;
            pdfError?: string;
          };
          const have = (claimed.answers_refs ?? {}) as AnswersRefs;
          const refs: AnswersRefs = { ...have };
          for (const kind of ['html', 'json'] as const) {
            if (refs[kind]) continue;
            const text = kind === 'html' ? buildAnswersHtml(doc) : buildAnswersJson(doc);
            const buf = Buffer.from(text, 'utf8');
            const w = await ctx.services.storage.write({
              orgId: pub.orgId,
              connectionId: dest.connectionId,
              folder: dest.folder,
              name: dest.name,
              vars: varsOf(def, sid, at, linkRow ?? null, 'answers', 'answers', kind),
              ext: kind,
              contentType: kind === 'html' ? 'text/html; charset=utf-8' : 'application/json',
              size: buf.length,
              source: (async function* () {
                yield buf;
              })(),
              submission: { orgId: pub.orgId, formId: pub.formId, submissionId: sid },
              // Only the answers HTML: the runner makes the PDF copy from it. The server never sees the PDF bytes.
              ...(kind === 'html' ? { derive: { pdf: true as const } } : {}),
            });
            if (!w.ok) {
              await failWith(w.error);
              if (w.error.code === 'runner_offline')
                return offline(req, reply, 'complete', pub, row.link_id, sid, [dest.connectionId]);
              throw storageFailure(w.error);
            }
            refs[kind] = w.reference;
            if (kind === 'html') {
              // No `derived` at all is an older runner: the copy is missing, which is not an error.
              if (w.derived?.pdf.ok) {
                refs.pdf = w.derived.pdf.reference;
                delete refs.pdfError;
              } else {
                delete refs.pdf;
                refs.pdfError = w.derived?.pdf.ok === false ? w.derived.pdf.code : 'pdf_unavailable';
              }
            }
            await ctx.pool.query(
              `UPDATE form_submissions SET answers_refs=$2::jsonb, updated_at=$3 WHERE id=$1`,
              [sid, JSON.stringify(refs), ctx.clock.now()],
            );
          }

          // Both documents have references: only now is the submission complete.
          const html = refs.html as StorageReference;
          const json = refs.json as StorageReference;
          await withAppendTx(ctx.pool, async (tx) => {
            const n = await tx.query(
              `UPDATE form_submissions SET status='complete', completed_at=$2, updated_at=$2, error_code=NULL, answers_refs=$3::jsonb
                WHERE id=$1 AND status='storing'`,
              [sid, ctx.clock.now(), JSON.stringify(refs)],
            );
            if (!n.rowCount) return;
            const events: any[] = [];
            if (row.link_id)
              events.push({
                type: 'FormClientLinkUsed',
                payload: { linkId: row.link_id, formId: pub.formId, orgId: pub.orgId, submissionId: sid },
              });
            events.push({
              type: 'FormSubmitted',
              payload: {
                submissionId: sid,
                formId: pub.formId,
                orgId: pub.orgId,
                version: pub.version,
                ...(row.link_id ? { linkId: row.link_id } : {}),
                answers: refs.pdf ? [html, json, refs.pdf] : [html, json],
                files: parts.map((p) => p.reference as StorageReference),
              },
            });
            await ctx.store.append(
              events.map((event) => ({
                streamId: streamId.form(pub.formId),
                event,
                actor: SYSTEM_ACTOR,
                scope: orgScope(pub.orgId),
              })),
              { tx },
            );
            if (!refs.pdf) {
              // One notice per submission (this runs once, inside the rowCount check). No answer text in it.
              const deskItemId = randomUUID();
              const ref = linkRow ? (linkRow.reference as string) : undefined;
              await ctx.store.append(
                [
                  {
                    streamId: streamId.desk(deskItemId),
                    event: {
                      type: 'DeskItemCreated',
                      payload: {
                        deskItemId,
                        kind: 'alert',
                        subkind: DESK_SUBKIND.formPdfMissing,
                        title: `PDF copy missing: ${def.settings.title}`,
                        body: [
                          "The answers were saved as JSON and HTML, but the PDF copy could not be made on the firm's workstation.",
                          `Open the HTML copy (${html.path}) and print it if you need a PDF.`,
                          ...(ref ? [`Client reference: ${ref}`] : []),
                          `Submission ${sid.slice(0, 8)}`,
                        ].join('\n'),
                        options: [{ id: 'dismiss', label: 'Dismiss', description: 'Close this notice.' }],
                        blocking: false,
                        pinned: false,
                        affectedCardIds: [],
                        askedBy: { kind: 'system' },
                        subjectKey: `form-pdf-missing:${sid}`,
                        data: {
                          formId: pub.formId,
                          submissionId: sid,
                          htmlPath: html.path,
                          reason: refs.pdfError ?? 'pdf_unavailable',
                        },
                      },
                    },
                    actor: SYSTEM_ACTOR,
                    scope: orgScope(pub.orgId),
                  },
                ],
                { tx },
              );
            }
          });
        } catch (err) {
          // An unexpected error after the claim must not leave the row 'storing': the retry would get submission_busy.
          await ctx.pool
            .query(
              `UPDATE form_submissions SET status='failed', error_code=COALESCE(error_code,'internal'), updated_at=$2 WHERE id=$1 AND status='storing'`,
              [sid, ctx.clock.now()],
            )
            .catch(() => undefined);
          throw err;
        }
        return done();
      },
    });
  };
}
