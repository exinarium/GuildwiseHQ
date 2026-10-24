import { SESSION_TURNS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { FakeRunner as Runner } from './helpers/fake-runner.ts';
import { addMember as addProjectMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, REPO_SSH, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await freshState();
});

/** A Member of the owner's organization (and on its project) with a workstation of their own. */
async function addMember(world: World, label: string) {
  const m = await addProjectMember(world, label);
  await world.t.addOrgMember(world.owner.id, m.id, 'member');
  return m;
}

async function connectMemberRunner(world: World, m: { runnerToken: string }) {
  const mr = await Runner.connect(world.baseUrl, m.runnerToken);
  mr.hello({
    repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy-member', headBranch: 'main' }],
    runtimes: MOCK_RUNTIME,
    capabilities: [SESSION_TURNS_CAPABILITY],
  });
  await mr.waitFor('welcome');
  await world.t.app.ctx.notifier.flush();
  return mr;
}

const USAGE = { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
const DRAFT = {
  name: 'Penny',
  purpose: 'Writes release notes from merged changes.',
  instructions:
    'You write release notes for customers. Read the list of merged changes you are given, group them, and write one short line per change in plain words. Never invent a change. Report what you left out.',
  tools: ['read', 'edit', 'shell'],
  model: 'haiku',
  skills: ['interview-techniques', 'no-such-skill'],
  playbooks: ['release-notes', 'no-such-playbook'],
};
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );

async function draftWith(
  reply: string,
  cookie = w.owner.cookie,
  runner = r,
  headers: Record<string, string> = {},
) {
  const started = await ok<any>(
    w.t.req('POST', '/api/agents/draft', {
      cookie,
      headers,
      body: { description: 'An agent that writes our release notes', runtime: 'mock', model: 'mock' },
    }),
    202,
  );
  const start = await runner.waitFor('chat.start', (f) => f.threadId === started.threadId);
  runner.send('chat.done', {
    chatId: start.chatId,
    threadId: started.threadId,
    messageText: reply,
    usage: USAGE,
  });
  return { threadId: started.threadId as string, start };
}

