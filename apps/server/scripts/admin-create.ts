import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_PLAN, isPlanKey, NO_LIMITS, planDefinition, streamId } from '@aom/shared';
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
 * `pnpm --filter @aom/server admin:create --email a@b.c --name "Ada" [--password ...] [--org "Name"] [--plan founding]`:
 * creates a user and a new organization they own (`UserRegistered` + `OrganizationCreated{createdVia:'cli'}` +
 * `OrgMemberAdded(owner)`). Default organization name "<name>'s organization", plan `founding`, status `active`. It
 * keeps fresh installs and the e2e setup working; the platform account is `superadmin:create`.
 */
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    org: { type: 'string' },
    plan: { type: 'string' },
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
      throw new Error(`a user with email ${email} already exists`);
    }
    const plan = values.plan ?? DEFAULT_PLAN;
    if (!isPlanKey(plan)) throw new Error(`unknown plan '${plan}'`);
    const orgId = randomUUID();
    const orgName = (values.org ?? `${name}'s organization`).slice(0, 120);
    const system = { kind: 'system', id: null } as const;
    const orgScope = { orgId, projectId: null, audience: 'org' } as const;
    await store.append(
      [
        {
          streamId: streamId.user(userId),
          event: { type: 'UserRegistered', payload: { userId, email, displayName: name, passwordHash } },
          actor: system,
          scope: { orgId: null, projectId: null, audience: 'user', userId },
        },
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrganizationCreated',
            payload: {
              orgId,
              name: orgName,
              ownerUserId: userId,
              plan,
              status: 'active',
              limits: planDefinition(plan).limits ?? NO_LIMITS,
              features: {},
              createdVia: 'cli',
            },
          },
          actor: system,
          scope: orgScope,
        },
        {
          streamId: streamId.org(orgId),
          event: { type: 'OrgMemberAdded', payload: { orgId, userId, role: 'owner', via: 'bootstrap' } },
          actor: system,
          scope: orgScope,
        },
      ],
      { tx },
    );
  });
  console.log(`${email} created (${userId}) as the Owner of a new organization.`);
  console.log('To manage accounts and organizations, create the platform account with `superadmin:create`.');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
