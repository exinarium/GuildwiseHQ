import { randomUUID } from 'node:crypto';
import {
  BUILTIN_ROLES,
  type CapabilityMeta,
  indexPack,
  PACKS_CAPABILITY,
  packSnapshotOf,
  renderCapabilityIndex,
  streamId,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePackSkillKeys, PACK_SKILL_KEYS_MIGRATION } from '../src/data-migrations/pack-skill-keys.ts';
import { rebaseAgentsToCurrentRoles } from '../src/hr/follow-role.ts';
import { agentSpecFor } from '../src/runner-gateway/brief.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * The skills an agent is given (production bug on runner 0.1.60): the Analyst's role was extended with five skills of the
 * `bmad-method` pack and Settings listed all five, but Mary's chat instructions held only "`bmad-agent-analyst`: not found
 * in the registry on this workstation" and the session started with no skills. Chats were sent the agent's own list only
 * (never the extension's), and the hire form had stored the hand-typed name without its pack.
 */
const SYSTEM = { kind: 'system', id: null } as const;
const PACK = 'bmad-method';
const EXTENDED = ['bmad-deep-recon', 'bmad-product-brief', 'bmad-prd', 'bmad-brainstorming'];
const SKILLS = ['bmad-agent-analyst', ...EXTENDED, 'bmad-review'];
const full = (k: string) => `${PACK}:${k}`;

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill, written for this test.\n---\n\n# ${name}\n\nDo the work.\n`;
const tree = (): Record<string, string> => ({
  LICENSE: 'MIT License\n\nCopyright (c) 2025 Example Maintainers\n',
  ...Object.fromEntries(SKILLS.map((s) => [`skills/${s}/SKILL.md`, skill(s)])),
});

let w: World;
let r: FakeRunner;
let orgId = '';
let packMeta: CapabilityMeta[] = [];
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PACKS_CAPABILITY] });
  const call = (method: string, url: string, body?: unknown, expected = 200) =>
    // biome-ignore lint/suspicious/noExplicitAny: a response body
    ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body ? { body } : {}) }), expected);
  const packId = (
    await call(
      'POST',
      '/api/packs',
      { name: PACK, url: 'https://github.com/x/bmad-method.git', ref: 'main' },
      201,
    )
  ).pack.id;
  const snap = packSnapshotOf({
    name: PACK,
    ref: 'main',
    sha: 'b'.repeat(40),
    index: indexPack({ name: PACK, adapter: 'auto', tree: tree() }),
  });
  r.send('packs.report', { packId, state: 'resolved', snapshot: snap });
  await until(async () => (await call('GET', '/api/packs')).packs[0].status === 'ready');
  await call('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
  packMeta = (await call('GET', '/api/capabilities?kind=skill&usable=true')).items;
  expect(packMeta.map((i) => i.key)).toEqual(expect.arrayContaining(SKILLS.map(full)));
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const agentRow = async (id: string) => (await q('SELECT * FROM agents WHERE id=$1', [id]))[0]!;
const skillsOf = async (id: string) => (await agentRow(id)).skills as string[];

describe('the skills an agent is given', () => {
  it("reproduces the analyst's case: a chat gets the agent's skill and every extension skill under its pack key", async () => {
    await ok(
      w.t.req('PUT', '/api/roles/analyst/extensions', {
        cookie: w.owner.cookie,
        body: { instructions: '', skills: EXTENDED.map(full), standingOrders: [] },
      }),
    );
    // the hire form stored what was typed: the bare name now gets its pack
    const mary = await w.hire('Mary', 'analyst', 'senior', { skills: ['bmad-agent-analyst'] });
    orgId = (await agentRow(mary.id)).org_id;
    expect(await skillsOf(mary.id)).toEqual([full('bmad-agent-analyst')]);

    const chat = (
      await ok<{ chat: { threadId: string } }>(
        w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId: mary.id } }),
        201,
      )
    ).chat;
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hello Mary', clientMsgId: 'm1' });
    const start = await r.waitFor('chat.start', (f) => f.threadId === chat.threadId);
    expect(start.agent.skills).toEqual([full('bmad-agent-analyst'), ...EXTENDED.map(full)]);

    // what the runner renders from that list: every skill found, none "not found" (before: only the bare name, not found)
    const index = renderCapabilityIndex(start.agent.skills, packMeta);
    expect(index).not.toContain('not found');
    for (const k of [full('bmad-agent-analyst'), ...EXTENDED.map(full)])
      expect(index).toContain(`skill:${k}`);
    expect(renderCapabilityIndex(['bmad-agent-analyst'], packMeta)).toContain(
      '`bmad-agent-analyst`: not found in the registry on this workstation',
    );
    b.close();
  });

  it('every runtime spec (card shifts, sessions, questions) carries the extension skills too', async () => {
    const ann = await w.hire('Annb', 'analyst', 'senior');
    const spec = await agentSpecFor(w.t.app.ctx, await agentRow(ann.id));
    const role = BUILTIN_ROLES.find((x) => x.key === 'analyst')!;
    expect(spec.skills).toEqual([...role.skills, ...EXTENDED.map(full)]);
  });

  it('a hire without skills takes the role skills; a typed name nothing has is kept as written', async () => {
    const plain = await w.hire('Plainb', 'builder', 'senior');
    expect(await skillsOf(plain.id)).toEqual(BUILTIN_ROLES.find((x) => x.key === 'builder')!.skills);
    const typed = await w.hire('Typedb', 'builder', 'senior', {
      skills: ['bmad-review', 'no-such-skill', full('bmad-review')],
    });
    expect(await skillsOf(typed.id)).toEqual([full('bmad-review'), 'no-such-skill']);
  });

  it('an extension saved with a bare pack skill name stores the full key', async () => {
    await ok(
      w.t.req('PUT', '/api/roles/reviewer/extensions', {
        cookie: w.owner.cookie,
        body: { instructions: '', skills: ['bmad-review', 'a11y'], standingOrders: [] },
      }),
    );
    const ext = (
      await q('SELECT extensions FROM role_extensions WHERE org_id=$1 AND role_key=$2', [orgId, 'reviewer'])
    )[0]!;
    expect(ext.extensions.skills).toEqual([full('bmad-review'), 'a11y']);
  });
});

