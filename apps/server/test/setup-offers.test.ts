import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * easy-runner-setup: the pair response and every `welcome` carry `setupOffers`, the names the installer's one screen
 * shows (organisations, the user's role, the DevOps helper hired for this workstation, the repositories). Never a grant.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('setup offers', () => {
  it('the pair response carries organisation, role and DevOps helper names, and the repositories', async () => {
    const { t, owner } = w;
    const { code } = await ok<{ code: string }>(
      t.req('POST', '/api/workstations/pairing-codes', { cookie: owner.cookie }),
      201,
    );
    const r = await ok<{
      workstationId: string;
      setupOffers: {
        orgs: Array<{
          orgId: string;
          orgName: string;
          role: string;
          devopsAgentId?: string;
          devopsAgentName?: string;
        }>;
        repos: Array<{ name: string }>;
      };
    }>(
      t.req('POST', '/api/runner/pair', {
        body: { code, name: 'Second', platform: 'linux', hostname: 'h2', runnerVersion: '1.10.0' },
      }),
    );
    expect(r.setupOffers.orgs).toHaveLength(1);
    const o = r.setupOffers.orgs[0] as (typeof r.setupOffers.orgs)[number];
    const org = await q(
      'SELECT o.id, o.name FROM organizations o JOIN projects p ON p.org_id = o.id WHERE p.id=$1',
      [w.projectId],
    );
    expect(o).toMatchObject({ orgId: org[0]!.id, orgName: org[0]!.name, role: 'Owner' });
    const agent = await q('SELECT id, name FROM agents WHERE workstation_id=$1 AND is_devops AND status=$2', [
      r.workstationId,
      'active',
    ]);
    expect(o.devopsAgentId).toBe(agent[0]!.id);
    expect(o.devopsAgentName).toBe(agent[0]!.name);
    expect(r.setupOffers.repos.map((x) => x.name)).toContain('toy');
  });

  it('welcome refreshes them', async () => {
    const r = await w.connectRunner();
    try {
      const welcome = (await r.waitFor('welcome')) as unknown as {
        setupOffers: { orgs: Array<{ role: string; devopsAgentName?: string }>; repos: unknown[] };
      };
      expect(welcome.setupOffers.orgs[0]?.role).toBe('Owner');
      expect(welcome.setupOffers.orgs[0]?.devopsAgentName).toEqual(expect.any(String));
      expect(welcome.setupOffers.repos.length).toBeGreaterThan(0);
    } finally {
      r.close();
    }
  });
});
