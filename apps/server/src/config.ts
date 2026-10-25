import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * `AOM_EXTRA_ORIGINS`: comma-separated exact origins (`scheme://host[:port]`), normalised the way a browser sends the Origin
 * header. A wildcard, a path, a query, credentials or any other scheme than http(s) stops the boot: the list is what the
 * CSRF check trusts, so a typo must not quietly widen it.
 */
export function parseExtraOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const v = part.trim();
    if (!v) continue;
    const bad = (why: string): never => {
      throw new Error(`AOM_EXTRA_ORIGINS: "${v}" ${why}`);
    };
    if (v.includes('*')) {
      bad('is not allowed: wildcards are never accepted');
    }
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return bad('is not a valid origin (use scheme://host[:port])');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      bad('must be an http or https origin');
    }
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
      bad('must be an origin only (no path, query or credentials)');
    }
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://aom:aom@127.0.0.1:5433/aom'),
  AOM_PORT: z.coerce.number().int().min(0).max(65535).default(4600),
  AOM_HOST: z.string().default('127.0.0.1'),
  AOM_PUBLIC_ORIGIN: z.string().default('http://localhost:5173'),
  /** More origins the web app may be opened from (a LAN address next to the public one): comma-separated exact origins. */
  AOM_EXTRA_ORIGINS: z
    .string()
    .optional()
    .superRefine((v, ctx) => {
      try {
        parseExtraOrigins(v);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
      }
    })
    .transform((v) => {
      try {
        return parseExtraOrigins(v);
      } catch {
        return [];
      }
    }),
  AOM_SMTP_URL: z.string().default('smtp://127.0.0.1:1025'),
  AOM_MAIL_FROM: z.string().default('Guildwise HQ <noreply@aom.local>'),
  AOM_MIGRATE_ON_BOOT: bool(true),
  AOM_DATA_MIGRATIONS: bool(true),
  NODE_ENV: z.string().optional(),
  AOM_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  AOM_SERVE_WEB: bool(false),
  AOM_WEB_DIST: z.string().optional(),
  AOM_MEDIA_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL')
      .optional(),
  ),
  /** Per client address: simultaneous /videos requests (0 = no limit) and requests per minute (0 = no limit). */
  AOM_MEDIA_MAX_CONCURRENT_PER_IP: z.coerce.number().int().min(0).max(1000).default(8),
  AOM_MEDIA_RATE_PER_MIN: z.coerce.number().int().min(0).max(100000).default(240),
  AOM_RATE_LIMIT: bool(true),
  AOM_TEST_CLOCK: bool(false),
  AOM_ALLOW_LOCAL_REMOTES: bool(false),
  AOM_MOCK_UI: bool(false),
  /** The workflow new projects start on (`code`, version 6 is the lean team flow). Existing projects keep theirs. */
  AOM_DEFAULT_WORKFLOW: z.string().min(1).default('code'),
  AOM_TOUR_AUTOSTART: bool(true),
  AOM_REPORTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  AOM_HYGIENE_SCHEDULE: bool(true),
  AOM_WEBHOOK_ALLOW_PRIVATE: bool(false),
  /** Platform ceiling for the shifts one workstation runs at once; 0 = no ceiling (backlog #76). */
  AOM_MAX_SHIFTS_PER_WORKSTATION: z.coerce.number().int().min(0).max(100000).default(16),
  /** Where the packaged runner (`aom-runner-<version>.tgz`, `pnpm package:runner`) is served from. */
  AOM_RUNNER_RELEASE_DIR: z.string().optional(),
  /** The support address new Contact us requests are emailed to, until the super admin sets one in the platform settings. */
  AOM_SUPPORT_EMAIL: z.string().optional(),
  /** From address of the support mails to the customer (acknowledgement, replies), e.g. `Guildwise HQ Support <support@guildwisehq.com>`. Unset: AOM_MAIL_FROM. */
  AOM_SUPPORT_FROM: z.string().optional(),
  /** Inbound e-mail (docs/SELF-HOSTING.md "Inbound e-mail"): the mail provider that posts to `/api/inbound/mail/<provider>`. Unset: no inbound mail. `fake` is for development and tests. */
  AOM_INBOUND_PROVIDER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['postmark', 'sendgrid', 'fake']).optional(),
  ),
  /** The domain organisation addresses are made on (`<slug>-<random>@<domain>`), e.g. `in.guildwisehq.com`. */
  AOM_INBOUND_DOMAIN: z.string().optional(),
  /** Shared secret of the provider webhook: the password of the Basic-auth URL given to Postmark or SendGrid (or the `X-AOM-Inbound-Secret` header). */
  AOM_INBOUND_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  /** Largest message (all parts, attachments included) that is stored; bigger ones are recorded as skipped. */
  AOM_INBOUND_MAX_BYTES: z.coerce.number().int().min(10_000).max(35_000_000).default(10_000_000),
  /** Messages one organisation can receive per hour; more are recorded as skipped. */
  AOM_INBOUND_RATE_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(60),
  AOM_INBOUND_RATE_PER_SENDER_PER_HOUR: z.coerce.number().int().min(0).max(100_000).default(20),
  /** Spam score (SpamAssassin scale) from which a message is skipped as spam. */
  AOM_INBOUND_SPAM_THRESHOLD: z.coerce.number().min(0).max(100).default(5),
  /** Anthropic API key for the public landing-page assistant (a secret: never sent to the browser, never logged). */
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  /** Kill switch of the assistant: `off` or `public` (landing page). Unset: `public` when a key is set, else `off`. */
  AOM_ASSISTANT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['off', 'public']).optional()),
  /** Spend ceiling per UTC day for the public assistant, in US dollars. */
  AOM_ASSISTANT_PUBLIC_DAILY_USD: z.coerce.number().min(0).max(10_000).default(2),
  /** Model of the public assistant. */
  AOM_ASSISTANT_MODEL_PUBLIC: z.string().min(1).default('claude-haiku-4-5'),
  /** Weekly blog digest mail (Monday 08:00 Africa/Johannesburg). Switch off with AOM_BLOG_DIGEST=false (the platform setting can also stop it). */
  AOM_BLOG_DIGEST: bool(true),
  /**
   * Shows the "Share diagnostic data with Guildwise" consent switch to customer organizations (default off). Keep it off
   * until the consent text (packages/shared/src/orgs/diagnostics-consent.ts) has been reviewed under POPIA. The platform
   * organization (the owner's own) always has the switch.
   */
  AOM_DIAGNOSTICS_CONSENT_CUSTOMERS: bool(false),
  /** The Monday briefing mail per member (Monday 08:00 in the organization's time zone). Switch off with AOM_WEEKLY_BRIEFING=false. */
  AOM_WEEKLY_BRIEFING: bool(true),
  /** LinkedIn app credentials, only needed to renew the organization token with its refresh token. */
  AOM_LINKEDIN_CLIENT_ID: z.string().optional(),
  AOM_LINKEDIN_CLIENT_SECRET: z.string().optional(),
  /**
   * Simulation organizations: host their simulated workstation (a mock runner the server starts and supervises).
   * Unset: on, except under tests.
   */
  AOM_SIMULATION_HOST: z.preprocess(
    (v) => (v === '' || v === undefined ? (process.env.NODE_ENV === 'test' ? 'false' : 'true') : v),
    bool(true),
  ),
  /** Where simulated workstations keep their files (runner data, local repositories). Default: a folder in the temp dir. */
  AOM_SIMULATION_DIR: z.string().optional(),
  /** The runner entry file the server starts for a simulation (`aom-runner.mjs`). Unset: unpacked from the runner release, or found in the repo. */
  AOM_SIMULATION_RUNNER_BIN: z.string().optional(),
  /** How the simulated runner reaches this server. Unset: `http://127.0.0.1:<AOM_PORT>`. */
  AOM_SIMULATION_SERVER_URL: z.string().optional(),
  /** Web Push (docs/SELF-HOSTING.md "Web Push"): the VAPID key pair (`node dist/vapid-generate.mjs` in the app container) and a contact (`mailto:` or `https:`). All three must be set, else push is off. */
  AOM_VAPID_PUBLIC_KEY: z.string().optional(),
  AOM_VAPID_PRIVATE_KEY: z.string().optional(),
  AOM_VAPID_SUBJECT: z.string().optional(),
  /** A workstation must stay disconnected this long before its owner is notified (restarts and updates reconnect within it). */
  AOM_PUSH_OFFLINE_GRACE_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),
  /** Project graphs (docs/design/project-graphs.md): every project gets a vault and its code graph is indexed on the workstation. A kill switch, on by default. */
  /** Persona chats (R3c) are removed from the lists after this many days without a message (0: keep for ever). */
  AOM_PERSONA_CHAT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
  AOM_PROJECT_GRAPHS: bool(true),
  LOG_LEVEL: z.string().default('info'),
});

