import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { ADMIN, DATABASE_URL, ROOT, SUPER } from './env.ts';

/**
 * Idempotent seeding of the accounts the suite logs in with. Accounts are created only through the server's own CLIs
 * (they append the events); this helper decides whether to call them. A direct INSERT would bypass the event store.
 */
export type SeedAccount = {
  email: string;
  name: string;
  password: string;
  /** 'owner' = a user who owns a new organization (admin:create); 'platform' = a super admin (superadmin:create). */
  role: 'owner' | 'platform';
  org?: string;
};

export type Existing = { exists: boolean; kind?: string; owns?: boolean };
export type SeedAction = { email: string; action: 'create' | 'skip' };

/** Pure: decides per account what to do; throws on an account that exists but is not what the suite needs. */
export function planSeed(existing: Record<string, Existing>, accounts: SeedAccount[]): SeedAction[] {
  return accounts.map((a) => {
    const e = existing[a.email.toLowerCase()];
    if (!e?.exists) return { email: a.email, action: 'create' as const };
    if (a.role === 'owner' && !e.owns) {
      throw new Error(
        `${a.email} exists but owns no organization: the database is in a state the seed cannot repair, recreate it`,
      );
    }
    if (a.role === 'platform' && e.kind !== 'super_admin') {
      throw new Error(
        `${a.email} exists but is not a platform account (kind '${e.kind}'): recreate the database`,
      );
    }
    return { email: a.email, action: 'skip' as const };
  });
}

export type CliRun = (account: SeedAccount) => void;

export type SeedDeps = {
  /** Looks the accounts up; a database without tables yet (never migrated) answers "none exist". */
  query?: (emails: string[]) => Promise<Record<string, Existing>>;
  run?: CliRun;
  log?: (line: string) => void;
  databaseUrl?: string;
  appDir?: string;
  env?: NodeJS.ProcessEnv;
};

export async function lookupAccounts(
  databaseUrl: string,
  emails: string[],
): Promise<Record<string, Existing>> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const out: Record<string, Existing> = {};
  try {
    for (const email of emails) {
      try {
        const r = await c.query(
          `SELECT u.kind,
                  EXISTS(SELECT 1 FROM org_members m WHERE m.user_id=u.id AND m.role='owner' AND m.status='active') AS owns
             FROM users u WHERE lower(u.email)=lower($1)`,
          [email],
        );
        const row = r.rows[0] as { kind: string; owns: boolean } | undefined;
        out[email.toLowerCase()] = row ? { exists: true, kind: row.kind, owns: row.owns } : { exists: false };
      } catch (e) {
        if ((e as { code?: string }).code === '42P01') out[email.toLowerCase()] = { exists: false };
        else throw e;
      }
    }
  } finally {
    await c.end();
  }
  return out;
}

export function cliRunner(opts: { databaseUrl: string; appDir?: string; env?: NodeJS.ProcessEnv }): CliRun {
  return (a) => {
    const script = a.role === 'owner' ? 'admin:create' : 'superadmin:create';
    const flags = ['--email', a.email, '--name', a.name];
    if (a.role === 'owner' && a.org) flags.push('--org', a.org);
    // the password goes through the child environment, not argv
    // pnpm must not try to (re)install before running the script: the dependencies are copied from the cache
    const env = {
      pnpm_config_verify_deps_before_run: 'false',
      ...process.env,
      ...opts.env,
      DATABASE_URL: opts.databaseUrl,
      AOM_ADMIN_PASSWORD: a.password,
    };
    if (opts.appDir) {
      const file = a.role === 'owner' ? 'admin-create.mjs' : 'superadmin-create.mjs';
      execFileSync('node', [join(opts.appDir, 'server/dist', file), ...flags], {
        env,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    } else {
      execFileSync('pnpm', ['--filter', '@aom/server', script, ...flags], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    }
  };
}

/** Creates the accounts that are missing; returns what it did. Running it twice leaves one copy of each. */
export async function seedE2eAccounts(accounts: SeedAccount[], deps: SeedDeps = {}): Promise<SeedAction[]> {
  const databaseUrl = deps.databaseUrl ?? DATABASE_URL;
  const log = deps.log ?? ((l) => console.log(l));
  const query = deps.query ?? ((emails) => lookupAccounts(databaseUrl, emails));
  const run = deps.run ?? cliRunner({ databaseUrl, appDir: deps.appDir, env: deps.env });
  const existing = await query(accounts.map((a) => a.email));
  const plan = planSeed(existing, accounts);
  for (const step of plan) {
    const account = accounts.find((a) => a.email === step.email) as SeedAccount;
    if (step.action === 'skip') {
      log(`seed: ${step.email} exists`);
      continue;
    }
    run(account);
    log(`seed: ${step.email} created`);
  }
  return plan;
}

/** The accounts of the default setup. The organization name can be overridden for the getting-started video. */
export function defaultAccounts(): SeedAccount[] {
  return [
    {
      email: ADMIN.email,
      name: process.env.AOM_E2E_ADMIN_NAME ?? ADMIN.name,
      password: ADMIN.password,
      role: 'owner',
      org: process.env.AOM_E2E_ADMIN_ORG,
    },
    { email: SUPER.email, name: SUPER.name, password: SUPER.password, role: 'platform' },
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  await seedE2eAccounts(defaultAccounts(), { databaseUrl: arg('--database-url'), appDir: arg('--app') });
}
