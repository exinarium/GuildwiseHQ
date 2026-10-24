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
import { lookupSession, SESSION_COOKIE } from './auth/sessions.ts';
import { createBillingRuntime } from './billing/runtime.ts';
import { createSocialClient, type SocialClient } from './blog/social-client.ts';
import type { WriterClient } from './blog/writer/client.ts';
import { BrowserGateway } from './browser-gateway/gateway.ts';
import { registerCeoReviewHook } from './ceo/review.ts';
import { createRoutingInterceptor } from './ceo/routing.ts';
import { SignalSweep } from './ceo/signals.ts';
import { registerCeoWakes } from './ceo/wakes.ts';
import { ChatRelay } from './chat/relay.ts';
import { type Clock, createClock } from './clock.ts';
import { createGithubApi } from './cloud/github.ts';
import { realSshConnector } from './cloud/ssh.ts';
import { registerBudgetHook } from './commands/budgets.ts';
import { registerDecisionHook } from './commands/decisions.ts';
import { registerDefinitionHook } from './commands/designer.ts';
import { registerDevopsMembershipHook } from './commands/devops.ts';
import { registerDevopsQuestionHook } from './commands/devops-routing.ts';
import { registerTasteHook } from './commands/taste.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import { createCostStampInterceptor } from './costs/stamp.ts';
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
import { withSimulationPrefix } from './mail/simulation.ts';
import { registerMediaProxy } from './media-proxy.ts';
import { createOrgStatusInterceptor } from './orgs/guard.ts';
import { reportServerError } from './platform-team/detectors.ts';
import { buildProjectors } from './projections/index.ts';
import { registerPushNotifier } from './push/notifier.ts';
import { adminRoutes } from './routes/admin.ts';
import { agentRoutes } from './routes/agents.ts';
import { approvalRoutes } from './routes/approval.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { authRoutes } from './routes/auth.ts';
import { backlogRoutes } from './routes/backlog.ts';
import { billingRoutes } from './routes/billing.ts';
import { blogApiRoutes } from './routes/blog-api.ts';
import { blogPlatformRoutes } from './routes/blog-platform.ts';
import { blogPublicRoutes } from './routes/blog-public.ts';
import { boardRoutes } from './routes/board.ts';
import { capabilityRoutes } from './routes/capabilities.ts';
import { cardAttachmentRoutes } from './routes/card-attachments.ts';
import { cardRoutes } from './routes/cards.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { ceoRoutes } from './routes/ceo.ts';
import { chatRoutes } from './routes/chats.ts';
import { cloudRoutes } from './routes/cloud.ts';
import { commitAsRoutes } from './routes/commit-as.ts';
import { costRoutes } from './routes/costs.ts';
import { deliveryRoutes } from './routes/delivery.ts';
import { designerRoutes } from './routes/designer.ts';
import { deskRoutes } from './routes/desk.ts';
import { devopsRoutes } from './routes/devops.ts';
import { digestRoutes } from './routes/digests.ts';
import { discoveryRoutes } from './routes/discovery.ts';
import { documentRoutes } from './routes/documents.ts';
import { graphRoutes } from './routes/graph.ts';
import { hookRoutes } from './routes/hooks.ts';
import { hrRoutes } from './routes/hr.ts';
import { inboundRoutes } from './routes/inbound.ts';
import { installerRoutes } from './routes/installer.ts';
import { intakeBatchRoutes } from './routes/intake-batches.ts';
import { intakeRoutes } from './routes/intakes.ts';
import { integrationRoutes } from './routes/integrations.ts';
import { interestRoutes } from './routes/interests.ts';
import { invitationRoutes } from './routes/invitations.ts';
import { ledgerRoutes } from './routes/ledger.ts';
import { orgChartRoutes } from './routes/org-chart.ts';
import { orgRoutes } from './routes/orgs.ts';
import { outboundRoutes } from './routes/outbound.ts';
import { packRoutes } from './routes/packs.ts';
import { phaseRoutes } from './routes/phases.ts';
import { platformRoutes } from './routes/platform.ts';
import { platformTeamRoutes } from './routes/platform-team.ts';
import { projectWorkflowRoutes } from './routes/project-workflows.ts';
import { projectRoutes } from './routes/projects.ts';
import { providerRoutes } from './routes/providers.ts';
import { pushRoutes } from './routes/push.ts';
import { qaRoutes } from './routes/qa.ts';
import { reportingRoutes } from './routes/reporting.ts';
import { researchRoutes } from './routes/research.ts';
import { runRoutes } from './routes/runs.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { sessionRoutes } from './routes/sessions.ts';
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
import { BoardService } from './sessions/board.ts';
import { DiscoveryService } from './sessions/discovery.ts';
import { SessionTurns } from './sessions/turns.ts';
import { SimulationHostImpl } from './simulation/host.ts';

