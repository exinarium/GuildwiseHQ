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
  AOM_MAIL_FROM: z.string().default('Agent Org Manager <noreply@aom.local>'),
  AOM_MIGRATE_ON_BOOT: bool(true),
  AOM_SERVE_WEB: bool(false),
  AOM_WEB_DIST: z.string().optional(),
  AOM_RATE_LIMIT: bool(true),
  AOM_TEST_CLOCK: bool(false),
  AOM_ALLOW_LOCAL_REMOTES: bool(false),
  AOM_MOCK_UI: bool(false),
  AOM_REPORTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  AOM_MAX_SHIFTS_PER_WORKSTATION: z.coerce.number().int().min(1).max(256).default(16),
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
  maxShiftsPerWorkstation: number;
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
    serveWeb: e.AOM_SERVE_WEB,
    webDist: e.AOM_WEB_DIST,
    rateLimit: e.AOM_RATE_LIMIT,
    testClock: e.AOM_TEST_CLOCK,
    allowLocalRemotes: e.AOM_ALLOW_LOCAL_REMOTES,
    mockUi: e.AOM_MOCK_UI,
    reporterSeconds: e.AOM_REPORTER_SECONDS,
    maxShiftsPerWorkstation: e.AOM_MAX_SHIFTS_PER_WORKSTATION,
    logLevel: e.LOG_LEVEL,
    secureCookies: publicOrigin.startsWith('https://'),
  };
}
