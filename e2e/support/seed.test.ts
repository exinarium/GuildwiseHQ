import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Existing, planSeed, type SeedAccount, seedE2eAccounts } from './seed.ts';

const accounts: SeedAccount[] = [
  { email: 'admin@e2e.test', name: 'A', password: 'x'.repeat(12), role: 'owner' },
  { email: 'platform@e2e.test', name: 'P', password: 'y'.repeat(12), role: 'platform' },
];

test('planSeed creates both on an empty database', () => {
  assert.deepEqual(
    planSeed({}, accounts).map((a) => a.action),
    ['create', 'create'],
  );
});

test('planSeed skips accounts that are right', () => {
  const ex: Record<string, Existing> = {
    'admin@e2e.test': { exists: true, kind: 'user', owns: true },
    'platform@e2e.test': { exists: true, kind: 'super_admin', owns: false },
  };
  assert.deepEqual(
    planSeed(ex, accounts).map((a) => a.action),
    ['skip', 'skip'],
  );
});

test('planSeed refuses an owner without an organization and a non-platform account', () => {
  assert.throws(
    () => planSeed({ 'admin@e2e.test': { exists: true, kind: 'user', owns: false } }, accounts),
    /owns no organization/,
  );
  assert.throws(
    () =>
      planSeed({ 'platform@e2e.test': { exists: true, kind: 'user', owns: false } }, [
        accounts[1] as SeedAccount,
      ]),
    /not a platform account/,
  );
});

test('seeding twice runs each CLI once (idempotent)', async () => {
  const store: Record<string, Existing> = {};
  const created: string[] = [];
  const deps = {
    log: () => {},
    query: async () => ({ ...store }),
    run: (a: SeedAccount) => {
      created.push(a.email);
      store[a.email.toLowerCase()] = {
        exists: true,
        kind: a.role === 'platform' ? 'super_admin' : 'user',
        owns: a.role === 'owner',
      };
    },
  };
  await seedE2eAccounts(accounts, deps);
  await seedE2eAccounts(accounts, deps);
  assert.deepEqual(created, ['admin@e2e.test', 'platform@e2e.test']);
});