describe('describe-an-agent quick hire', () => {
  it('has the Analyst draft a role from one sentence, shows it clamped, and hires nothing', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM agents'))[0]!.n;
    const { threadId, start } = await draftWith(`Here you go:\n\`\`\`json\n${JSON.stringify(DRAFT)}\n\`\`\``);
    // the turn is a persona-chat turn of the Analyst, asked for JSON with the registry's skills and playbooks listed
    expect(start.session).toMatchObject({
      kind: 'persona_chat',
      purpose: 'persona_chat',
      speaker: { personaKey: 'analyst' },
    });
    expect(start.message).toContain('An agent that writes our release notes');
    expect(start.message).toContain('release-notes');
    await until(async () => (await asOwner('GET', `/api/agents/draft/${threadId}`)).status === 'ready');
    const got = await asOwner('GET', `/api/agents/draft/${threadId}`);
    expect(got.draft).toMatchObject({ name: 'Penny', model: 'haiku', tools: ['read', 'edit', 'shell'] });
    // unknown skills and playbooks are dropped; known ones are kept
    expect(got.draft.skills).toEqual(['interview-techniques']);
    expect(got.draft.playbooks).toEqual(['release-notes']);
    // the Owner may grant everything the draft asked for
    expect(got.draft.permissions.allowedTools).toEqual(['read', 'edit', 'shell']);
    expect(got.draft.withheld).toEqual([]);
    // nothing was hired, and the cost of the turn is booked
    expect((await q('SELECT count(*)::int AS n FROM agents'))[0]!.n).toBe(before);
    await until(async () => (await q(`SELECT 1 FROM shift_costs WHERE kind='session'`)).length > 0);
  });

  it('reports working until the Analyst answers and failed when the answer holds no draft', async () => {
    const started = await ok<any>(
      w.t.req('POST', '/api/agents/draft', {
        cookie: w.owner.cookie,
        body: { description: 'Something vague here', runtime: 'mock', model: 'mock' },
      }),
      202,
    );
    expect((await asOwner('GET', `/api/agents/draft/${started.threadId}`)).status).toBe('working');
    const start = await r.waitFor('chat.start', (f) => f.threadId === started.threadId);
    r.send('chat.done', {
      chatId: start.chatId,
      threadId: started.threadId,
      messageText: 'I need more detail.',
      usage: USAGE,
    });
    await until(
      async () => (await asOwner('GET', `/api/agents/draft/${started.threadId}`)).status === 'failed',
    );
    expect((await asOwner('GET', `/api/agents/draft/${started.threadId}`)).error).toContain('no draft');
    // somebody else cannot read it
    const other = await addMember(w, 'nosy');
    expect(
      (
        await w.t.req('GET', `/api/agents/draft/${started.threadId}`, {
          cookie: other.cookie,
          headers: { 'x-aom-org': w.owner.id },
        })
      ).status,
    ).toBe(404);
  });

  it('clamps the draft to a member’s authority and says what was withheld', async () => {
    const m = await addMember(w, 'mem');
    const mr = await connectMemberRunner(w, m);
    const { threadId } = await draftWith(JSON.stringify(DRAFT), m.cookie, mr, { 'x-aom-org': w.owner.id });
    await until(
      async () =>
        (
          await ok<any>(
            w.t.req('GET', `/api/agents/draft/${threadId}`, {
              cookie: m.cookie,
              headers: { 'x-aom-org': w.owner.id },
            }),
          )
        ).status === 'ready',
    );
    const got = await ok<any>(
      w.t.req('GET', `/api/agents/draft/${threadId}`, {
        cookie: m.cookie,
        headers: { 'x-aom-org': w.owner.id },
      }),
    );
    expect(got.draft.permissions.allowedTools).toEqual(['read']);
    expect(got.draft.tools).toEqual(['read']);
    expect(got.draft.withheld).toEqual(['the edit tool', 'the shell tool']);
    // the edit step asks again after the hirer changes the tools: the clamp is repeated, never trusted from the client
    const re = await ok<any>(
      w.t.req('POST', '/api/agents/draft-clamp', {
        cookie: m.cookie,
        headers: { 'x-aom-org': w.owner.id },
        body: { draft: { ...DRAFT, tools: ['read', 'web'] } },
      }),
    );
    expect(re.draft.permissions.allowedTools).toEqual(['read']);
    mr.close();
  });

  it('hires from the reviewed draft through the normal hire path: a role, the clamped permissions, granted playbooks', async () => {
    const res = await ok<any>(
      w.t.req('POST', '/api/agents/hire-from-draft', {
        cookie: w.owner.cookie,
        body: {
          draft: { ...DRAFT, name: 'Penny', tools: ['read', 'web'] },
          name: 'Penny',
          seniority: 'senior',
          workstationId: w.workstationId,
          runtime: 'mock',
          model: 'mock',
          allowedProjectIds: [w.projectId],
          capacity: 1,
        },
      }),
      201,
    );
    expect(res).toMatchObject({ name: 'Penny', seniority: 'senior' });
    expect(res.permissions.allowedTools).toEqual(['read', 'web']);
    expect(res.permissions.mayCommit).toBe(false);
    const role = (
      await q(`SELECT * FROM role_definitions WHERE key=$1 ORDER BY version DESC LIMIT 1`, [res.roleKey])
    )[0]!;
    expect(role.key).toMatch(/^draft-penny-[a-z0-9]{4}$/);
    expect(JSON.stringify(role.definition)).toContain('release notes for customers');
    expect(role.definition.claimableStages).toEqual([]);
    expect(res.skills).toEqual(['interview-techniques']);
    const grants = await q('SELECT playbook_key FROM agent_playbook_grants WHERE agent_id=$1', [res.id]);
    expect(grants.map((g) => g.playbook_key)).toEqual(['release-notes']);
  });

  it('never gives a member more than they may grant, even when the request asks for it', async () => {
    const m = await addMember(w, 'mem2');
    const res = await ok<any>(
      w.t.req('POST', '/api/agents/hire-from-draft', {
        cookie: m.cookie,
        headers: { 'x-aom-org': w.owner.id },
        body: {
          draft: { ...DRAFT, name: 'Quinn', tools: ['read', 'edit', 'shell', 'web'] },
          name: 'Quinn',
          seniority: 'junior',
          workstationId: m.workstationId,
          runtime: 'mock',
          model: 'mock',
          allowedProjectIds: [w.projectId],
          capacity: 1,
        },
      }),
      201,
    );
    expect(res.permissions.allowedTools).toEqual(['read']);
    expect(res.permissions.writableGlobs).toEqual([]);
  });

  it('refuses a draft with no instructions and a hire onto a workstation that is not the hirer’s', async () => {
    const base = {
      name: 'Zed',
      seniority: 'junior',
      workstationId: w.workstationId,
      runtime: 'mock',
      model: 'mock',
      allowedProjectIds: [w.projectId],
      capacity: 1,
    };
    expect(
      (
        await w.t.req('POST', '/api/agents/hire-from-draft', {
          cookie: w.owner.cookie,
          body: { ...base, draft: { ...DRAFT, instructions: 'short' } },
        })
      ).status,
    ).toBe(400);
    const m = await addMember(w, 'mem3');
    expect(
      (
        await w.t.req('POST', '/api/agents/hire-from-draft', {
          cookie: m.cookie,
          headers: { 'x-aom-org': w.owner.id },
          body: { ...base, draft: DRAFT },
        })
      ).status,
    ).toBe(404);
  });
});

