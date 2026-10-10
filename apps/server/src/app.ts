import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { RUNNER_SUBPROTOCOL } from '@aom/shared';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AnthropicLike } from './assistant/service.ts';
import { checkContentType, checkOrigin } from './auth/origin-check.ts';
import { SESSION_COOKIE } from './auth/sessions.ts';
import { BrowserGateway } from './browser-gateway/gateway.ts';
import { ChatRelay } from './chat/relay.ts';
import { type Clock, createClock } from './clock.ts';
import { createGithubApi } from './cloud/github.ts';
import { realSshConnector } from './cloud/ssh.ts';
import { registerBudgetHook } from './commands/budgets.ts';
import { registerDecisionHook } from './commands/decisions.ts';
import { registerDefinitionHook } from './commands/designer.ts';
import { registerDevopsMembershipHook } from './commands/devops.ts';
import { registerTasteHook } from './commands/taste.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import { createPool } from './db/pool.ts';
import { rows } from './db/sql.ts';
import { Dispatcher } from './dispatcher/dispatcher.ts';
import { Reaper } from './dispatcher/reaper.ts';
import { HttpError } from './errors.ts';
import { Notifier } from './eventstore/notifier.ts';
import { PgEventStore } from './eventstore/pg-event-store.ts';
import { ConcurrencyError } from './eventstore/types.ts';
import { registerHrHook } from './hr/hr.ts';
import { createMailer, type Mailer } from './mail/mailer.ts';
import { createOrgStatusInterceptor } from './orgs/guard.ts';
import { buildProjectors } from './projections/index.ts';
import { Reporter } from './reporter/reporter.ts';
import { createRoutingInterceptor } from './reporter/routing.ts';
import { adminRoutes } from './routes/admin.ts';
import { agentRoutes } from './routes/agents.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { authRoutes } from './routes/auth.ts';
import { cardRoutes } from './routes/cards.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { chatRoutes } from './routes/chats.ts';
import { cloudRoutes } from './routes/cloud.ts';
import { costRoutes } from './routes/costs.ts';
import { designerRoutes } from './routes/designer.ts';
import { deskRoutes } from './routes/desk.ts';
import { devopsRoutes } from './routes/devops.ts';
import { digestRoutes } from './routes/digests.ts';
import { hrRoutes } from './routes/hr.ts';
import { installerRoutes } from './routes/installer.ts';
import { intakeRoutes } from './routes/intakes.ts';
import { interestRoutes } from './routes/interests.ts';
import { invitationRoutes } from './routes/invitations.ts';
import { ledgerRoutes } from './routes/ledger.ts';
import { orgChartRoutes } from './routes/org-chart.ts';
import { orgRoutes } from './routes/orgs.ts';
import { outboundRoutes } from './routes/outbound.ts';
import { phaseRoutes } from './routes/phases.ts';
import { platformRoutes } from './routes/platform.ts';
import { projectRoutes } from './routes/projects.ts';
import { reportingRoutes } from './routes/reporting.ts';
import { researchRoutes } from './routes/research.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { setupChecklistRoutes } from './routes/setup-checklist.ts';
import { sharingRoutes } from './routes/sharing.ts';
import { shiftRoutes } from './routes/shifts.ts';
import { supportRoutes } from './routes/support.ts';
import { testingRoutes } from './routes/testing.ts';
import { threadRoutes } from './routes/threads.ts';
import { vaultRoutes } from './routes/vaults.ts';
import { workstationRoutes } from './routes/workstations.ts';
import { RunnerGateway } from './runner-gateway/gateway.ts';
import { RunnerRegistry } from './runner-gateway/registry.ts';
import { Scheduler } from './scheduler/scheduler.ts';

export interface BuildOptions {
  /** Start dispatcher/reaper timers (production). Tests drive them explicitly. */
  background?: boolean;
  mailer?: Mailer;
  /** The Anthropic client of the landing-page assistant (tests pass a fake; default: the real SDK when a key is set). */
  assistantClient?: AnthropicLike | null;
  clock?: Clock;
  /** Fastify logger: `false` silences it. Defaults to config.logLevel. */
  logger?: boolean;
}

export interface AomApp extends FastifyInstance {
  ctx: Ctx;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
}

/** Which built page `/` serves: the landing page when nobody has a session cookie (and the build has one), else the app. */
export function landingFor(
  cookies: Record<string, string | undefined>,
  root: string,
): 'landing.html' | 'index.html' {
  return !cookies[SESSION_COOKIE] && existsSync(join(root, 'landing.html')) ? 'landing.html' : 'index.html';
}

