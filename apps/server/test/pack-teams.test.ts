import {
  type CapabilityMeta,
  indexPack,
  PACKS_CAPABILITY,
  type PackSnapshot,
  packSnapshotOf,
  suggestSeat,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { agentSpecFor } from '../src/runner-gateway/brief.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Hire agents from a pack onto real roles: the Owner's classification of a pack's skills, the pack's team with suggested seats,
 * a pack agent on a seat (single and whole pack, all or nothing), the brief block, replay and permissions. The pack mixes the two
 * layouts: skills that are agents without a marker (a `customize.toml` with an `[agent]` table) and a Claude Code plugin.
 */
const PACK = 'crew';
const full = (k: string) => `${PACK}:${k}`;
const skill = (name: string, description = `The ${name} skill.`, body = 'Do it.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
const agentSkill = (key: string, name: string, title: string, menu: string[]) => ({
  [`skills/${key}/SKILL.md`]: skill(
    key,
    `${title}. Use when the user asks to talk to ${name}.`,
    `You are ${name}.`,
  ),
  [`skills/${key}/customize.toml`]: `[agent]\nname = "${name}"\ntitle = "${title}"\n\n${menu
    .map((m) => `[[agent.menu]]\ncode = "X"\nskill = "${m}"\n`)
    .join('\n')}`,
});
const tree = (): Record<string, string> => ({
  LICENSE: 'MIT License\n\nCopyright (c) 2025 Example\n',
  ...agentSkill('crew-agent-analyst', 'Mary', 'Business Analyst', ['crew-brainstorming']),
  ...agentSkill('crew-agent-pm', 'John', 'Product Manager', ['crew-prd', 'crew-brainstorming']),
  ...agentSkill('crew-agent-dev', 'Amelia', 'Senior Software Engineer', []),
  ...agentSkill('crew-agent-ux', 'Sally', 'UX Designer', []),
  'skills/crew-brainstorming/SKILL.md': skill('crew-brainstorming'),
  'skills/crew-prd/SKILL.md': skill('crew-prd', 'Write a PRD', 'Steps.'),
  'plugins/qa/agents/test-runner.md':
    '---\nname: test-runner\ndescription: Runs the tests and reports.\ntools: Read, Grep\n---\n\nYou run tests.\n',
  'plugins/qa/commands/run-suite.md':
    '---\ndescription: Run the suite\n---\n# Run\n\nRun it on $ARGUMENTS.\n',
});

let w: World;
let r: FakeRunner;
let packId = '';
let snap: PackSnapshot;
let member: Awaited<ReturnType<typeof w.t.userSession>>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [PACKS_CAPABILITY] });
  member = await w.t.userSession(uniqueEmail('pt-member'));
  await w.t.addOrgMember(w.owner.id, member.id, 'member');
  packId = (
    await owner('POST', '/api/packs', { name: PACK, url: 'https://github.com/x/crew.git', ref: 'main' }, 201)
  ).pack.id;
  snap = packSnapshotOf({
    name: PACK,
    ref: 'v1.0.0',
    sha: 'c'.repeat(40),
    index: indexPack({ name: PACK, adapter: 'auto', tree: tree() }),
  });
  r.send('packs.report', { packId, state: 'resolved', snapshot: snap });
  await until(async () => (await owner('GET', '/api/packs')).packs[0].status === 'ready');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies
const owner = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);
// biome-ignore lint/suspicious/noExplicitAny: response bodies
const asMember = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(
    w.t.req(method, url, {
      cookie: member.cookie,
      headers: { 'x-aom-org': w.owner.id },
      ...(body !== undefined ? { body } : {}),
    }),
    expected,
  );
const agents = async () =>
  (await q('SELECT * FROM agents WHERE org_id=$1 ORDER BY hired_at', [w.owner.id])) as any[];
const hireBody = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  workstationId: w.workstationId,
  ...extra,
});

