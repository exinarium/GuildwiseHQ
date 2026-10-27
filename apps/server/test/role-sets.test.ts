import {
  BUILTIN_ROLES,
  bmadRoleSet,
  indexPack,
  PACKS_CAPABILITY,
  packSnapshotOf,
  renderInstructions,
  UX_DESIGNER_KEY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRoleSets } from '../src/commands/role-sets.ts';
import { agentSpecFor, buildBrief } from '../src/runner-gateway/brief.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * The BMAD role set (docs/bmad-roles.md): switching puts the set's versions of the roles on the desk as one approval; once
 * approved the agents follow them (persona in shifts and chats, BMAD skills under their pack keys) while instructions,
 * core rules and permissions stay the built-in ones; switching back returns every agent to the built-in version.
 */
const PACK = 'bmad-method';
const SKILLS = [
  ...new Set([
    'bmad-agent-analyst',
    ...bmadRoleSet(PACK).flatMap((r) => r.skills.map((s) => s.split(':')[1] as string)),
  ]),
];
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill, written for this test.\n---\n\n# ${name}\n\nDo the work.\n`;

let w: World;
let r: FakeRunner;
let orgId = '';
let packId = '';
// biome-ignore lint/suspicious/noExplicitAny: response bodies
const call = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(w.t.req(method, url, { cookie: w.owner.cookie, ...(body ? { body } : {}) }), expected);
const agent = async (id: string) => (await q('SELECT * FROM agents WHERE id=$1', [id]))[0]!;
const builtin = (key: string) => BUILTIN_ROLES.find((x) => x.key === key)!;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PACKS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('the BMAD role set', () => {
  let mary = '';
  let bob = '';

  it('needs an organization pack with the BMAD skills', async () => {
    mary = (await w.hire('Mary', 'analyst', 'senior')).id;
    bob = (await w.hire('Bob', 'builder', 'senior')).id;
    orgId = (await agent(mary)).org_id;
    expect(await call('GET', '/api/org/role-set')).toMatchObject({
      roleSet: 'guildwise',
      pendingDeskItemId: null,
    });
    const res = await w.t.req('PUT', '/api/org/role-set', {
      cookie: w.owner.cookie,
      body: { roleSet: 'bmad' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bmad_pack_missing');

    packId = (
      await call('POST', '/api/packs', { name: PACK, url: 'https://github.com/x/bmad.git', ref: 'main' }, 201)
    ).pack.id;
    const snap = packSnapshotOf({
      name: PACK,
      ref: 'main',
      sha: 'c'.repeat(40),
      index: indexPack({
        name: PACK,
        adapter: 'auto',
        tree: {
          LICENSE: 'MIT License\n\nCopyright (c) 2025 Example\n',
          ...Object.fromEntries(SKILLS.map((s) => [`skills/${s}/SKILL.md`, skill(s)])),
        },
      }),
    });
    r.send('packs.report', { packId, state: 'resolved', snapshot: snap });
    await until(async () => (await call('GET', '/api/packs')).packs[0].status === 'ready');
    await call('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
  });

  it('only an Owner or Admin switches it', async () => {
    const m = await addMember(w, 'roleset-member');
    const res = await w.t.req('PUT', `/api/org/role-set?projectId=${w.projectId}`, {
      cookie: m.cookie,
      body: { roleSet: 'bmad' },
    });
    expect(res.status).toBe(403);
    // reading is for every member
    expect(
      (await w.t.req('GET', `/api/org/role-set?projectId=${w.projectId}`, { cookie: m.cookie })).status,
    ).toBe(200);
  });

  it('switching puts every role of the set on the desk as one approval; nothing changes until it is approved', async () => {
    const st = await call('PUT', '/api/org/role-set', { roleSet: 'bmad' });
    expect(st).toMatchObject({ roleSet: 'bmad', pack: PACK });
    expect(st.pendingDeskItemId).toEqual(expect.any(String));
    const keys = st.roles.map((x: { key: string }) => x.key).sort();
    expect(keys).toEqual(
      bmadRoleSet(PACK)
        .map((x) => x.key)
        .sort(),
    );
    expect(st.roles.every((x: { status: string }) => x.status === 'pending_approval')).toBe(true);
    const item = (await q('SELECT title FROM desk_items WHERE id=$1', [st.pendingDeskItemId]))[0]!;
    expect(item.title).toMatch(/^Approve the BMAD role set \(\d+ roles\)$/);
    expect((await agent(mary)).role_version).toBe(builtin('analyst').version);
    // a second switch waits for the decision
    const again = await w.t.req('PUT', '/api/org/role-set', {
      cookie: w.owner.cookie,
      body: { roleSet: 'guildwise' },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('role_set_pending');

    expect((await designer(w).resolve(st.pendingDeskItemId, 'approved')).status).toBe(200);
  });

  it('after approval the agents follow: persona and BMAD skills, the built-in instructions, rules and permissions', async () => {
    const st = await call('GET', '/api/org/role-set');
    expect(st.pendingDeskItemId).toBeNull();
    expect(st.roles.every((x: { status: string }) => x.status === 'active')).toBe(true);
    const a = await agent(mary);
    expect(a.role_version).toBeGreaterThan(builtin('analyst').version);
    expect(a.skills).toEqual(
      expect.arrayContaining([`${PACK}:bmad-deep-recon`, `${PACK}:bmad-product-brief`]),
    );
    // the stock analyst's own skills went with the old version, as any role change would take them
    expect(a.skills).not.toContain('interview-techniques');
    expect(a.permissions).toEqual(builtin('analyst').permissions);
    const b = await agent(bob);
    expect(b.skills).toEqual([`${PACK}:bmad-project-context`]);
    expect(b.permissions).toEqual(builtin('builder').permissions);
    const spec = await agentSpecFor(w.t.app.ctx, b);
    expect(spec.skills).toEqual([`${PACK}:bmad-project-context`]);

    // the catalogue shows the set's version under the built-in role, newest first
    const cat = await call('GET', '/api/org/catalogue');
    const analyst = cat.roles.find(
      (x: { key: string; builtIn: boolean }) => x.key === 'analyst' && x.builtIn,
    );
    expect(analyst.versions[0].definition.roleSet).toMatchObject({ key: 'bmad' });
    expect(cat.roles.filter((x: { key: string }) => x.key === 'analyst')).toHaveLength(1);
    expect(cat.roles.find((x: { key: string }) => x.key === UX_DESIGNER_KEY)?.builtIn).toBe(false);
  });

  it("a card shift's instructions carry the persona after the built-in instructions", async () => {
    const card = await w.card();
    const shift = {
      id: '00000000-0000-4000-8000-000000000001',
      card_id: card.id,
      agent_id: bob,
      stage: 'build',
      kind: 'card',
    };
    const brief = await buildBrief(w.t.app.ctx, shift as never);
    expect(brief?.role.persona).toContain('## How you work (BMAD Method: Senior Software Engineer)');
    const md = renderInstructions(brief!);
    expect(md.indexOf(builtin('builder').instructions.slice(0, 60))).toBeLessThan(
      md.indexOf('## How you work'),
    );
    expect(md).toContain('## BMAD skills in Guildwise');
    for (const rule of builtin('builder').coreRules) expect(md).toContain(rule);
  });

  it('a chat carries the persona too', async () => {
    const chat = (await call('POST', '/api/chats', { agentId: mary }, 201)).chat;
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hi', clientMsgId: 'rs1' });
    const start = await r.waitFor('chat.start', (f) => f.threadId === chat.threadId);
    expect(start.role?.name).toBe('Analyst');
    expect(start.role?.persona).toContain('## How you work (BMAD Method: Business Analyst)');
    b.close();
  });

  it('the start-up sync proposes nothing while the set is current, and the changed role when it is not', async () => {
    expect(await syncRoleSets(w.t.app.ctx)).toBe(0);
    // the code moved on for one role (here: its stored version made stale by hand)
    await q(
      `UPDATE role_definitions SET definition = jsonb_set(definition, '{persona}', '"old"') WHERE org_id=$1 AND key='writer' AND status='active'`,
      [orgId],
    );
    expect(await syncRoleSets(w.t.app.ctx)).toBe(1);
    const st = await call('GET', '/api/org/role-set');
    expect(
      st.roles
        .filter((x: { status: string }) => x.status === 'pending_approval')
        .map((x: { key: string }) => x.key),
    ).toEqual(['writer']);
    // rejected: not offered again at the next start, and the set stays on (its other versions are current)
    expect((await designer(w).resolve(st.pendingDeskItemId, 'rejected')).status).toBe(200);
    expect(await syncRoleSets(w.t.app.ctx)).toBe(0);
    expect((await call('GET', '/api/org/role-set')).roleSet).toBe('bmad');
  });

  it('switching back moves every agent to the built-in version; the UX designer role stays', async () => {
    const st = await call('PUT', '/api/org/role-set', { roleSet: 'guildwise' });
    expect(st).toMatchObject({ roleSet: 'guildwise', pendingDeskItemId: null });
    expect(st.roles.map((x: { key: string }) => x.key)).toEqual([UX_DESIGNER_KEY]);
    const a = await agent(mary);
    expect(a.role_version).toBe(builtin('analyst').version);
    expect(a.skills).toEqual(builtin('analyst').skills);
    expect(a.permissions).toEqual(builtin('analyst').permissions);
    const b = await agent(bob);
    expect(b.role_version).toBe(builtin('builder').version);
    expect(b.skills).toEqual([]);
    const brief = await buildBrief(w.t.app.ctx, {
      id: '00000000-0000-4000-8000-000000000002',
      card_id: (await w.card()).id,
      agent_id: bob,
      stage: 'build',
      kind: 'card',
    } as never);
    expect(brief?.role.persona).toBeUndefined();
  });

  it('a rejected switch puts the organization back on the stock roles', async () => {
    const st = await call('PUT', '/api/org/role-set', { roleSet: 'bmad' });
    expect(
      st.roles.filter((x: { status: string }) => x.status === 'pending_approval').length,
    ).toBeGreaterThan(0);
    expect((await designer(w).resolve(st.pendingDeskItemId, 'rejected')).status).toBe(200);
    expect(await call('GET', '/api/org/role-set')).toMatchObject({
      roleSet: 'guildwise',
      pendingDeskItemId: null,
    });
    expect((await agent(mary)).role_version).toBe(builtin('analyst').version);
  });
});
