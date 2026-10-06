import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { streamId } from '@aom/shared';
import { hashPassword } from '../src/auth/password.ts';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { one } from '../src/db/sql.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `pnpm --filter @aom/server superadmin:create --email a@b.c --name "Ada" [--password ...]` -> SuperAdminCreated.
 * The platform account: no organization, platform routes only, two-factor login required (it sets it up at first
 * sign-in). Created only here; it refuses an email that already has an account.
 */
const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' } },
});

async function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

const email = values.email ?? (await prompt('Email: '));
const name = values.name ?? (await prompt('Display name: '));
const password =
  values.password ?? process.env.AOM_ADMIN_PASSWORD ?? (await prompt('Password (min 12 chars): '));
if (!email.includes('@') || !name || password.length < 12 || password.length > 256) {
  console.error('a valid email, a name and a password of 12-256 characters are required');
  process.exit(1);
}

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl, 2);
const store = new PgEventStore(pool, buildProjectors(), createClock());
try {
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);
  await withAppendTx(pool, async (tx) => {
    if (await one(tx, 'SELECT 1 FROM users WHERE lower(email)=lower($1)', [email])) {
      throw new Error(
        `an account with email ${email} already exists: a super admin needs an email of its own`,
      );
    }
    await store.append(
      [
        {
          streamId: streamId.user(userId),
          event: { type: 'SuperAdminCreated', payload: { userId, email, displayName: name, passwordHash } },
          actor: { kind: 'system', id: null },
          scope: { orgId: null, projectId: null, audience: 'admin' },
        },
      ],
      { tx },
    );
  });
  console.log(
    `super admin ${email} created (${userId}). Sign in at /login: two-factor login is set up at first sign-in.`,
  );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
