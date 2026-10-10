import { z } from 'zod';

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
  AOM_SMTP_URL: z.string().default('smtp://127.0.0.1:1025'),
  AOM_MAIL_FROM: z.string().default('Guildwise HQ <noreply@aom.local>'),
  AOM_MIGRATE_ON_BOOT: bool(true),
  AOM_DATA_MIGRATIONS: bool(true),
  AOM_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  AOM_SERVE_WEB: bool(false),
  AOM_WEB_DIST: z.string().optional(),
  AOM_RATE_LIMIT: bool(true),
  AOM_TEST_CLOCK: bool(false),
  AOM_ALLOW_LOCAL_REMOTES: bool(false),
  AOM_MOCK_UI: bool(false),
  AOM_TOUR_AUTOSTART: bool(true),
  AOM_REPORTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  AOM_HYGIENE_SCHEDULE: bool(true),
  AOM_WEBHOOK_ALLOW_PRIVATE: bool(false),
  AOM_MAX_SHIFTS_PER_WORKSTATION: z.coerce.number().int().min(1).max(256).default(16),
  /** Where the packaged runner (`aom-runner-<version>.tgz`, `pnpm package:runner`) is served from. */
  AOM_RUNNER_RELEASE_DIR: z.string().optional(),
  /** The support address new Contact us requests are emailed to, until the super admin sets one in the platform settings. */
  AOM_SUPPORT_EMAIL: z.string().optional(),
  /** From address of the support mails to the customer (acknowledgement, replies), e.g. `Guildwise HQ Support <support@guildwisehq.com>`. Unset: AOM_MAIL_FROM. */
  AOM_SUPPORT_FROM: z.string().optional(),
  /** Anthropic API key for the public landing-page assistant (a secret: never sent to the browser, never logged). */
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  /** Kill switch of the assistant: `off` or `public` (landing page). Unset: `public` when a key is set, else `off`. */
  AOM_ASSISTANT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['off', 'public']).optional()),
  /** Spend ceiling per UTC day for the public assistant, in US dollars. */
  AOM_ASSISTANT_PUBLIC_DAILY_USD: z.coerce.number().min(0).max(10_000).default(10),
  /** Model of the public assistant. */
  AOM_ASSISTANT_MODEL_PUBLIC: z.string().min(1).default('claude-haiku-4-5'),
  /** Weekly blog digest mail (Monday 08:00 Africa/Johannesburg). Switch off with AOM_BLOG_DIGEST=false (the platform setting can also stop it). */
  AOM_BLOG_DIGEST: bool(true),
  /** LinkedIn app credentials, only needed to renew the organization token with its refresh token. */
  AOM_LINKEDIN_CLIENT_ID: z.string().optional(),
  AOM_LINKEDIN_CLIENT_SECRET: z.string().optional(),
  /** Billing: renewals, retries, expiry notices and trial reminders run on the scheduler. */
  AOM_BILLING_JOBS: bool(true),
  /** Staging only: allow the fake provider (no money taken) on an https public origin; otherwise boot refuses (billing/guard.ts). */
  AOM_ALLOW_FAKE_PAYMENTS: bool(false),
  /** Which gateway: `paystack` (primary), `payfast` (fallback) or `fake`. Unset: Paystack when its keys are set, else PayFast when its keys are set, else fake (local and UAT). */
  AOM_PAYMENT_PROVIDER: z.enum(['paystack', 'payfast', 'fake']).optional(),
  AOM_PAYSTACK_SECRET_KEY: z.string().optional(),
  AOM_PAYSTACK_PUBLIC_KEY: z.string().optional(),
  /** The ZAR amount charged (and refunded) to save a card with Paystack. UNVERIFIED: Paystack's minimum for ZAR. */
  AOM_PAYSTACK_CARD_CHECK_ZAR: z.coerce.number().min(1).max(1000).default(5),
  /** Deprecated alias of AOM_PAYMENT_PROVIDER (`auto` = unset). */
  AOM_BILLING_PROVIDER: z.enum(['auto', 'fake', 'payfast']).default('auto'),
  AOM_PAYFAST_MERCHANT_ID: z.string().optional(),
  AOM_PAYFAST_MERCHANT_KEY: z.string().optional(),
  AOM_PAYFAST_PASSPHRASE: z.string().optional(),
  AOM_PAYFAST_SANDBOX: bool(true),
  /** The ZAR amount charged (and refunded) to save a card with PayFast tokenization. PayFast's minimum is R5.00. */
  AOM_PAYFAST_CARD_CHECK_ZAR: z.coerce.number().min(5).max(1000).default(5),
  /** Exchange rate source: a URL returning `{ rates: { ZAR } }` (default open.er-api.com); `off` uses only the fallback. */
  AOM_FX_URL: z.string().default('https://open.er-api.com/v6/latest/USD'),
  /** Used when the rate source is down and no daily rate is cached. */
  AOM_FX_FALLBACK_ZAR: z.coerce.number().positive().default(18.5),
  LOG_LEVEL: z.string().default('info'),
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  publicOrigin: string;
  smtpUrl: string;
  mailFrom: string;
  migrateOnBoot: boolean;
  /** Run the boot data migrations (`orgs-2026-10`, ...) after the SQL migrations. */
  dataMigrations: boolean;
  /** Encrypts the two-factor seeds at rest. Unset: a random key kept in the database (set it in production). */
  secretKey: string | undefined;
  serveWeb: boolean;
  webDist: string | undefined;
  rateLimit: boolean;
  testClock: boolean;
  /** Accept `file://` and absolute-path git remotes (tests and the e2e harness only). */
  allowLocalRemotes: boolean;
  /** Mock-runtime card fields (Mock script, ...) are shown in the UI and accepted on the API (dev and e2e only). */
  mockUi: boolean;
  /** A user who has never seen the first-login tour gets it on their first visit (off in the e2e suite, which switches it on per user). */
  tourAutostart: boolean;
  /** Ceiling for a workstation's `maxConcurrentShifts` (the runner's own setting, default 4, is what applies). */
  /** How often the reporter sweeps for signals, expired triage holds and the daily floor report (docs/design/phases.md B4). */
  reporterSeconds: number;
  /** Run the workstations' scheduled repository hygiene (each workstation's own cadence). "Run hygiene now" always works. */
  hygieneSchedule: boolean;
  maxShiftsPerWorkstation: number;
  /** Let outgoing webhooks reach loopback and private-network addresses (local tests; off in production). */
  webhookAllowPrivate: boolean;
  /** Directory holding the runner release tarballs; undefined: the usual places are tried. */
  runnerReleaseDir: string | undefined;
  /** Fallback support address (the platform setting wins). */
  supportEmail: string | undefined;
  /** From address for support mails to customers; undefined: the normal `mailFrom`. */
  supportFrom: string | undefined;
  /** Key of the Anthropic API (the public assistant); undefined: the assistant is off. */
  anthropicApiKey: string | undefined;
  /** The assistant kill switch (`AOM_ASSISTANT`): `public` only when a key is set and it is not switched off. */
  assistantMode: 'off' | 'public';
  assistantPublicDailyUsd: number;
  assistantModelPublic: string;
  /** Send the weekly blog digest (env switch; the super admin's blog settings are a second switch). */
  blogDigest: boolean;
  linkedinClientId: string | undefined;
  linkedinClientSecret: string | undefined;
  billingJobs: boolean;
  allowFakePayments: boolean;
  billingProvider: 'auto' | 'fake' | 'payfast' | 'paystack';
  paystack: { secretKey: string | undefined; publicKey: string | undefined; cardCheckZar: number };
  payfast: {
    merchantId: string | undefined;
    merchantKey: string | undefined;
    passphrase: string | undefined;
    sandbox: boolean;
    cardCheckZar: number;
  };
  fxUrl: string;
  fxFallbackZar: number;
  logLevel: string;
  /** Cookie `Secure` flag: true when the public origin is https. */
  secureCookies: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  const publicOrigin = e.AOM_PUBLIC_ORIGIN.replace(/\/+$/, '');
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.AOM_PORT,
    host: e.AOM_HOST,
    publicOrigin,
    smtpUrl: e.AOM_SMTP_URL,
    mailFrom: e.AOM_MAIL_FROM,
    migrateOnBoot: e.AOM_MIGRATE_ON_BOOT,
    dataMigrations: e.AOM_DATA_MIGRATIONS,
    secretKey: e.AOM_SECRET_KEY,
    serveWeb: e.AOM_SERVE_WEB,
    webDist: e.AOM_WEB_DIST,
    rateLimit: e.AOM_RATE_LIMIT,
    testClock: e.AOM_TEST_CLOCK,
    allowLocalRemotes: e.AOM_ALLOW_LOCAL_REMOTES,
    mockUi: e.AOM_MOCK_UI,
    tourAutostart: e.AOM_TOUR_AUTOSTART,
    reporterSeconds: e.AOM_REPORTER_SECONDS,
    hygieneSchedule: e.AOM_HYGIENE_SCHEDULE,
    maxShiftsPerWorkstation: e.AOM_MAX_SHIFTS_PER_WORKSTATION,
    webhookAllowPrivate: e.AOM_WEBHOOK_ALLOW_PRIVATE,
    runnerReleaseDir: e.AOM_RUNNER_RELEASE_DIR || undefined,
    supportEmail: e.AOM_SUPPORT_EMAIL || undefined,
    supportFrom: e.AOM_SUPPORT_FROM?.trim() || undefined,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    // Off without a key, whatever the switch says; with a key it is on unless switched off.
    assistantMode: e.ANTHROPIC_API_KEY ? (e.AOM_ASSISTANT ?? 'public') : 'off',
    assistantPublicDailyUsd: e.AOM_ASSISTANT_PUBLIC_DAILY_USD,
    assistantModelPublic: e.AOM_ASSISTANT_MODEL_PUBLIC,
    blogDigest: e.AOM_BLOG_DIGEST,
    linkedinClientId: e.AOM_LINKEDIN_CLIENT_ID || undefined,
    linkedinClientSecret: e.AOM_LINKEDIN_CLIENT_SECRET || undefined,
    billingJobs: e.AOM_BILLING_JOBS,
    allowFakePayments: e.AOM_ALLOW_FAKE_PAYMENTS,
    billingProvider: e.AOM_PAYMENT_PROVIDER ?? e.AOM_BILLING_PROVIDER,
    paystack: {
      secretKey: e.AOM_PAYSTACK_SECRET_KEY?.trim() || undefined,
      publicKey: e.AOM_PAYSTACK_PUBLIC_KEY?.trim() || undefined,
      cardCheckZar: e.AOM_PAYSTACK_CARD_CHECK_ZAR,
    },
    payfast: {
      merchantId: e.AOM_PAYFAST_MERCHANT_ID?.trim() || undefined,
      merchantKey: e.AOM_PAYFAST_MERCHANT_KEY?.trim() || undefined,
      passphrase: e.AOM_PAYFAST_PASSPHRASE?.trim() || undefined,
      sandbox: e.AOM_PAYFAST_SANDBOX,
      cardCheckZar: e.AOM_PAYFAST_CARD_CHECK_ZAR,
    },
    fxUrl: e.AOM_FX_URL,
    fxFallbackZar: e.AOM_FX_FALLBACK_ZAR,
    logLevel: e.LOG_LEVEL,
    secureCookies: publicOrigin.startsWith('https://'),
  };
}