export interface Config {
  /** The environment this configuration was read from (extensions read their own settings from it). */
  env: Readonly<Record<string, string | undefined>>;
  databaseUrl: string;
  port: number;
  host: string;
  publicOrigin: string;
  /** Further exact origins accepted by the CSRF and WebSocket origin checks (`AOM_EXTRA_ORIGINS`), normalised. */
  extraOrigins: string[];
  smtpUrl: string;
  mailFrom: string;
  migrateOnBoot: boolean;
  /** Run the boot data migrations (`orgs-2026-10`, ...) after the SQL migrations. */
  dataMigrations: boolean;
  /** Encrypts the two-factor seeds at rest. Unset: a random key kept in the database (set it in production). */
  secretKey: string | undefined;
  serveWeb: boolean;
  webDist: string | undefined;
  /** The media service (help videos), e.g. `http://media:80`: `/videos/*` is forwarded there. Unset: videos are off. */
  mediaUrl: string | undefined;
  mediaMaxConcurrentPerIp: number;
  mediaRatePerMin: number;
  rateLimit: boolean;
  testClock: boolean;
  /** Accept `file://` and absolute-path git remotes (tests and the e2e harness only). */
  allowLocalRemotes: boolean;
  /** Mock-runtime card fields (Mock script, ...) are shown in the UI and accepted on the API (dev and e2e only). */
  mockUi: boolean;
  /** The workflow a new project starts on when the request names none (`code`). */
  defaultWorkflow: string;
  /** A user who has never seen the first-login tour gets it on their first visit (off in the e2e suite, which switches it on per user). */
  tourAutostart: boolean;
  /** How often the signal sweep (ceo/signals.ts) releases expired holds, runs the signal detectors, queues the CEO's daily review and the topics sweep. */
  reporterSeconds: number;
  /** Run the workstations' scheduled repository hygiene (each workstation's own cadence). "Run hygiene now" always works. */
  hygieneSchedule: boolean;
  /** Platform ceiling for a workstation's shift limit (its owner sets the limit on the Workstations page); 0 = none. */
  maxShiftsPerWorkstation: number;
  /** Let outgoing webhooks reach loopback and private-network addresses (local tests; off in production). */
  webhookAllowPrivate: boolean;
  /** Directory holding the runner release tarballs; undefined: the usual places are tried. */
  runnerReleaseDir: string | undefined;
  /** Fallback support address (the platform setting wins). */
  supportEmail: string | undefined;
  /** From address for support mails to customers; undefined: the normal `mailFrom`. */
  supportFrom: string | undefined;
  /** Inbound e-mail by provider webhook; `provider` undefined: switched off. */
  inbound: {
    provider: 'postmark' | 'sendgrid' | 'fake' | undefined;
    domain: string | undefined;
    secret: string | undefined;
    maxMessageBytes: number;
    ratePerHour: number;
    /** Per sender address and organisation; 0 = off. */
    ratePerSenderPerHour: number;
    spamThreshold: number;
  };
  /** Key of the Anthropic API (the public assistant); undefined: the assistant is off. */
  anthropicApiKey: string | undefined;
  /** The assistant kill switch (`AOM_ASSISTANT`): `public` only when a key is set and it is not switched off. */
  assistantMode: 'off' | 'public';
  assistantPublicDailyUsd: number;
  /** Days a persona chat may sit unused before it is removed (0: never). */
  personaChatRetentionDays: number;
  assistantModelPublic: string;
  /** Send the weekly blog digest (env switch; the super admin's blog settings are a second switch). */
  blogDigest: boolean;
  /** Customer organizations may see and set the diagnostic-data consent (AOM_DIAGNOSTICS_CONSENT_CUSTOMERS). */
  diagnosticsConsentForCustomers: boolean;
  /** Send the Monday briefing mails. */
  weeklyBriefing: boolean;
  linkedinClientId: string | undefined;
  linkedinClientSecret: string | undefined;
  /** `projectGraphs.enabled` (docs/design/project-graphs.md section 13). */
  projectGraphs: { enabled: boolean };
  logLevel: string;
  /** Host the simulated workstations of simulation organizations (see src/simulation). */
  simulationHost: boolean;
  simulationDir: string;
  simulationRunnerBin: string | undefined;
  simulationServerUrl: string | undefined;
  /** Cookie `Secure` flag: true when the public origin is https. */
  secureCookies: boolean;
  /** Web Push: `enabled` only with a complete, valid VAPID configuration. */
  push: {
    enabled: boolean;
    publicKey: string | undefined;
    privateKey: string | undefined;
    subject: string | undefined;
    offlineGraceSeconds: number;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  // Production must not run on the fallback key kept in the database: a dump of the database alone would then hold the
  // key next to the data it protects (two-factor seeds, connected-account tokens, signed links).
  if (e.NODE_ENV === 'production' && !e.AOM_SECRET_KEY)
    throw new Error(
      'AOM_SECRET_KEY is required in production: set it to a long random string (for example `openssl rand -base64 32`) and keep it with your backups.',
    );
  const publicOrigin = e.AOM_PUBLIC_ORIGIN.replace(/\/+$/, '');
  return {
    env: { ...env },
    databaseUrl: e.DATABASE_URL,
    port: e.AOM_PORT,
    host: e.AOM_HOST,
    publicOrigin,
    extraOrigins: e.AOM_EXTRA_ORIGINS,
    smtpUrl: e.AOM_SMTP_URL,
    mailFrom: e.AOM_MAIL_FROM,
    migrateOnBoot: e.AOM_MIGRATE_ON_BOOT,
    dataMigrations: e.AOM_DATA_MIGRATIONS,
    secretKey: e.AOM_SECRET_KEY,
    serveWeb: e.AOM_SERVE_WEB,
    webDist: e.AOM_WEB_DIST,
    mediaUrl: e.AOM_MEDIA_URL,
    mediaMaxConcurrentPerIp: e.AOM_MEDIA_MAX_CONCURRENT_PER_IP,
    mediaRatePerMin: e.AOM_MEDIA_RATE_PER_MIN,
    rateLimit: e.AOM_RATE_LIMIT,
    testClock: e.AOM_TEST_CLOCK,
    allowLocalRemotes: e.AOM_ALLOW_LOCAL_REMOTES,
    mockUi: e.AOM_MOCK_UI,
    defaultWorkflow: e.AOM_DEFAULT_WORKFLOW,
    tourAutostart: e.AOM_TOUR_AUTOSTART,
    reporterSeconds: e.AOM_REPORTER_SECONDS,
    hygieneSchedule: e.AOM_HYGIENE_SCHEDULE,
    maxShiftsPerWorkstation: e.AOM_MAX_SHIFTS_PER_WORKSTATION,
    webhookAllowPrivate: e.AOM_WEBHOOK_ALLOW_PRIVATE,
    runnerReleaseDir: e.AOM_RUNNER_RELEASE_DIR || undefined,
    supportEmail: e.AOM_SUPPORT_EMAIL || undefined,
    supportFrom: e.AOM_SUPPORT_FROM?.trim() || undefined,
    inbound: {
      provider: e.AOM_INBOUND_PROVIDER,
      domain: e.AOM_INBOUND_DOMAIN?.trim().toLowerCase().replace(/^@/, '') || undefined,
      secret: e.AOM_INBOUND_SECRET,
      maxMessageBytes: e.AOM_INBOUND_MAX_BYTES,
      ratePerHour: e.AOM_INBOUND_RATE_PER_HOUR,
      ratePerSenderPerHour: e.AOM_INBOUND_RATE_PER_SENDER_PER_HOUR,
      spamThreshold: e.AOM_INBOUND_SPAM_THRESHOLD,
    },
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    // Off without a key, whatever the switch says; with a key it is on unless switched off.
    assistantMode: e.ANTHROPIC_API_KEY ? (e.AOM_ASSISTANT ?? 'public') : 'off',
    assistantPublicDailyUsd: e.AOM_ASSISTANT_PUBLIC_DAILY_USD,
    personaChatRetentionDays: e.AOM_PERSONA_CHAT_RETENTION_DAYS,
    assistantModelPublic: e.AOM_ASSISTANT_MODEL_PUBLIC,
    blogDigest: e.AOM_BLOG_DIGEST,
    diagnosticsConsentForCustomers: e.AOM_DIAGNOSTICS_CONSENT_CUSTOMERS,
    weeklyBriefing: e.AOM_WEEKLY_BRIEFING,
    linkedinClientId: e.AOM_LINKEDIN_CLIENT_ID || undefined,
    linkedinClientSecret: e.AOM_LINKEDIN_CLIENT_SECRET || undefined,
    projectGraphs: { enabled: e.AOM_PROJECT_GRAPHS },
    logLevel: e.LOG_LEVEL,
    simulationHost: e.AOM_SIMULATION_HOST,
    simulationDir: e.AOM_SIMULATION_DIR?.trim() || join(tmpdir(), 'aom-simulation'),
    simulationRunnerBin: e.AOM_SIMULATION_RUNNER_BIN?.trim() || undefined,
    simulationServerUrl: e.AOM_SIMULATION_SERVER_URL?.trim() || undefined,
    secureCookies: publicOrigin.startsWith('https://'),
    push: (() => {
      const publicKey = e.AOM_VAPID_PUBLIC_KEY?.trim() || undefined;
      const privateKey = e.AOM_VAPID_PRIVATE_KEY?.trim() || undefined;
      const subject = e.AOM_VAPID_SUBJECT?.trim() || undefined;
      const valid = !!subject && /^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(subject);
      return {
        enabled: !!publicKey && !!privateKey && valid,
        publicKey,
        privateKey,
        subject,
        offlineGraceSeconds: e.AOM_PUSH_OFFLINE_GRACE_SECONDS,
      };
    })(),
  };
}
