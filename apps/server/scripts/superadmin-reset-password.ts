import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { streamId } from '@aom/shared';
import { hashPassword } from '../src/auth/password.ts';
import { createClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { exec, one } from '../src/db/sql.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors } from '../src/projections/index.ts';

/**
 * `pnpm --filter @aom/server superadmin:reset-password --email a@b.c [--password ...] [--reset-two-factor]`:
 * the emergency reset of a super admin's password (appends `PasswordChanged` with the system as actor, so it is
 * audited and replayable) and, with `--reset-two-factor`, of their two-factor login (they set it up again).
 * All their sessions end.
 */
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
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

const email = values.email ?? (await prompt('Email: '));
const password =
  values.password ?? process.env.AOM_ADMIN_PASSWORD ?? (await prompt('New password (min 12 chars): '));
if (!email.includes('@') || password.length < 12 || password.length > 256) {
  console.error('a valid email and a new password of 12-256 characters are required');
  process.exit(1);
}
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
const store = new PgEventStore(pool, buildProjectors(), createClock());
try {
  await withAppendTx(pool, async (tx) => {
    const u = await one(tx, `SELECT id, kind FROM users WHERE lower(email)=lower($1)`, [email]);
    if (!u) throw new Error(`no account with email ${email}`);
    if (u.kind !== 'super_admin')
      throw new Error(`${email} is not a super admin: its password is changed in the app`);
    const events = [
      {
        streamId: streamId.user(u.id),
        event: {
          type: 'PasswordChanged' as const,
          payload: { userId: u.id, passwordHash: await hashPassword(password) },
        },
        actor: { kind: 'system' as const, id: null },
        scope: { orgId: null, projectId: null, audience: 'admin' as const },
      },
    ];
    if (values['reset-two-factor']) {
      await exec(tx, 'DELETE FROM user_totp WHERE user_id=$1', [u.id]);
      await exec(tx, 'DELETE FROM user_recovery_codes WHERE user_id=$1', [u.id]);
      events.push({
        streamId: streamId.user(u.id),
        event: {
          type: 'TwoFactorDisabled' as never,
          payload: { userId: u.id, by: u.id, reason: 'reset' } as never,
        },
        actor: { kind: 'system' as const, id: null },
        scope: { orgId: null, projectId: null, audience: 'admin' as const },
      });
    }
    await store.append(events, { tx });
    await exec(tx, 'DELETE FROM auth_sessions WHERE user_id=$1', [u.id]);
  });
  console.log(`password of ${email} reset; all sessions ended`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
