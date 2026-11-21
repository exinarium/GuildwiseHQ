import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createClock } from '../src/clock.ts';
import { consoleResetSuperAdminPassword } from '../src/commands/password-reset.ts';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { createMailer } from '../src/mail/mailer.ts';
import { buildProjectors } from '../src/projections/index.ts';
import { PASSWORD_STDIN_OPTION, readPassword } from './read-password.ts';

/**
 * `pnpm --filter @aom/server superadmin:reset-password --email a@b.c [--password-stdin | --password ...] [--reset-two-factor]`:
 * the emergency reset of a super admin's password (appends `PasswordChanged` with the system as actor, so it is
 * audited and replayable) and, with `--reset-two-factor`, of their two-factor login (they set it up again).
 * All their sessions end, an account lock is cleared and the account is mailed (1.10.0, R2/R3).
 */
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    ...PASSWORD_STDIN_OPTION,
    'reset-two-factor': { type: 'boolean', default: false },
  },
});

async function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

if (values['password-stdin'] && !values.email) {
  console.error('--password-stdin needs --email (standard input carries the password only)');
  process.exit(1);
}
const email = values.email ?? (await prompt('Email: '));
const password = await readPassword({
  password: values.password,
  passwordStdin: values['password-stdin'],
  prompt: 'New password (min 12 chars): ',
});
if (!email.includes('@') || password.length < 12 || password.length > 256) {
  console.error('a valid email and a new password of 12-256 characters are required');
  process.exit(1);
}
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
const clock = createClock();
const store = new PgEventStore(pool, buildProjectors(), clock);
const mailer = createMailer(config.smtpUrl, config.mailFrom);
const log = {
  info: () => {},
  warn: (o: unknown, m?: string) => console.warn(m ?? '', o instanceof Error ? o.message : ''),
  error: (o: unknown, m?: string) => console.error(m ?? '', o instanceof Error ? o.message : ''),
} as never;
try {
  await consoleResetSuperAdminPassword(
    { pool, store, clock, mailer, log, config: { publicOrigin: config.publicOrigin } },
    { email, password, resetTwoFactor: values['reset-two-factor'] },
  );
  console.log(`password of ${email} reset; all sessions ended; the account was mailed`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  mailer.close();
  await pool.end();
}