describe('classification', () => {
  it('refuses an unapproved pack, and lists no agents of it to a member', async () => {
    await owner('PUT', `/api/packs/${packId}/classification`, { agents: [], playbooks: [] }, 409);
    const t = await asMember('GET', `/api/packs/${packId}/team`);
    expect(t).toMatchObject({ trusted: false, agents: [], skills: [] });
  });

  it('approves the pack; a member cannot classify; bad keys and clashes are refused', async () => {
    await owner('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
    await asMember('PUT', `/api/packs/${packId}/classification`, { agents: [], playbooks: [] }, 403);
    await owner('PUT', `/api/packs/${packId}/classification`, { agents: ['nope'], playbooks: [] }, 400);
    await owner(
      'PUT',
      `/api/packs/${packId}/classification`,
      { agents: ['crew-prd'], playbooks: ['crew-prd'] },
      400,
    );
    // a persona (not a skill) cannot be classified
    await owner(
      'PUT',
      `/api/packs/${packId}/classification`,
      { agents: ['test-runner'], playbooks: [] },
      400,
    );
  });

  it('stores the full lists and reads them back', async () => {
    const put = await owner('PUT', `/api/packs/${packId}/classification`, {
      agents: ['crew-agent-pm', 'crew-agent-analyst', 'crew-agent-dev', 'crew-agent-ux'],
      playbooks: ['crew-prd'],
    });
    expect(put.agents).toEqual(['crew-agent-analyst', 'crew-agent-dev', 'crew-agent-pm', 'crew-agent-ux']);
    const t = await owner('GET', `/api/packs/${packId}/team`);
    expect(t.classification.playbooks).toEqual(['crew-prd']);
    expect(t.skills.find((s: { key: string }) => s.key === 'crew-prd')).toMatchObject({
      class: 'playbook',
      marked: true,
    });
    expect(t.skills.find((s: { key: string }) => s.key === 'crew-brainstorming')).toMatchObject({
      class: 'skill',
    });
  });

  it('a skill marked a playbook is listed as a playbook and can start a guided session', async () => {
    const reg = await owner('GET', '/api/capabilities?kind=playbook&usable=true');
    const pb = reg.items.find((i: CapabilityMeta) => i.key === full('crew-prd'));
    expect(pb).toMatchObject({ kind: 'playbook', loadAs: 'skill' });
    // the command of the plugin is a playbook too, with no marking
    expect(reg.items.map((i: CapabilityMeta) => i.key)).toContain(full('run-suite'));
    const slash = await owner('GET', '/api/slash-commands?context=session');
    expect(slash.items.find((i: { key: string }) => i.key === full('crew-prd'))).toMatchObject({
      kind: 'playbook',
      canStartSession: true,
      loadAs: 'skill',
    });
    const run = await owner(
      'POST',
      '/api/playbooks/run',
      { key: full('crew-prd'), workstationId: w.workstationId },
      201,
    );
    const cfg = (await q('SELECT session_config FROM threads WHERE id=$1', [run.threadId]))[0]?.session_config;
    expect(cfg.playbookRun).toMatchObject({ key: full('crew-prd') });
  });
});

describe('the pack team', () => {
  it('lists personas and skills marked as agents, with names, suggested seats and referenced skills', async () => {
    const t = await owner('GET', `/api/packs/${packId}/team`);
    expect(t.trusted).toBe(true);
    const by = Object.fromEntries(t.agents.map((a: { key: string }) => [a.key, a]));
    expect(Object.keys(by).sort()).toEqual([
      'crew-agent-analyst',
      'crew-agent-dev',
      'crew-agent-pm',
      'crew-agent-ux',
      'test-runner',
    ]);
    expect(by['crew-agent-analyst']).toMatchObject({
      name: 'Mary',
      kind: 'skill',
      marked: true,
      suggestedSeat: 'analyst',
      agentSkill: 'crew-agent-analyst',
      skillRefs: ['crew-brainstorming'],
    });
    expect(by['crew-agent-pm']).toMatchObject({
      name: 'John',
      suggestedSeat: 'planner',
      skillRefs: ['crew-brainstorming', 'crew-prd'],
    });
    expect(by['crew-agent-dev'].suggestedSeat).toBe('builder');
    expect(by['crew-agent-ux'].suggestedSeat).toBe('own');
    expect(by['test-runner']).toMatchObject({
      kind: 'persona',
      suggestedSeat: 'tester',
      marked: false,
      agentSkill: null,
    });
    expect(t.seats.map((s: { key: string }) => s.key)).not.toContain('ceo');
    // the same table the server used
    expect(suggestSeat({ key: 'crew-agent-pm', name: 'John' })).toBe('planner');
  });
});

describe('a pack agent on a seat', () => {
  let maryId = '';
  it('joins the agents already on the seat and inherits name, skill and the seat role', async () => {
    const before = await agents();
    const existing = await w.hire('Anna', 'analyst', 'senior');
    const res = await owner(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'crew-agent-analyst', seat: 'analyst' }]),
      201,
    );
    maryId = res.agents[0].agentId;
    expect(res.agents[0]).toMatchObject({ name: 'Mary', roleKey: 'analyst', seat: 'analyst', kind: 'skill' });
    const row = (await agents()).find((a) => a.id === maryId);
    expect(row).toMatchObject({ role_key: 'analyst', name: 'Mary', status: 'active' });
    // role version, permissions and model come from the seat role
    const role = (
      await q(
        `SELECT version, definition FROM role_definitions WHERE key='analyst' AND org_id IS NULL ORDER BY version DESC LIMIT 1`,
      )
    )[0];
    expect(row.role_version).toBe(role.version);
    expect(row.permissions).toEqual(role.definition.permissions);
    expect(row.model).toBe(role.definition.defaultModel.model);
    // skills: the role's, the persona skill, the skill its files name
    expect(row.skills).toEqual([
      ...role.definition.skills,
      full('crew-agent-analyst'),
      full('crew-brainstorming'),
    ]);
    expect(row.pack_persona).toMatchObject({
      packId,
      key: 'crew-agent-analyst',
      kind: 'skill',
      name: 'Mary',
      packName: PACK,
    });
    // nobody was replaced or retired
    expect((await agents()).filter((a) => a.id === existing.id)[0].status).toBe('active');
    expect((await agents()).length).toBe(before.length + 2);
  });

  it('de-duplicates the default name', async () => {
    const res = await owner(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'crew-agent-analyst', seat: 'analyst', count: 2 }]),
      201,
    );
    expect(res.agents.map((a: { name: string }) => a.name)).toEqual(['Mary 2', 'Mary 3']);
    await owner(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'crew-agent-analyst', seat: 'analyst', name: 'Mary' }]),
      409,
    );
  });

  it('chosen skills replace the referenced default; none is allowed; unknown ones are refused', async () => {
    const a = await owner(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'crew-agent-pm', seat: 'planner', skills: [] }]),
      201,
    );
    const b = await owner(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'crew-agent-dev', seat: 'builder', skills: ['crew-prd'] }]),
      201,
    );
    const rows = await agents();
    expect(rows.find((x) => x.id === a.agents[0].agentId).skills).toContain(full('crew-agent-pm'));
    expect(rows.find((x) => x.id === a.agents[0].agentId).skills).not.toContain(full('crew-prd'));
    expect(rows.find((x) => x.id === b.agents[0].agentId).skills).toEqual(
      expect.arrayContaining([full('crew-agent-dev'), full('crew-prd')]),
    );
    await owner(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'crew-agent-dev', seat: 'builder', skills: ['nope'] }]),
      400,
    );
  });

  it('refuses seats that are not seats, unknown agents and a hire a member may not make', async () => {
    for (const seat of ['ceo', 'devops', 'curator', 'chair'])
      await owner(
        'POST',
        `/api/packs/${packId}/agents/hire`,
        hireBody([{ key: 'crew-agent-dev', seat }]),
        400,
      );
    await owner(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'nope', seat: 'builder' }]),
      400,
    );
    // a Member names no project: refused as for any hire
    await asMember(
      'POST',
      `/api/packs/${packId}/agents/hire`,
      hireBody([{ key: 'crew-agent-dev', seat: 'builder' }]),
      403,
    );
  });

  it('the brief carries the pack agent, and the instructions the fenced block', async () => {
    const spec = await agentSpecFor(
      w.t.app.ctx,
      (await agents()).find((a) => a.id === maryId),
    );
    expect(spec.packAgent).toEqual({ name: 'Mary', packName: PACK, ref: full('crew-agent-analyst') });
    const plain = await agentSpecFor(
      w.t.app.ctx,
      (await agents()).find((a) => a.name === 'Anna'),
    );
    expect(plain.packAgent).toBeUndefined();
  });

  it('shows the tag and follows the pack: a revoked approval flags the agent, an update needs no role change', async () => {
    const dto = (await owner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === maryId);
    expect(dto.packAgent).toMatchObject({ key: 'crew-agent-analyst', kind: 'skill' });
    expect(dto.provenance).toMatchObject({ packName: PACK, capability: 'crew-agent-analyst', warning: null });
    await owner('POST', `/api/packs/${packId}/revoke`);
    const flagged = (await owner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === maryId);
    expect(flagged.provenance.warning).toBe('revoked');
    await owner('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
    const again = (await owner('GET', '/api/agents')).agents.find((a: { id: string }) => a.id === maryId);
    expect(again.provenance.warning).toBeNull();
  });
});

