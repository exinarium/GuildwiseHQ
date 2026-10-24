import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, PERSONA_HOST_AGENT_ID, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const THREAD_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
const readOnly = {
  allowedTools: ['read'],
  deniedShellPatterns: [],
  writableGlobs: [],
  mayCommit: false,
  browser: false,
  readOrgRepos: false,
  riskTiers: ['small', 'large'],
  repoIds: [],
};
const personaAgent = (over: Record<string, unknown> = {}) => ({
  agentId: PERSONA_HOST_AGENT_ID,
  name: "Devil's Advocate",
  roleKey: 'persona',
  seniority: 'senior',
  runtime: 'mock',
  model: 'mock',
  skills: [],
  permissions: readOnly,
  isDevops: false,
  ...over,
});
const turn = (over: Record<string, unknown> = {}, session: Record<string, unknown> = {}) => {
  const turnId = uuidv7();
  return {
    chatId: turnId,
    threadId: THREAD_ID,
    agent: personaAgent(),
    message: '## Your turn\n\nAttack the per-seat idea.',
    context: { orgId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a9' },
    session: {
      turnId,
      kind: 'boardroom',
      speaker: { kind: 'persona', name: "Devil's Advocate", personaKey: 'devils-advocate', seat: 'Skeptic' },
      instructions: 'You are the Devil’s Advocate. Attack the plan.',
      roster: [
        { name: 'Pieter', kind: 'user', seat: 'Owner' },
        { name: 'Cost Hawk', kind: 'persona', seat: 'Panel' },
      ],
      ...session,
    },
    ...over,
  };
};
const instructionsOf = (hh: Harness, agentId = PERSONA_HOST_AGENT_ID) =>
  readFileSync(join(runnerPaths(hh.dataDir).agentDir(agentId), 'claude', 'CLAUDE.md'), 'utf8');

describe('a session turn on the runner (mock adapter)', () => {
  it('announces that it runs session turns', async () => {
    h = await startHarness();
    expect(h.server.of('hello')[0]?.capabilities).toContain('session-turns:1');
  });

  it('runs the persona read-only and streams the reply back as chat frames', async () => {
    h = await startHarness();
    const msg = turn();
    h.server.send('chat.start', msg);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(done.messageText).toBe(
      "[mock] Devil's Advocate heard: ## Your turn\n\nAttack the per-seat idea. (turn 1)",
    );
    expect(h.server.of('chat.delta').filter((d) => d.chatId === msg.chatId).length).toBeGreaterThan(3);
    expect(done.usage.outputTokens).toBe(done.messageText.length);
    const md = instructionsOf(h);
    expect(md).toContain("You are Devil's Advocate, seated as Skeptic");
    expect(md).toContain('Attack the plan.');
    expect(md).toContain('- Pieter (Owner, user)');
    expect(md).toContain('- Cost Hawk (Panel, persona)');
    expect(md).toContain('`aom`');
    // it is not a chat about a card: no worktree, no repositories, nothing about the manager
    expect(md).not.toContain('manager you are chatting with');
    expect(h.server.invalid).toEqual([]);
    expect(h.runner.chat.size).toBe(0);
  });

  it('reads the text of a stored persona from its own registry when the turn carries none', async () => {
    h = await startHarness();
    const msg = turn(
      { agent: personaAgent({ name: 'Cost Hawk' }) },
      {
        instructions: undefined,
        speaker: { kind: 'persona', name: 'Cost Hawk', personaKey: 'cost-hawk', seat: 'Panel' },
      },
    );
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    const md = instructionsOf(h);
    expect(md).toContain('You are the Cost Hawk.');
    // the stance and voice come from the persona file when the server did not send them
    expect(md).toContain('Your stance: Frugal and numerate.');
    expect(md).toContain('Your voice: Plain and numeric.');
  });

  it('fails clearly for a persona it does not have', async () => {
    h = await startHarness();
    const msg = turn(
      {},
      { instructions: undefined, speaker: { kind: 'persona', name: 'Ghost', personaKey: 'ghost-persona' } },
    );
    h.server.send('chat.start', msg);
    const err = await h.server.waitFor('chat.error', (d) => d.chatId === msg.chatId);
    expect(err.error).toContain('"ghost-persona" was not found on this workstation');
  });

  it('gives an agent speaker the index of the capabilities its role lists', async () => {
    h = await startHarness();
    const agentId = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
    const msg = turn(
      {
        agent: personaAgent({
          agentId,
          name: 'Ana',
          roleKey: 'analyst',
          skills: ['interview-techniques', 'prd'],
        }),
      },
      {
        speaker: { kind: 'agent', name: 'Ana', seat: 'Facilitator' },
        kind: 'discovery',
        instructions: 'Facilitate the session.',
      },
    );
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    const md = instructionsOf(h, agentId);
    expect(md).toContain('# Capabilities');
    expect(md).toContain('`skill:interview-techniques`');
    expect(md).toContain('`playbook:prd`');
    expect(md).toContain('a discovery session');
  });

  it('can be cancelled and ignores a redelivered start', async () => {
    process.env.AOM_MOCK_CHAT_TOKEN_MS = '200';
    try {
      h = await startHarness();
      const msg = turn();
      h.server.send('chat.start', msg);
      h.server.send('chat.start', msg);
      await h.server.waitFor('chat.delta', (d) => d.chatId === msg.chatId);
      h.server.send('chat.cancel', { chatId: msg.chatId });
      const err = await h.server.waitFor('chat.error', (d) => d.chatId === msg.chatId);
      expect(err.error).toBe('cancelled');
      expect(h.server.of('chat.done').filter((d) => d.chatId === msg.chatId)).toHaveLength(0);
    } finally {
      delete process.env.AOM_MOCK_CHAT_TOKEN_MS;
    }
  });
});

describe('dispatch ids on the runner (R3c)', () => {
  it('echoes the id of the dispatch in every frame of the turn', async () => {
    h = await startHarness();
    const msg = { ...turn(), attemptId: 'attempt-A' };
    h.server.send('chat.start', msg);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(done.attemptId).toBe('attempt-A');
    const deltas = h.server.of('chat.delta').filter((d) => d.chatId === msg.chatId);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.attemptId === 'attempt-A')).toBe(true);
    expect(h.server.invalid).toEqual([]);
  });

  it('sends no id when the server sent none (an older server)', async () => {
    h = await startHarness();
    const msg = turn();
    h.server.send('chat.start', msg);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(done).not.toHaveProperty('attemptId');
  });

  it('keeps a running turn when the server sends it again, and answers the newest dispatch from then on', async () => {
    process.env.AOM_MOCK_CHAT_TOKEN_MS = '150';
    try {
      h = await startHarness();
      const msg = { ...turn(), attemptId: 'attempt-A' };
      h.server.send('chat.start', msg);
      await h.server.waitFor('chat.delta', (d) => d.chatId === msg.chatId);
      h.server.send('chat.start', { ...msg, attemptId: 'attempt-B' });
      const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
      expect(done.attemptId).toBe('attempt-B');
      // one run only: the second dispatch did not start another
      expect(h.server.of('chat.done').filter((d) => d.chatId === msg.chatId)).toHaveLength(1);
      expect(h.runner.chat.attemptOf(msg.chatId)).toBe('attempt-B');
    } finally {
      delete process.env.AOM_MOCK_CHAT_TOKEN_MS;
    }
  });

  it('ignores a redelivery of the dispatch that ended, but runs a new dispatch of a turn that already ended here', async () => {
    h = await startHarness();
    const msg = { ...turn(), attemptId: 'attempt-A' };
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    h.server.send('chat.start', msg); // the same dispatch again
    await new Promise((r) => setTimeout(r, 300));
    expect(h.server.of('chat.done').filter((d) => d.chatId === msg.chatId)).toHaveLength(1);
    // the server took the reply for lost and dispatched again: that is work, answered under the new id
    h.server.send('chat.start', { ...msg, attemptId: 'attempt-B' });
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId && d.attemptId === 'attempt-B');
    expect(h.server.of('chat.done').filter((d) => d.chatId === msg.chatId)).toHaveLength(2);
  });
});

describe('the capability index in a card shift', () => {
  it('lists the capabilities a role names, with name and description, and how to load them', async () => {
    h = await startHarness();
    const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
    if (!builder) throw new Error('role');
    const agentId = '019e3f6a-7b1c-7a2d-8c3e-0123456789b1';
    await h.runShift({
      stage: 'build',
      agentId,
      agentName: 'Una',
      startExtra: {
        agent: {
          agentId,
          name: 'Una',
          roleKey: 'builder',
          seniority: 'senior',
          runtime: 'mock',
          model: 'mock',
          skills: ['prd', 'not-in-the-registry'],
          permissions: builder.permissions,
          isDevops: false,
        },
      },
    });
    const md = readFileSync(join(h.dataDir, 'agents', agentId, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('# Capabilities');
    expect(md).toContain('`playbook:prd`');
    expect(md).toContain('aom skill show');
    expect(md).toContain('`not-in-the-registry`: not found in the registry');
  });
});