export interface BuildOptions {
  /** Start dispatcher/reaper timers (production). Tests drive them explicitly. */
  background?: boolean;
  mailer?: Mailer;
  /** The Anthropic client of the landing-page assistant (tests pass a fake; default: the real SDK when a key is set). */
  assistantClient?: AnthropicLike | null;
  /** Facebook and LinkedIn; tests pass a fake, nothing else reaches those networks. */
  social?: SocialClient;
  /** The blog writer's Anthropic client (tests pass a fake or nothing; default: the real SDK when a key is set). */
  blogWriterClient?: WriterClient | null;
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
/**
 * The page `/` serves: the app for a visitor whose session cookie is still valid, the landing page for everyone else
 * (no cookie, or a stale one left after a sign-out elsewhere, a password reset or an expiry).
 */
export function landingFor(
  cookies: Record<string, string | undefined>,
  root: string,
  sessionValid = !!cookies[SESSION_COOKIE],
): 'landing.html' | 'index.html' {
  return !(cookies[SESSION_COOKIE] && sessionValid) && existsSync(join(root, 'landing.html'))
    ? 'landing.html'
    : 'index.html';
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
    // the card capture posts a form to PayFast's hosted page
    "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
    "frame-ancestors 'none'",
    ...(config.secureCookies ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** pino `redact` options: a sealed envelope of the Integrations page never reaches a log line, whatever object holds it. */
export const LOG_REDACT = {
  paths: ['req.body.envelope', '*.envelope', 'body.envelope', 'payload.envelope', 'err.body.envelope'],
  censor: '[redacted]',
};

export async function createApp(config: Config, opts: BuildOptions = {}): Promise<AomApp> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            serializers: { req: requestLogSerializer },
            // Second line of defence: sealed envelopes of the Integrations page must never reach a log line.
            redact: LOG_REDACT,
          },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  }) as unknown as AomApp;
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const clock = opts.clock ?? createClock();
  const pool = createPool(config.databaseUrl);
  const store = new PgEventStore(pool, buildProjectors(), clock);
  const notifier = new Notifier(config.databaseUrl, store, (err) => app.log.error({ err }, 'notifier error'));
  const mailer = withSimulationPrefix(opts.mailer ?? createMailer(config.smtpUrl, config.mailFrom), pool);
  const ctx: Ctx = {
    config,
    clock,
    pool,
    store,
    notifier,
    mailer,
    social: opts.social ?? createSocialClient(),
    blogWriter:
      opts.blogWriterClient !== undefined
        ? opts.blogWriterClient
        : config.anthropicApiKey
          ? (new Anthropic({
              apiKey: config.anthropicApiKey,
              maxRetries: 1,
              // an article with web searches takes a minute or two
              timeout: 300_000,
            }) as unknown as WriterClient)
          : null,
    log: app.log,
    services: {} as Ctx['services'],
  };
  store.intercept(createRoutingInterceptor(ctx));
  // Suspended and cancelled organizations are read-only for their users, whichever route a write came through.
  store.intercept(createOrgStatusInterceptor(ctx));
  // Prices are stamped on shift events when they are appended, so a price-table change never reprices history on rebuild.
  store.intercept(createCostStampInterceptor());
  app.decorate('ctx', ctx);
  app.decorateRequest('auth', null);

  // ---- error mapping: {error:{code,message,details?}}
  app.setErrorHandler((err: any, req, reply) => {
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
      // Platform team bug intake: a 5xx is a bug report (sanitised, deduped by route and error signature).
      reportServerError(ctx, req, err);
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
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    // Paystack signs the raw body: keep it for the webhook (only that route).
    if (req.url.split('?')[0] === '/api/billing/paystack/webhook')
      (req as unknown as { rawBody?: string }).rawBody = body as string;
    if (body === '' || body === undefined) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const e = new Error('invalid JSON body') as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  // Form posts stay raw strings: the one-click unsubscribe of the weekly digest (RFC 8058, mail programs) and PayFast's
  // ITN (its signature is checked over the fields in the order received). Nothing else reads forms.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

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
    // An attachment sets its own, stricter policy (sandboxed: no script ever runs from an uploaded file).
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', csp);
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
  await app.register(platformTeamRoutes(ctx));
  await app.register(workstationRoutes(ctx));
  await app.register(integrationRoutes(ctx));
  await app.register(installerRoutes(ctx));
  await app.register(cloudRoutes(ctx));
  await app.register(supportRoutes(ctx));
  await app.register(projectRoutes(ctx));
  await app.register(projectWorkflowRoutes(ctx));
  await app.register(cardRoutes(ctx));
  await app.register(qaRoutes(ctx));
  await app.register(agentRoutes(ctx));
  await app.register(catalogueRoutes(ctx));
  await app.register(shiftRoutes(ctx));
  await app.register(deskRoutes(ctx));
  await app.register(ledgerRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.register(ceoRoutes(ctx));
  await app.register(threadRoutes(ctx));
  await app.register(vaultRoutes(ctx));
  await app.register(graphRoutes(ctx));
  await app.register(deliveryRoutes(ctx));
  await app.register(devopsRoutes(ctx));
  await app.register(providerRoutes(ctx));
  await app.register(runRoutes(ctx));
  await app.register(commitAsRoutes(ctx));
  await app.register(sharingRoutes(ctx));
  await app.register(testingRoutes(ctx));
  await app.register(scheduleRoutes(ctx));
  await app.register(inboundRoutes(ctx));
  await app.register(hookRoutes(ctx));
  await app.register(approvalRoutes(ctx));
  await app.register(interestRoutes(ctx));
  await app.register(digestRoutes(ctx));
  await app.register(researchRoutes(ctx));
  await app.register(intakeRoutes(ctx));
  await app.register(backlogRoutes(ctx));
  await app.register(sessionRoutes(ctx));
  await app.register(discoveryRoutes(ctx));
  await app.register(boardRoutes(ctx));
  await app.register(documentRoutes(ctx));
  await app.register(capabilityRoutes(ctx));
  await app.register(packRoutes(ctx));
  await app.register(intakeBatchRoutes(ctx));
  await app.register(hrRoutes(ctx));
  await app.register(designerRoutes(ctx));
  await app.register(outboundRoutes(ctx));
  await app.register(phaseRoutes(ctx));
  await app.register(reportingRoutes(ctx));
  await app.register(setupChecklistRoutes(ctx));
  await app.register(pushRoutes(ctx));
  await app.register(cardAttachmentRoutes(ctx));
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
  await app.register(blogPlatformRoutes(ctx));
  await app.register(blogApiRoutes(ctx));
  await app.register(blogPublicRoutes(ctx));
  await app.register(billingRoutes(ctx));

  // Gateways: runner WS (/api/runner/ws) and browser WS (/api/ws).
  const runners = new RunnerRegistry();
  const gateway = new RunnerGateway(ctx);
  const browser = new BrowserGateway(ctx);
  const dispatcher = new Dispatcher(ctx);
  const reaper = new Reaper(ctx);
  const scheduler = new Scheduler(ctx);
  const signals = new SignalSweep(ctx);
  Object.assign(ctx.services, { runners, gateway, browser, dispatcher, reaper, scheduler, signals });
  ctx.services.cloud = { ssh: realSshConnector, github: createGithubApi(), pending: new Set() };
  ctx.services.chat = new ChatRelay(ctx);
  ctx.services.sessions = new SessionTurns(ctx);
  ctx.services.discovery = new DiscoveryService(ctx);
  ctx.services.board = new BoardService(ctx);
  ctx.services.billing = createBillingRuntime(config);
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
      await ctx.services.scheduler.runBilling();
      await ctx.services.signals.run();
      ctx.services.dispatcher.trigger();
      return { now: clock.now().toISOString(), offsetMs: clock.offsetMs };
    });
  }

  // The help videos live in the media container: /videos/* is forwarded there (404 when AOM_MEDIA_URL is unset).
  registerMediaProxy(app, config.mediaUrl);

  if (config.serveWeb) {
    const root = webDistDir(config);
    if (root) {
      // `/` is the app for a visitor with a valid session and the landing page for everyone else. A stale cookie (the
      // session ended by a sign-out elsewhere, a password reset or an expiry) gets the landing page and is cleared, so
      // nobody is bounced to /login just for opening the site. The page differs by cookie: never share it.
      // The service worker must be revalidated on every load (an update has to reach the phone) and may control `/`; the
      // manifest and the offline page change with a release. Hashed `/assets/*` keep the default caching. (Set in onSend:
      // @fastify/static writes its own cache-control after `setHeaders`.)
      await app.register(fastifyStatic, { root, wildcard: false, index: false });
      app.addHook('onSend', async (req, reply) => {
        if (req.method !== 'GET' || reply.statusCode !== 200) return;
        const path = req.url.split('?')[0];
        if (path === '/sw.js') {
          void reply
            .header('cache-control', 'no-cache, no-store, must-revalidate')
            .header('service-worker-allowed', '/')
            .header('content-type', 'text/javascript; charset=utf-8');
        } else if (path === '/manifest.webmanifest')
          void reply
            .header('cache-control', 'no-cache')
            .header('content-type', 'application/manifest+json; charset=utf-8');
        else if (path === '/offline.html') void reply.header('cache-control', 'no-cache');
      });
      app.get('/', async (req, reply) => {
        void reply.header('cache-control', 'no-cache').header('vary', 'Cookie');
        const token = req.cookies[SESSION_COOKIE];
        const valid = token ? !!(await lookupSession(ctx, token).catch(() => null)) : false;
        if (token && !valid) void reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.sendFile(landingFor(req.cookies, root, valid));
      });
      // The public legal pages: prerendered from apps/web/src/legal/*.md at build time, for everyone (signed in or not).
      for (const doc of ['privacy', 'terms', 'trust', 'popia'] as const)
        app.get(`/${doc}`, (_req, reply) => {
          void reply.header('cache-control', 'no-cache');
          return reply.sendFile(existsSync(join(root, `${doc}.html`)) ? `${doc}.html` : 'index.html');
        });
    } else app.log.warn('AOM_SERVE_WEB is set but apps/web/dist was not found');
  }

  const unhookDecisions = registerDecisionHook(ctx);
  const unhookTaste = registerTasteHook(ctx);
  const unhookBudgets = registerBudgetHook(ctx);
  const unhookDiscovery = ctx.services.discovery.registerHook();
  const unhookBoard = ctx.services.board.registerHook();
  const unhookHr = registerHrHook(ctx);
  const unhookCeoWakes = registerCeoWakes(ctx);
  const unhookDefinitions = registerDefinitionHook(ctx);
  const unhookDevops = registerDevopsMembershipHook(ctx);
  const unhookDevopsQuestions = registerDevopsQuestionHook(ctx);
  const unhookCeoReview = registerCeoReviewHook(ctx);
  if (config.push.enabled) ctx.services.push = registerPushNotifier(ctx);
  await notifier.start();
  // Simulation organizations: the simulated workstations come up with the server (not under tests unless asked for).
  const simulation = config.simulationHost ? new SimulationHostImpl(ctx) : undefined;
  if (simulation) ctx.services.simulation = simulation;
  if (simulation && opts.background) await simulation.start();
  if (opts.background) {
    dispatcher.start();
    reaper.start();
    scheduler.start();
    signals.start();
  }

  app.addHook('onClose', async () => {
    unhookDecisions();
    unhookTaste();
    unhookBudgets();
    unhookDiscovery();
    unhookBoard();
    unhookHr();
    unhookCeoWakes();
    unhookDefinitions();
    unhookDevops();
    unhookDevopsQuestions();
    unhookCeoReview();
    ctx.services.push?.stop();
    await simulation?.stop();
    await signals.stop();
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
