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
  AOM_REPORTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  AOM_HYGIENE_SCHEDULE: bool(true),
  AOM_WEBHOOK_ALLOW_PRIVATE: bool(false),
  AOM_MAX_SHIFTS_PER_WORKSTATION: z.coerce.number().int().min(1).max(256).default(16),
  /** Where the packaged runner (`aom-runner-<version>.tgz`, `pnpm package:runner`) is served from. */
  AOM_RUNNER_RELEASE_DIR: z.string().optional(),
  /** The support address new Contact us requests are emailed to, until the super admin sets one in the platform settings. */
  AOM_SUPPORT_EMAIL: z.string().optional(),
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
    reporterSeconds: e.AOM_REPORTER_SECONDS,
    hygieneSchedule: e.AOM_HYGIENE_SCHEDULE,
    maxShiftsPerWorkstation: e.AOM_MAX_SHIFTS_PER_WORKSTATION,
    webhookAllowPrivate: e.AOM_WEBHOOK_ALLOW_PRIVATE,
    runnerReleaseDir: e.AOM_RUNNER_RELEASE_DIR || undefined,
    supportEmail: e.AOM_SUPPORT_EMAIL || undefined,
    logLevel: e.LOG_LEVEL,
    secureCookies: publicOrigin.startsWith('https://'),
  };
}
