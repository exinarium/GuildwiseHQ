import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

/** Regression: intake_batches.org_id pointed at users(id), so a batch in an organization whose id is not a user id failed. */
let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('batch intake in an organization whose id is not a user id', () => {
  it('stores the batch (the org foreign key points at organizations)', async () => {
    const orgId = await w.t.createOrg(w.owner.id, 'Agency');
    const id = randomUUID();
    await q('INSERT INTO intake_batches (id, org_id, created_by, created_at) VALUES ($1, $2, $3, now())', [
      id,
      orgId,
      w.owner.id,
    ]);
    expect(await q('SELECT org_id FROM intake_batches WHERE id=$1', [id])).toEqual([{ org_id: orgId }]);
  });

  it('still refuses an organization that does not exist', async () => {
    await expect(
      q('INSERT INTO intake_batches (id, org_id, created_by, created_at) VALUES ($1, $2, $3, now())', [
        randomUUID(),
        randomUUID(),
        w.owner.id,
      ]),
    ).rejects.toThrow();
  });
});
