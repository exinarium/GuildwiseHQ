import { randomUUID } from 'node:crypto';
import { BUILTIN_ROLES, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRole } from '../src/catalogue/loader.ts';
import { rebaseAgentsToCurrentRoles } from '../src/hr/follow-role.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * The role versions bumped with "code v6" (the lean stages are claimed through `code`, not a separate key): agents hired
 * under the previous version follow the role at the next boot (`main.ts` runs `rebaseAgentsToCurrentRoles`), so no agent
 * stays pinned to an old definition. The dispatcher itself routes by the stage's `claim_role`, not by `claimableStages`.
 */
let w: World;
const SYSTEM = { kind: 'system', id: null } as const;
const BUMPED = [
  'ba',
  'architect',
  'builder',
  'reviewer',
  'planner',
  'pre_reviewer',
  'tester',
  'writer',
] as const;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' }, lean: true });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('agents hired before the lean stages moved to `code` follow the new role versions', () => {
  it('moves an agent of every bumped role to the current version, which claims the lean stages under key code', async () => {
    const orgId = w.owner.id;
    const hired: Record<string, string> = {};
    for (const key of BUMPED) {
      const now = BUILTIN_ROLES.find((r) => r.key === key)!;
      const a = await w.hire(
        `Old ${key}`.slice(0, 14),
        key,
        now.seniorityLevels.includes('senior') ? 'senior' : 'junior',
      );
      hired[key] = a.id;
      // the previous version, as production has it (the lean stages under the legacy key), and the agent pinned to it
      await w.t.app.ctx.store.append([
        {
          streamId: streamId.role(null, key),
          event: {
            type: 'RoleVersionRegistered',
            payload: {
              roleVersionId: randomUUID(),
              orgId: null,
              key,
              version: now.version - 1,
              definition: {
                ...now,
                version: now.version - 1,
                claimableStages: now.claimableStages.map((c) =>
                  c.workflowKey === 'code' && ['planning', 'pre_review', 'merge_review'].includes(c.stageId)
                    ? { ...c, workflowKey: 'code-v6' }
                    : c,
                ),
              },
              status: 'superseded',
            },
          },
          actor: SYSTEM,
          scope: { orgId: null, projectId: null, audience: 'system' },
        },
        {
          streamId: streamId.agent(a.id),
          event: {
            type: 'AgentChanged',
            payload: { agentId: a.id, changes: { roleVersion: now.version - 1 } },
          },
          actor: SYSTEM,
          scope: { orgId, projectId: null, audience: 'org' },
        },
      ]);
    }
    expect(await rebaseAgentsToCurrentRoles(w.t.app.ctx)).toBeGreaterThanOrEqual(BUMPED.length);
    for (const key of BUMPED) {
      const now = BUILTIN_ROLES.find((r) => r.key === key)!;
      const row = (await q('SELECT role_version FROM agents WHERE id=$1', [hired[key]!]))[0]!;
      expect(row.role_version).toBe(now.version);
      const role = await loadRole(w.t.app.ctx.pool, orgId, key, row.role_version);
      expect(JSON.stringify(role!.definition.claimableStages)).not.toContain('code-v6');
    }
    const claims = async (key: string) =>
      (await loadRole(w.t.app.ctx.pool, orgId, key))!.definition.claimableStages.map(
        (c) => `${c.workflowKey}.${c.stageId}`,
      );
    expect(await claims('planner')).toContain('code.planning');
    expect(await claims('pre_reviewer')).toContain('code.pre_review');
    expect(await claims('reviewer')).toEqual(
      expect.arrayContaining(['code.pre_review', 'code.merge_review']),
    );
    expect(await claims('architect')).toContain('code.planning');
  });
});