describe('starter gallery', () => {
  it('lists the curated built-ins with one-line outcomes, and is a first run until something is hired or started', async () => {
    await q(`UPDATE agents SET status='retired'`);
    await q(`DELETE FROM threads WHERE kind IN ('discovery','boardroom','persona_chat')`);
    const g = await asOwner('GET', '/api/starter-gallery');
    expect(g.firstRun).toBe(true);
    const keys = g.entries.map((e: any) => `${e.kind}:${e.key}`);
    for (const k of [
      'playbook:release-notes',
      'playbook:pr-triage',
      'playbook:weekly-status',
      'playbook:incident-followup',
      'persona:analyst',
      'persona:security',
    ])
      expect(keys).toContain(k);
    expect(g.entries.every((e: any) => e.outcome.length > 10 && e.outcome.length < 120)).toBe(true);
    await w.hire('Una', 'builder', 'junior');
    expect((await asOwner('GET', '/api/starter-gallery')).firstRun).toBe(false);
  });

  it('gives a starter persona as a draft for the review step, clamped like any draft', async () => {
    const d = await asOwner('GET', '/api/starter-gallery/security/draft');
    expect(d.draft).toMatchObject({ name: 'Security', tools: ['read'], model: 'haiku' });
    expect(d.draft.instructions).toContain('Security reviewer');
    expect(
      (await w.t.req('GET', '/api/starter-gallery/no-such/draft', { cookie: w.owner.cookie })).status,
    ).toBe(404);
    // only entries of the gallery, not any persona
    expect(
      (await w.t.req('GET', '/api/starter-gallery/chair/draft', { cookie: w.owner.cookie })).status,
    ).toBe(404);
  });

  it('runs a starter playbook as a guided session through the existing playbook path', async () => {
    const res = await ok<any>(
      w.t.req('POST', '/api/playbooks/run', {
        cookie: w.owner.cookie,
        body: { key: 'release-notes', workstationId: w.workstationId },
      }),
      201,
    );
    expect(res.threadId ?? res.state?.threadId ?? res.session?.threadId).toBeTruthy();
    const slash = await asOwner('GET', '/api/slash-commands?context=session');
    expect(slash.items.map((i: any) => i.key)).toEqual(
      expect.arrayContaining(['release-notes', 'pr-triage', 'weekly-status', 'incident-followup']),
    );
  });
});
