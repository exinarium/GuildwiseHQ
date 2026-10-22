import { randomUUID } from 'node:crypto';
import { BUILTIN_ROLES, COMMON_DENIED_SHELL, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltins } from '../src/catalogue/boot.ts';
import { loadRole } from '../src/catalogue/loader.ts';
import { rebaseAgentsToCurrentRoles } from '../src/hr/follow-role.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Hired agents follow the CURRENT version of their role (production bug: builders Ada and Ken kept the denied
 * `git rebase*` of builder v1 after the role allowed it). Permissions = role's current permissions + the agent's own
 * deviations, re-derived by `AgentPermissionsRebased`.
 */
let w: World;
const SYSTEM = { kind: 'system', id: null } as const;
const builderNow = BUILTIN_ROLES.find((r) => r.key === 'builder')!;
const OLD_DENIED = COMMON_DENIED_SHELL;
const permsOf = async (id: string) =>
  (await q('SELECT permissions, role_version FROM agents WHERE id=$1', [id]))[0] as {
    permissions: any;
    role_version: number;
  };

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  // The builder version Ada and Ken were hired under: every common shell restriction, version 1.
  await w.t.app.ctx.store.append([
    {
      streamId: streamId.role(null, 'builder'),
      event: {
        type: 'RoleVersionRegistered',
        payload: {
          roleVersionId: randomUUID(),
          orgId: null,
          key: 'builder',
          version: 1,
          definition: {
            ...builderNow,
            version: 1,
            permissions: { ...builderNow.permissions, deniedShellPatterns: OLD_DENIED },
          },
          status: 'superseded',
        },
      },
      actor: SYSTEM,
      scope: { orgId: null, projectId: null, audience: 'system' },
    },
  ]);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

/** Put an agent into the state a pre-fix hire has: builder v1 with the old denied patterns, plus own edits. */
async function staleBuilder(
  name: string,
  own: { tools?: string[]; deny?: string[]; tiers?: Array<'small' | 'large'> } = {},
) {
  const a = await w.hire(name, 'builder', 'senior');
  const orgId = (await q('SELECT org_id FROM agents WHERE id=$1', [a.id]))[0]!.org_id as string;
  await w.t.app.ctx.store.append([
    {
      streamId: streamId.agent(a.id),
      event: {
        type: 'AgentChanged',
        payload: {
          agentId: a.id,
          changes: {
            roleVersion: 1,
            permissions: {
              ...builderNow.permissions,
              allowedTools: [...builderNow.permissions.allowedTools, ...(own.tools ?? [])],
              deniedShellPatterns: [...OLD_DENIED, ...(own.deny ?? [])],
              riskTiers: own.tiers ?? builderNow.permissions.riskTiers,
            },
          },
        },
      },
      actor: SYSTEM,
      scope: { orgId, projectId: null, audience: 'org' },
    },
  ]);
  return a;
}

