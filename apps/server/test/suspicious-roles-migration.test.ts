import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_MIGRATIONS } from '../src/data-migrations/index.ts';
import {
  migrateSuspiciousRoles,
  SUSPICIOUS_ROLES_MIGRATION,
} from '../src/data-migrations/suspicious-roles.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

// biome-ignore lint/suspicious/noExplicitAny: rows
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
const P1 = randomUUID();
const P2 = randomUUID();
const PRIV = randomUUID();
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const version = (key: string, v: number, packId: string | null, visibility = 'org') =>
  q(
    `INSERT INTO role_definitions (org_id, key, version, definition, status, created_at)
     VALUES ($1,$2,$3,$4,'active', now())`,
    [
      w.owner.id,
      key,
      v,
      JSON.stringify({
        name: key,
        ...(packId
          ? {
              source: {
                packId,
                packName: packId === P1 ? 'alpha' : packId === P2 ? 'beta' : 'mine',
                visibility,
              },
            }
          : {}),
      }),
    ],
  );
const env = () => ({
  pool: w.t.app.ctx.pool,
  store: w.t.app.ctx.store,
  clock: w.t.app.ctx.clock,
  log: () => {},
});
const notices = () =>
  q(`SELECT * FROM desk_items WHERE subkind='suspicious_role' AND org_id=$1 ORDER BY title`, [w.owner.id]);

describe('suspicious roles are flagged for an Owner to review (Q72)', () => {
  it('flags a role with versions from different packs and one made from a private pack, one notice each, and changes nothing', async () => {
    await version('mixed-role', 1, P1);
    await version('mixed-role', 2, P2);
    await version('private-role', 1, PRIV, 'private');
    await version('clean-role', 1, P1);
    await version('clean-role', 2, P1);
    await version('hand-made', 1, null);
    const before = await q(
      'SELECT key, version, status, definition FROM role_definitions WHERE org_id=$1 ORDER BY key, version',
      [w.owner.id],
    );
    expect(DATA_MIGRATIONS.map((m) => m.name)).toContain(SUSPICIOUS_ROLES_MIGRATION);
    await q('DELETE FROM data_migrations WHERE name=$1', [SUSPICIOUS_ROLES_MIGRATION]);
    const report = await migrateSuspiciousRoles(env());
    expect(report?.flagged.map((f) => f.roleKey).sort()).toEqual(['mixed-role', 'private-role']);
    const items = await notices();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title).join(' ')).toContain('private-role');
    expect(items.find((i) => i.title.includes('mixed-role')).body).toContain('alpha');
    expect(items.every((i) => i.kind === 'alert')).toBe(true);
    // nothing else changed
    expect(
      await q(
        'SELECT key, version, status, definition FROM role_definitions WHERE org_id=$1 ORDER BY key, version',
        [w.owner.id],
      ),
    ).toEqual(before);
  });

  it('is idempotent: recorded once, and a second run (marker removed) flags nothing again', async () => {
    expect(await migrateSuspiciousRoles(env())).toBeNull();
    await q('DELETE FROM data_migrations WHERE name=$1', [SUSPICIOUS_ROLES_MIGRATION]);
    const again = await migrateSuspiciousRoles(env());
    expect(again?.flagged).toEqual([]);
    expect(await notices()).toHaveLength(2);
    expect(
      (await q('SELECT 1 FROM data_migrations WHERE name=$1', [SUSPICIOUS_ROLES_MIGRATION])).length,
    ).toBe(1);
  });
});
