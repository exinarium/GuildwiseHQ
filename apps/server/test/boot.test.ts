import { BUILTIN_ROLES, BUILTIN_WORKFLOWS } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltins } from '../src/catalogue/boot.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

let t: TestApp;
beforeAll(async () => {
  // The whole catalogue, as a production boot registers it (code v1 to v7 with the design gate).
  t = await createTestApp({ lean: true, designGate: true });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const countWorkflowEvents = async () =>
  (await q(`SELECT count(*)::int AS n FROM events WHERE type='WorkflowVersionRegistered'`))[0]!.n;

describe('catalogue boot', () => {
  it('registers built-in workflow and role versions exactly once', async () => {
    const before = await q('SELECT count(*)::int AS n FROM workflow_versions WHERE org_id IS NULL');
    // code v1 to v7, code-bugfix, research, feed, the six business workflows: counted from the catalogue so the next
    // built-in version does not break this test
    expect(before[0]!.n).toBe(BUILTIN_WORKFLOWS.length);
    expect((await q('SELECT count(*)::int AS n FROM role_definitions WHERE org_id IS NULL'))[0]!.n).toBe(
      BUILTIN_ROLES.length,
    );
    expect((await q('SELECT count(*)::int AS n FROM workflow_stages'))[0]!.n).toBeGreaterThan(10);
    const again = await registerBuiltins(t.app.ctx);
    expect(again).toEqual({ workflows: 0, roles: 0 });
    // concurrent boots do not duplicate either
    const more = await Promise.all([registerBuiltins(t.app.ctx), registerBuiltins(t.app.ctx)]);
    expect(more).toEqual([
      { workflows: 0, roles: 0 },
      { workflows: 0, roles: 0 },
    ]);
    expect(await countWorkflowEvents()).toBe(BUILTIN_WORKFLOWS.length);
  });

  it('a catalogue registered before code v7 gets exactly one v7 on the next boot, and nothing on the boot after', async () => {
    // A server from before the design gate (1.7.0): everything but code v7 is registered.
    const old = await createTestApp({ lean: true });
    try {
      const withoutV7 = BUILTIN_WORKFLOWS.filter((d) => !(d.key === 'code' && d.version >= 7)).length;
      expect(withoutV7).toBe(BUILTIN_WORKFLOWS.length - 1);
      expect(await countWorkflowEvents()).toBe(withoutV7);
      // The upgrade boot registers the full catalogue: only v7 is new.
      expect(await registerBuiltins(old.app.ctx)).toEqual({ workflows: 1, roles: 0 });
      expect(await registerBuiltins(old.app.ctx)).toEqual({ workflows: 0, roles: 0 });
      expect(await countWorkflowEvents()).toBe(BUILTIN_WORKFLOWS.length);
      const v7 = await q(
        `SELECT count(*)::int AS n FROM workflow_versions WHERE org_id IS NULL AND key='code' AND version=7`,
      );
      expect(v7[0]!.n).toBe(1);
    } finally {
      await old.close();
    }
  });
});

describe('health', () => {
  it('reports db state', async () => {
    const r = await t.req('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, db: true });
  });
});