describe('the whole pack at once', () => {
  it('is for the Owner and Admins', async () => {
    await asMember(
      'POST',
      `/api/packs/${packId}/team/hire`,
      hireBody([{ key: 'crew-agent-dev', seat: 'builder' }], { allowedProjectIds: [w.projectId] }),
      403,
    );
  });

  it('is all or nothing: one bad item hires nobody', async () => {
    const before = (await agents()).length;
    await owner(
      'POST',
      `/api/packs/${packId}/team/hire`,
      hireBody([
        { key: 'crew-agent-dev', seat: 'builder' },
        { key: 'nope', seat: 'own' },
      ]),
      400,
    );
    // a refused name in the middle rolls back the earlier hires and the roles made for them
    await owner(
      'POST',
      `/api/packs/${packId}/team/hire`,
      hireBody([
        { key: 'crew-agent-ux', seat: 'own' },
        { key: 'crew-agent-dev', seat: 'builder', name: 'Anna' },
      ]),
      409,
    );
    expect((await agents()).length).toBe(before);
    expect(
      await q(`SELECT 1 FROM role_definitions WHERE org_id=$1 AND key LIKE $2`, [w.owner.id, `${PACK}-%`]),
    ).toEqual([]);
  });

  it('checks the plan limit once for the total', async () => {
    const calls: Array<[string, number]> = [];
    const ext = w.t.app.ctx.ext.planLimits;
    const orig = ext.assertWithin;
    ext.assertWithin = async (_tx, _org, kind, delta) => {
      calls.push([kind, delta]);
      if (kind === 'agents' && delta > 3) throw Object.assign(new Error('limit'), { statusCode: 409 });
    };
    try {
      const before = (await agents()).length;
      await owner(
        'POST',
        `/api/packs/${packId}/team/hire`,
        hireBody([{ key: 'crew-agent-dev', seat: 'builder', count: 4 }]),
        409,
      );
      expect((await agents()).length).toBe(before);
      expect(calls.filter(([k]) => k === 'agents')).toEqual([['agents', 4]]);
    } finally {
      ext.assertWithin = orig;
    }
  });

  it('hires the team onto its suggested seats and one role of its own, and records one event', async () => {
    const t = await owner('GET', `/api/packs/${packId}/team`);
    const items = t.agents.map((a: { key: string; suggestedSeat: string }) => ({
      key: a.key,
      seat: a.suggestedSeat,
    }));
    const before = (await agents()).length;
    const res = await owner('POST', `/api/packs/${packId}/team/hire`, hireBody(items), 201);
    expect(res.agents).toHaveLength(5);
    expect((await agents()).length).toBe(before + 5);
    const seats = Object.fromEntries(
      res.agents.map((a: { key: string; roleKey: string }) => [a.key, a.roleKey]),
    );
    expect(seats).toMatchObject({
      'crew-agent-analyst': 'analyst',
      'crew-agent-pm': 'planner',
      'crew-agent-dev': 'builder',
      'test-runner': 'tester',
    });
    const ux = seats['crew-agent-ux'];
    expect(ux).toBe('crew-crew-agent-ux');
    // the role of its own holds none of the pack's text, and claims no stage
    const role = (
      await q(`SELECT definition FROM role_definitions WHERE org_id=$1 AND key=$2`, [w.owner.id, ux])
    )[0].definition;
    expect(role.claimableStages).toEqual([]);
    expect(role.instructions).not.toContain('Sally');
    expect(role.source).toMatchObject({ packId });
    const ev = await q(`SELECT payload FROM events WHERE type='PackTeamHired' ORDER BY seq DESC LIMIT 1`);
    expect(ev[0].payload).toMatchObject({ packId, mode: 'team', hireId: res.hireId });
    expect(ev[0].payload.agents).toHaveLength(5);
    // hiring the persona onto its own role uses the persona's declared tools (read only here), never more
    const tester = (await agents()).find(
      (a) => a.id === res.agents.find((x: { key: string }) => x.key === 'test-runner').agentId,
    );
    expect(tester.pack_persona.kind).toBe('persona');
    // a second time, the role of its own is reused
    const again = await owner(
      'POST',
      `/api/packs/${packId}/team/hire`,
      hireBody([{ key: 'crew-agent-ux', seat: 'own' }]),
      201,
    );
    expect(again.agents[0].roleKey).toBe(ux);
    expect(again.agents[0].name).toBe('Sally 2');
  });
});

describe('replay', () => {
  it('rebuilds agents and packs to the same state', async () => {
    const snapshot = async () =>
      JSON.stringify([
        await q('SELECT id, name, role_key, skills, pack_persona, provenance FROM agents ORDER BY id'),
        await q('SELECT id, classification FROM packs ORDER BY id'),
      ]);
    const a = await snapshot();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snapshot()).toBe(a);
    expect(JSON.parse(a)[1][0].classification.playbooks).toEqual(['crew-prd']);
  });

  it('removing the pack flags the agents hired from it', async () => {
    await owner('DELETE', `/api/packs/${packId}`, undefined, 204);
    const flagged = (await owner('GET', '/api/agents')).agents.filter(
      (a: { packAgent?: unknown }) => a.packAgent,
    );
    expect(flagged.length).toBeGreaterThan(5);
    expect(
      flagged.every((a: { provenance: { warning: string } }) => a.provenance.warning === 'removed'),
    ).toBe(true);
  });
});