describe('agents follow the current version of their role', () => {
  it('a builder hired under the old permissions stops denying rebase, keeps its own edits', async () => {
    const ada = await staleBuilder('Adaa', {
      tools: ['mcp:plugin_atlassian_atlassian'],
      deny: ['npm publish*'],
      tiers: ['small'],
    });
    const plain = await staleBuilder('Kenn');
    expect((await permsOf(ada.id)).permissions.deniedShellPatterns).toContain('git rebase*');

    expect(await rebaseAgentsToCurrentRoles(w.t.app.ctx)).toBeGreaterThanOrEqual(2);

    const a = await permsOf(ada.id);
    expect(a.role_version).toBe(builderNow.version);
    const denied: string[] = a.permissions.deniedShellPatterns;
    for (const free of ['git rebase*', 'git checkout*', 'git switch*']) expect(denied).not.toContain(free);
    for (const kept of ['git push*', 'git reset --hard*', 'rm -rf /*', 'sudo *', 'npm publish*'])
      expect(denied).toContain(kept);
    expect(a.permissions.allowedTools).toContain('mcp:plugin_atlassian_atlassian');
    expect(a.permissions.riskTiers).toEqual(['small']);

    const k = await permsOf(plain.id);
    expect(k.permissions).toEqual(builderNow.permissions);
    expect(k.role_version).toBe(builderNow.version);

    // idempotent: nothing left to rebase
    expect(await rebaseAgentsToCurrentRoles(w.t.app.ctx)).toBe(0);

    const ev = await q(
      `SELECT payload FROM events WHERE type='AgentPermissionsRebased' AND payload->>'agentId'=$1`,
      [ada.id],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload.fromRoleVersion).toBe(1);
  });

  it('owner-only widening is still enforced on a rebased agent', async () => {
    const a = await staleBuilder('Rebb');
    await rebaseAgentsToCurrentRoles(w.t.app.ctx);
    const p = (await permsOf(a.id)).permissions;
    const wider = await w.t.req('PATCH', `/api/agents/${a.id}`, {
      cookie: w.owner.cookie,
      body: { permissions: { ...p, deniedShellPatterns: [] } },
    });
    expect(wider.status).toBe(400); // dropping the role's own restrictions is forbidden for everyone
    await ok(
      w.t.req('PATCH', `/api/agents/${a.id}`, {
        cookie: w.owner.cookie,
        body: { permissions: { ...p, deniedShellPatterns: [...p.deniedShellPatterns, 'make deploy*'] } },
      }),
    );
    expect((await permsOf(a.id)).permissions.deniedShellPatterns).toContain('make deploy*');
  });

  it('projections rebuild to the same agents', async () => {
    const snap = async () => await q('SELECT id, role_version, permissions FROM agents ORDER BY id');
    const before = await snap();
    expect(before.length).toBeGreaterThan(0);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});

describe('the tester role v10 reaches testers hired under v9 (GWP-11)', () => {
  it('boot registers v10 and the rebase moves hired testers; their instructions carry --scope', async () => {
    const testerNow = BUILTIN_ROLES.find((r) => r.key === 'tester')!;
    expect(testerNow.version).toBeGreaterThanOrEqual(10);
    // Production state: role_definitions has tester v9 (without the --scope text), no v10 yet, and hired testers on v9.
    const v9 = {
      ...testerNow,
      version: 9,
      instructions: testerNow.instructions
        .replaceAll('--scope e2e-spec', '')
        .replaceAll('--scope product', ''),
    };
    expect(v9.instructions).not.toContain('--scope');
    await q(`DELETE FROM role_definitions WHERE org_id IS NULL AND key='tester'`);
    await w.t.app.ctx.store.append([
      {
        streamId: streamId.role(null, 'tester'),
        event: {
          type: 'RoleVersionRegistered',
          payload: {
            roleVersionId: randomUUID(),
            orgId: null,
            key: 'tester',
            version: 9,
            definition: v9,
            status: 'active',
          },
        },
        actor: SYSTEM,
        scope: { orgId: null, projectId: null, audience: 'system' },
      },
    ]);
    const dennis = await w.hire('Dennis', 'tester', 'senior');
    const orgId = (await q('SELECT org_id FROM agents WHERE id=$1', [dennis.id]))[0]!.org_id as string;
    await q(`UPDATE agents SET role_version=9 WHERE id=$1`, [dennis.id]);
    expect((await loadRole(w.t.app.ctx.pool, orgId, 'tester', 9))!.definition.instructions).not.toContain(
      '--scope',
    );

    // Boot: the missing version is registered, then the agents follow it.
    const reg = await registerBuiltins(w.t.app.ctx);
    expect(reg.roles).toBeGreaterThanOrEqual(1);
    expect(await rebaseAgentsToCurrentRoles(w.t.app.ctx)).toBeGreaterThanOrEqual(1);

    const after = await permsOf(dennis.id);
    expect(after.role_version).toBe(testerNow.version);
    const role = await loadRole(w.t.app.ctx.pool, orgId, 'tester', after.role_version);
    expect(role!.definition.instructions).toContain('--scope e2e-spec');
    expect(role!.definition.instructions).toContain(
      'you make the edit and run the capture or the suites yourself',
    );
    expect(await rebaseAgentsToCurrentRoles(w.t.app.ctx)).toBe(0);
  });
});
