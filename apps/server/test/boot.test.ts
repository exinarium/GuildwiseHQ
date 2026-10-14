import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltins } from '../src/catalogue/boot.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('catalogue boot', () => {
  it('registers built-in workflow and role versions exactly once', async () => {
    const before = await q('SELECT count(*)::int AS n FROM workflow_versions WHERE org_id IS NULL');
    expect(before[0]!.n).toBe(7); // code v1 to v4, code-bugfix, research, feed
    expect((await q('SELECT count(*)::int AS n FROM role_definitions WHERE org_id IS NULL'))[0]!.n).toBe(12);
    expect((await q('SELECT count(*)::int AS n FROM workflow_stages'))[0]!.n).toBeGreaterThan(10);
    const again = await registerBuiltins(t.app.ctx);
    expect(again).toEqual({ workflows: 0, roles: 0 });
    // concurrent boots do not duplicate either
    const more = await Promise.all([registerBuiltins(t.app.ctx), registerBuiltins(t.app.ctx)]);
    expect(more).toEqual([
      { workflows: 0, roles: 0 },
      { workflows: 0, roles: 0 },
    ]);
    expect(
      (await q(`SELECT count(*)::int AS n FROM events WHERE type='WorkflowVersionRegistered'`))[0]!.n,
    ).toBe(7);
  });
});

describe('health', () => {
  it('reports db state', async () => {
    const r = await t.req('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, db: true });
  });
});
