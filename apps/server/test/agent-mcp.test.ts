import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Plugin MCP servers per hired agent: adding `mcp:<server>` to an agent's tools is for the organization Owner only, the
 * server must be one the Owner's workstations report, removing is open to Owner and Admins, DevOps cannot be extended.
 */
let w: World;
const ATLASSIAN = {
  name: 'plugin_atlassian_atlassian',
  plugin: 'atlassian',
  server: 'atlassian',
  transport: 'http',
  host: 'mcp.atlassian.com',
};

const patch = (cookie: string, id: string, body: unknown, org?: string) =>
  w.t.req('PATCH', `/api/agents/${id}`, {
    cookie,
    ...(org ? { headers: { 'x-aom-org': org } } : {}),
    body,
  });
const permsOf = async (id: string) =>
  (await q('SELECT permissions FROM agents WHERE id=$1', [id]))[0]?.permissions as {
    allowedTools: string[];
    [k: string]: unknown;
  };
const withTool = async (id: string, tool: string) => {
  const p = await permsOf(id);
  return { ...p, allowedTools: [...p.allowedTools, tool] };
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const r = await w.connectRunner();
  r.send('mcp.servers', { servers: [ATLASSIAN] });
  await r.barrier();
  r.close();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('MCP servers on a hired agent', () => {
  it('the Owner adds a server to a built-in agent; an Admin may remove it but not add one', async () => {
    const ba = await w.hire('Bea', 'ba', 'senior');
    const base = (await permsOf(ba.id)).allowedTools;
    const withMcp = await withTool(ba.id, `mcp:${ATLASSIAN.name}`);

    const admin = await addMember(w, 'mcp-agent-admin');
    await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
    const denied = await patch(admin.cookie, ba.id, { permissions: withMcp }, w.owner.id);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain('Owner');
    expect((await permsOf(ba.id)).allowedTools).toEqual(base);

    await ok(patch(w.owner.cookie, ba.id, { permissions: withMcp }));
    expect((await permsOf(ba.id)).allowedTools).toContain(`mcp:${ATLASSIAN.name}`);

    // an Admin keeping the server while changing something else is fine; removing it is fine
    await ok(patch(admin.cookie, ba.id, { permissions: { ...withMcp, browser: false } }, w.owner.id));
    await ok(patch(admin.cookie, ba.id, { permissions: { ...withMcp, allowedTools: base } }, w.owner.id));
    expect((await permsOf(ba.id)).allowedTools).toEqual(base);
  });

  it('refuses a server no workstation of the Owner reports', async () => {
    const a = await w.hire('Ben', 'ba', 'senior');
    const res = await patch(w.owner.cookie, a.id, {
      permissions: await withTool(a.id, 'mcp:plugin_nothing'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('invalid_mcp_server');
  });

  it('a manager who is not the Owner cannot add one either', async () => {
    const mgr = await addMember(w, 'mcp-agent-manager');
    const a = await w.hire('Bo', 'ba', 'senior');
    await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [a.id, mgr.id]);
    const res = await patch(
      mgr.cookie,
      a.id,
      { permissions: await withTool(a.id, `mcp:${ATLASSIAN.name}`) },
      w.owner.id,
    );
    expect(res.status).toBe(403);
    expect((await permsOf(a.id)).allowedTools).not.toContain(`mcp:${ATLASSIAN.name}`);
  });

  it('the DevOps engineer cannot be given permissions, MCP included', async () => {
    const [d] = await q(
      `SELECT id FROM agents WHERE is_devops AND status='active' AND workstation_id=$1 LIMIT 1`,
      [w.workstationId],
    );
    expect(d).toBeTruthy();
    const res = await patch(w.owner.cookie, d?.id, {
      permissions: await withTool(d?.id, `mcp:${ATLASSIAN.name}`),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('devops_fixed');
  });

  it('a stranger cannot reach the agent', async () => {
    const s = await w.t.userSession(uniqueEmail('mcp-agent-stranger'));
    const a = await w.hire('Bix', 'ba', 'senior');
    expect((await patch(s.cookie, a.id, { capacity: 1 })).status).toBe(404);
  });
});
