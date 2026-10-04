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
    logLevel: e.LOG_LEVEL,
    secureCookies: publicOrigin.startsWith('https://'),
  };
}