describe('skills follow the role', () => {
  const def = (version: number, skills: string[]) => ({
    ...BUILTIN_ROLES.find((x) => x.key === 'researcher')!,
    key: 'skill-follower',
    name: 'Skill follower',
    builtIn: false,
    version,
    skills,
    claimableStages: [],
  });
  const register = (version: number, skills: string[]) =>
    w.t.app.ctx.store.append([
      {
        streamId: streamId.role(orgId, 'skill-follower'),
        event: {
          type: 'RoleVersionRegistered',
          payload: {
            roleVersionId: randomUUID(),
            orgId,
            key: 'skill-follower',
            version,
            definition: def(version, skills),
            status: 'active',
          },
        },
        actor: SYSTEM,
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);

  it("a new role version brings its skills; the agent's own additions and removals stay", async () => {
    await register(1, ['alpha', 'beta']);
    const a = await w.hire('Followerb', 'skill-follower', 'senior');
    expect(await skillsOf(a.id)).toEqual(['alpha', 'beta']);
    // the agent dropped beta and has one of its own
    await w.t.app.ctx.store.append([
      {
        streamId: streamId.agent(a.id),
        event: { type: 'AgentChanged', payload: { agentId: a.id, changes: { skills: ['alpha', 'own'] } } },
        actor: SYSTEM,
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    await register(2, ['alpha', 'beta', full('bmad-prd')]);
    expect(await rebaseAgentsToCurrentRoles(w.t.app.ctx, { orgId, roleKey: 'skill-follower' })).toBe(1);
    const row = await agentRow(a.id);
    expect(row.role_version).toBe(2);
    expect(row.skills).toEqual(['alpha', full('bmad-prd'), 'own']);
    const ev = (
      await q(`SELECT payload FROM events WHERE type='AgentPermissionsRebased' AND payload->>'agentId'=$1`, [
        a.id,
      ])
    )[0]!;
    expect(ev.payload).toMatchObject({ skills: row.skills, previousSkills: ['alpha', 'own'] });
  });
});

describe(`data migration ${PACK_SKILL_KEYS_MIGRATION}`, () => {
  const env = () => ({
    pool: w.t.app.ctx.pool,
    store: w.t.app.ctx.store,
    clock: w.t.app.ctx.clock,
    log: () => {},
  });

  it('gives bare pack skill names on agents and extensions their pack, and leaves the rest', async () => {
    const old = await w.hire('Oldhireb', 'analyst', 'senior');
    // the state a hire from before the fix left behind
    await w.t.app.ctx.store.append([
      {
        streamId: streamId.agent(old.id),
        event: {
          type: 'AgentChanged',
          payload: {
            agentId: old.id,
            changes: { skills: ['bmad-agent-analyst', 'interview-techniques', 'nope'] },
          },
        },
        actor: SYSTEM,
        scope: { orgId, projectId: null, audience: 'org' },
      },
      {
        streamId: streamId.role(orgId, 'tester'),
        event: {
          type: 'RoleExtended',
          payload: {
            orgId,
            roleKey: 'tester',
            baseVersion: 1,
            extensions: { instructions: 'x', skills: ['bmad-prd', full('bmad-review')], standingOrders: [] },
          },
        },
        actor: SYSTEM,
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    await q('DELETE FROM data_migrations WHERE name=$1', [PACK_SKILL_KEYS_MIGRATION]);
    const report = await migratePackSkillKeys(env());
    expect(report?.agents).toContainEqual({
      agentId: old.id,
      from: ['bmad-agent-analyst', 'interview-techniques', 'nope'],
      to: [full('bmad-agent-analyst'), 'interview-techniques', 'nope'],
    });
    expect(await skillsOf(old.id)).toEqual([full('bmad-agent-analyst'), 'interview-techniques', 'nope']);
    const ext = (
      await q('SELECT base_version, extensions FROM role_extensions WHERE org_id=$1 AND role_key=$2', [
        orgId,
        'tester',
      ])
    )[0]!;
    expect(ext).toMatchObject({
      base_version: 1,
      extensions: { instructions: 'x', skills: [full('bmad-prd'), full('bmad-review')] },
    });
    // once only, and a second run changes nothing
    expect(await migratePackSkillKeys(env())).toBeNull();
    await q('DELETE FROM data_migrations WHERE name=$1', [PACK_SKILL_KEYS_MIGRATION]);
    expect(await migratePackSkillKeys(env())).toEqual({ agents: [], extensions: [] });
  });
});
