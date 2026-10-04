import { BUILTIN_ROLES } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, hireFor, type Member } from './helpers/members.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
let m: Member;
let rex: any;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  m = await addMember(w, 'hirer');
  rex = await hireFor(w, m, 'Rex', 'reviewer', 'senior');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const role = () => BUILTIN_ROLES.find((r) => r.key === 'reviewer')!.permissions;
const patch = (cookie: string, body: Record<string, unknown>) =>
  w.t.req('PATCH', `/api/agents/${rex.id}`, { cookie, body });
const stored = async () => (await q('SELECT permissions FROM agents WHERE id=$1', [rex.id]))[0]!.permissions;

describe('agent permissions only narrow relative to the role (review M2)', () => {
  it('a hiring manager cannot make a reviewer committing or editing', async () => {
    const before = await stored();
    for (const permissions of [
      { ...role(), mayCommit: true },
      { ...role(), allowedTools: [...role().allowedTools, 'edit'] },
      { ...role(), deniedShellPatterns: [] },
    ]) {
      const r = await patch(m.cookie, { permissions });
      expect(r.status, JSON.stringify(permissions)).toBe(400);
      expect(r.body.error.code).toBe('permissions_exceed_role');
    }
    // the org owner cannot either: these are the role's hard limits
    expect((await patch(w.owner.cookie, { permissions: { ...role(), mayCommit: true } })).status).toBe(400);
    expect(await stored()).toEqual(before);
  });

  it('narrowing is allowed; other widening needs the organization owner', async () => {
    const narrower = { ...role(), allowedTools: ['read'] };
    expect((await patch(m.cookie, { permissions: narrower })).status).toBeLessThan(300);
    expect((await stored()).allowedTools).toEqual(['read']);

    const wider = { ...role(), allowedTools: [...role().allowedTools, 'web'] };
    expect((await patch(m.cookie, { permissions: wider })).status).toBe(403);
    const asOwner = await patch(w.owner.cookie, { permissions: wider });
    expect(asOwner.status).toBeLessThan(300);
    expect((await stored()).allowedTools).toContain('web');
  });

  it("a role change takes the new role's permissions, not the old role's", async () => {
    const r = await patch(m.cookie, { roleKey: 'builder' });
    expect(r.status).toBeLessThan(300);
    const builder = BUILTIN_ROLES.find((x) => x.key === 'builder')!.permissions;
    expect((await stored()).mayCommit).toBe(builder.mayCommit);
  });
});