function webDistDir(config: Config): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    config.webDist,
    join(here, '../../web/dist'),
    join(here, '../web/dist'),
    join(here, 'web'),
  ].filter((x): x is string => !!x);
  return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? null;
}

/** Secrets that travel in URLs: invitation tokens (`/api/invitations/<t>`, `/invite/<t>`) and pairing codes. */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/(?:api\/invitations|invite)\/)[^/?#\s]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|code|invite|pairing[_-]?code)=)[^&#\s]*/gi, '$1[redacted]');
}

/** pino `req` serializer: the default one with the URL redacted. */
export const requestLogSerializer = (req: {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  socket?: { remotePort?: number };
}) => ({
  method: req.method,
  url: redactUrl(req.url ?? ''),
  host: req.hostname,
  remoteAddress: req.ip,
  remotePort: req.socket?.remotePort,
});

/**
 * CSP for the built web app: Vite emits only same-origin module scripts and CSS files, React sets inline style
 * attributes (hence `style-src 'unsafe-inline'`, no inline scripts), the browser talks to `/api` and `/api/ws` of the
 * same origin. Everything else (objects, framing, foreign forms, base tag) is shut.
 */
export function contentSecurityPolicy(config: { publicOrigin: string; secureCookies: boolean }): string {
  let ws = '';
  try {
    const u = new URL(config.publicOrigin);
    ws = `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
  } catch {
    // an unparsable origin falls back to 'self' only
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${ws ? ` ${ws}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(config.secureCookies ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export async function createApp(config: Config, opts: BuildOptions = {}): Promise<AomApp> {
  const app = Fastify({
    logger:
      opts.logger === false ? false : { level: config.logLevel, serializers: { req: requestLogSerializer } },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  }) as unknown as AomApp;
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const clock = opts.clock ?? createClock();
  const pool = createPool(config.databaseUrl);
  const store = new PgEventStore(pool, buildProjectors(), clock);
  const notifier = new Notifier(config.databaseUrl, store, (err) => app.log.error({ err }, 'notifier error'));
  const mailer = opts.mailer ?? createMailer(config.smtpUrl, config.mailFrom);
  const ctx: Ctx = {
    config,
    clock,
    pool,
    store,
    notifier,
    mailer,
    log: app.log,
    services: {} as Ctx['services'],
  };
  store.intercept(createRoutingInterceptor(ctx));
  // Suspended and cancelled organizations are read-only for their users, whichever route a write came through.
  store.intercept(createOrgStatusInterceptor(ctx));
  app.decorate('ctx', ctx);
  app.decorateRequest('auth', null);

  // ---- error mapping: {error:{code,message,details?}}
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'request validation failed', details: err.validation },
      });
    }
    if (err instanceof ConcurrencyError) {
      return reply.code(409).send({ error: { code: 'concurrency_conflict', message: err.message } });
    }
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 500;
    if (status === 500) {
      app.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: { code: 'internal_error', message: 'internal server error' } });
    }
    const code = status === 429 ? 'rate_limited' : status === 415 ? 'unsupported_media_type' : 'bad_request';
    return reply.code(status).send({ error: { code, message: err.message } });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && config.serveWeb && webDistDir(config)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'not found' } });
  });

  // JSON bodies: tolerate an empty body (clients that always send the header).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const e = new Error('invalid JSON body') as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  await app.register(cookie);
  if (config.rateLimit) await app.register(rateLimit, { global: false, hook: 'preHandler' });

  app.addHook('onRequest', async (req) => {
    checkOrigin(config, req);
    checkContentType(req);
  });
  const csp = contentSecurityPolicy(config);
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', csp);
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    // HSTS only where the public origin is https (a plain-http dev server must not pin browsers to https).
    if (config.secureCookies)
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await rows(pool, 'SELECT 1');
      return { ok: true, db: true };
    } catch {
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  await app.register(authRoutes(ctx));
  await app.register(invitationRoutes(ctx));
  await app.register(adminRoutes(ctx));
  await app.register(orgRoutes(ctx));
  await app.register(platformRoutes(ctx));
  await app.register(workstationRoutes(ctx));
  await app.register(installerRoutes(ctx));
  await app.register(cloudRoutes(ctx));
  await app.register(supportRoutes(ctx));
  await app.register(projectRoutes(ctx));
  await app.register(cardRoutes(ctx));
  await app.register(agentRoutes(ctx));
  await app.register(catalogueRoutes(ctx));
  await app.register(shiftRoutes(ctx));
  await app.register(deskRoutes(ctx));
  await app.register(ledgerRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.register(threadRoutes(ctx));
  await app.register(vaultRoutes(ctx));
  await app.register(devopsRoutes(ctx));
  await app.register(sharingRoutes(ctx));
  await app.register(testingRoutes(ctx));
  await app.register(scheduleRoutes(ctx));
  await app.register(interestRoutes(ctx));
  await app.register(digestRoutes(ctx));
  await app.register(researchRoutes(ctx));
  await app.register(intakeRoutes(ctx));
  await app.register(hrRoutes(ctx));
  await app.register(designerRoutes(ctx));
  await app.register(outboundRoutes(ctx));
  await app.register(phaseRoutes(ctx));
  await app.register(reportingRoutes(ctx));
  await app.register(setupChecklistRoutes(ctx));
  const assistantClient =
    opts.assistantClient !== undefined
      ? opts.assistantClient
      : config.anthropicApiKey
        ? (new Anthropic({
            apiKey: config.anthropicApiKey,
            maxRetries: 1,
            timeout: 60_000,
          }) as unknown as AnthropicLike)
        : null;
  await app.register(assistantRoutes(ctx, assistantClient));
  await app.register(costRoutes(ctx));
  await app.register(orgChartRoutes(ctx));

  // Gateways: runner WS (/api/runner/ws) and browser WS (/api/ws).
  const runners = new RunnerRegistry();
  const gateway = new RunnerGateway(ctx);
  const browser = new BrowserGateway(ctx);
  const dispatcher = new Dispatcher(ctx);
  const reaper = new Reaper(ctx);
  const scheduler = new Scheduler(ctx);
  const reporter = new Reporter(ctx);
  Object.assign(ctx.services, { runners, gateway, browser, dispatcher, reaper, scheduler, reporter });
  ctx.services.cloud = { ssh: realSshConnector, github: createGithubApi(), pending: new Set() };
  ctx.services.chat = new ChatRelay(ctx);
  await app.register(websocket, {
    options: {
      maxPayload: 8 * 1024 * 1024,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(RUNNER_SUBPROTOCOL) ? RUNNER_SUBPROTOCOL : false,
    },
  });
  await app.register(async (inner) => {
    gateway.register(inner);
    browser.register(inner);
  });

  if (config.testClock) {
    app.post('/api/test/clock', async (req) => {
      const b = (req.body ?? {}) as { offsetMs?: number; advanceMs?: number };
      if (typeof b.offsetMs === 'number') clock.setOffset(b.offsetMs);
      if (typeof b.advanceMs === 'number') clock.advance(b.advanceMs);
      // Time-dependent housekeeping (lease expiry, accept timeout) runs immediately instead of on the next tick.
      await ctx.services.reaper.run();
      await ctx.services.scheduler.run();
      await ctx.services.scheduler.runLicensing();
      await ctx.services.reporter.run();
      ctx.services.dispatcher.trigger();
      return { now: clock.now().toISOString(), offsetMs: clock.offsetMs };
    });
  }

  if (config.serveWeb) {
    const root = webDistDir(config);
    if (root) {
      // `/` is the landing page for visitors without a session cookie and the app for everyone else (the app then sends
      // a signed-in person to their workspace and a stale cookie to /login). The page differs by cookie: never share it.
      await app.register(fastifyStatic, { root, wildcard: false, index: false });
      app.get('/', (req, reply) => {
        void reply.header('cache-control', 'no-cache').header('vary', 'Cookie');
        return reply.sendFile(landingFor(req.cookies, root));
      });
      // The public legal pages: prerendered from apps/web/src/legal/*.md at build time, for everyone (signed in or not).
      for (const doc of ['privacy', 'terms'] as const)
        app.get(`/${doc}`, (_req, reply) => {
          void reply.header('cache-control', 'no-cache');
          return reply.sendFile(existsSync(join(root, `${doc}.html`)) ? `${doc}.html` : 'index.html');
        });
    } else app.log.warn('AOM_SERVE_WEB is set but apps/web/dist was not found');
  }

  const unhookDecisions = registerDecisionHook(ctx);
  const unhookTaste = registerTasteHook(ctx);
  const unhookBudgets = registerBudgetHook(ctx);
  const unhookHr = registerHrHook(ctx);
  const unhookDefinitions = registerDefinitionHook(ctx);
  const unhookDevops = registerDevopsMembershipHook(ctx);
  await notifier.start();
  if (opts.background) {
    dispatcher.start();
    reaper.start();
    scheduler.start();
    reporter.start();
  }

  app.addHook('onClose', async () => {
    unhookDecisions();
    unhookTaste();
    unhookBudgets();
    unhookHr();
    unhookDefinitions();
    unhookDevops();
    await reporter.stop();
    await scheduler.stop();
    await dispatcher.stop();
    await reaper.stop();
    await gateway.stop();
    await browser.stop();
    await notifier.stop();
    mailer.close();
    await pool.end();
  });
  return app;
}
