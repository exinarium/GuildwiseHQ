import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalAdapters } from '../src/external/index.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const reports = (hh: Harness, shiftId: string) =>
  hh.server.of('shift.report').filter((r) => r.shiftId === shiftId);

const ITEM = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

/** A `question` shift: no worktree, the brief carries the card the question is about, the question in `question`. */
function questionShift(
  hh: Harness,
  over: { mock?: Record<string, string[]>; matches?: boolean; role?: string } = {},
) {
  const base = makeShiftStart({
    stage: 'build',
    remoteNormalized: hh.repo.remoteNormalized,
    ...(over.mock ? { mock: over.mock } : {}),
  }) as any;
  const role = BUILTIN_ROLES.find(
    (r) => r.key === (over.role ?? 'builder'),
  ) as (typeof BUILTIN_ROLES)[number];
  base.kind = 'question';
  base.worktree = null;
  base.agent = { ...base.agent, roleKey: role.key, permissions: role.permissions, name: 'Sam' };
  base.brief.agent.name = 'Sam';
  base.brief.shift = {
    id: base.shiftId,
    kind: 'question',
    stage: 'question',
    stageLabel: 'Question',
    doneCriteria: 'Answer or pass it on.',
    outcomes: [],
    maxShiftMinutes: 15,
  };
  base.brief.role = {
    key: role.key,
    name: role.name,
    instructions: role.instructions,
    coreRules: role.coreRules,
    skills: [],
  };
  base.question = {
    deskItemId: ITEM,
    level: over.role === 'ba' ? 'ba' : 'peer',
    text: 'Should source files use tabs or spaces?',
    doing: 'writing the formatter',
    options: [
      { id: 'o1', label: 'tabs' },
      { id: 'o2', label: 'spaces' },
    ],
    recommendation: 'o1',
    blocking: true,
    askedBy: { name: 'Bea', role: 'builder' },
    trail: [],
    ledgerMatches: over.matches
      ? [{ id: uuidv7(), scope: 'decision', title: 'Indent', body: 'Use tabs.' }]
      : [],
  };
  return base as { shiftId: string };
}

async function run(hh: Harness, msg: { shiftId: string }) {
  hh.server.send('shift.start', msg as never);
  return hh.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
}

describe('question shifts on the mock runtime', () => {
  it("answers the question with the asker's recommended option; no worktree is created", async () => {
    h = await startHarness();
    const msg = questionShift(h);
    const ended = await run(h, msg);
    expect(ended.outcome).toBe('reported');
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({
      kind: 'answer',
      itemId: ITEM,
      optionId: 'o1',
      text: expect.stringContaining('recommended option'),
    });
    expect(existsSync(worktreeOf(h))).toBe(false);
    expect(h.server.of('shift.started').find((m) => m.shiftId === msg.shiftId)?.worktree).toBeUndefined();
    expect(h.server.invalid).toEqual([]);
  }, 60_000);

  it('quotes the ledger entry that matched, and writes the question instructions', async () => {
    h = await startHarness();
    const msg = questionShift(h, { matches: true, role: 'ba' });
    await run(h, msg);
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({
      kind: 'answer',
      text: 'mock answer from the ledger: Use tabs.',
    });
    // the instructions the agent got are the question shift's (answer / escalate), not a card shift's
    const agentId = (msg as any).agent.agentId as string;
    const md = readFileSync(join(h.dataDir, 'agents', agentId, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('passed to you, the BA');
    expect(md).toContain('aom escalate');
  }, 60_000);

  it("escalates when the card's mock script says so", async () => {
    h = await startHarness();
    const msg = questionShift(h, { mock: { question: ['escalate'] } });
    const ended = await run(h, msg);
    expect(ended.outcome).toBe('reported');
    expect(reports(h, msg.shiftId)[0]?.report).toMatchObject({
      kind: 'escalate',
      itemId: ITEM,
      note: expect.stringContaining('cannot settle'),
    });
  }, 60_000);

  it('counts a question shift as a shift on `hello` (so the server keeps it) but has no card', async () => {
    h = await startHarness();
    const msg = questionShift(h, { mock: { question: ['escalate'] } });
    await run(h, msg);
    expect(h.runner.supervisor.activeShifts()).toEqual([]);
  }, 60_000);
});

describe('BA finalize on the mock runtime', () => {
  it('claims the Finalize stage of a built card and reports the completion action as the finalized outcome', async () => {
    h = await startHarness();
    await h.runShift({ stage: 'build' });
    const f = await h.runShift({ stage: 'finalize', agentName: 'Ben' });
    expect(f.ended.outcome).toBe('reported');
    expect(reports(h, f.shiftId)[0]?.report).toMatchObject({
      kind: 'outcome',
      outcomeId: 'finalized',
      data: { action: 'push_branch' },
    });
    expect(h.server.invalid).toEqual([]);
  }, 120_000);
});

describe('the BA intake chat on the mock runtime', () => {
  const BA_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a9';
  const THREAD = '019e3f6a-7b1c-7a2d-8c3e-0123456789c9';
  const ba = BUILTIN_ROLES.find((r) => r.key === 'ba') as (typeof BUILTIN_ROLES)[number];

  const chat = (message: string, intake: Record<string, unknown>) => ({
    chatId: uuidv7(),
    threadId: THREAD,
    agent: {
      agentId: BA_ID,
      name: 'Ben',
      roleKey: 'ba',
      seniority: 'senior',
      runtime: 'mock',
      model: 'mock',
      skills: [],
      permissions: ba.permissions,
      isDevops: false,
    },
    message,
    context: {
      intake: {
        intakeId: uuidv7(),
        projects: [{ key: 'TOY', name: 'Toy', domain: 'work', repos: ['toy'] }],
        cards: [],
        ...intake,
      },
    },
  });

  /** A fake of the server's chat-scoped rpcs: records them and answers like the real ones. */
  const server = () => {
    const calls: Array<{ method: string; params: Record<string, any> }> = [];
    let n = 0;
    return {
      calls,
      rpc: (m: { method: string; params: Record<string, unknown> }) => {
        calls.push({ method: m.method, params: m.params as Record<string, any> });
        if (m.method === 'intake.map')
          return { ok: true, result: { project: m.params.project, repos: ['toy'] } };
        if (m.method === 'intake.unmapped')
          return { ok: true, result: { deskItemId: uuidv7(), message: 'Asked the manager.' } };
        if (m.method === 'card.create')
          return { ok: true, result: { ref: `TOY-${++n}`, id: uuidv7(), missing: [] } };
        if (m.method === 'card.specify')
          return { ok: true, result: { ref: m.params.ref, stage: 'build', status: 'queued' } };
        return { ok: false, error: 'not implemented in fake' };
      },
    };
  };

  const fixture = (hh: Harness, key: string, body: Record<string, unknown>) => {
    const dir = join(hh.dataDir, 'mock-sources');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(body));
  };

  it('reads a Jira ticket with the skill, maps it to a project and drafts a card with a completion action', async () => {
    const s = server();
    h = await startHarness({ rpc: s.rpc });
    fixture(h, 'ABC-123', {
      title: 'Add the login page',
      body: 'Users cannot sign in.',
      project: 'TOY',
      completionAction: 'pr',
      acceptanceCriteria: ['The form validates the email'],
      mock: { build: ['ok'] },
    });
    const msg = chat('ABC-123', { externalSystem: 'jira', externalKey: 'ABC-123' });
    h.server.send('chat.start', msg as never);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 60_000);
    expect(s.calls.map((c) => c.method)).toEqual(['intake.map', 'card.create', 'card.specify']);
    expect(s.calls[0]?.params).toEqual({ project: 'TOY' });
    expect(s.calls[1]?.params).toMatchObject({
      title: 'Add the login page',
      completionAction: 'pr',
      repo: 'toy',
      externalRef: 'ABC-123',
      dependencies: [],
      fields: {
        context: expect.stringContaining('ABC-123: Add the login page'),
        acceptanceCriteria: ['The form validates the email'],
        testPlan: expect.any(String),
        mock: { build: ['ok'] },
      },
    });
    expect(s.calls[2]?.params).toEqual({ ref: 'TOY-1' });
    expect(done.messageText).toContain('Read Jira ticket ABC-123 with the Jira skill');
    expect(done.messageText).toContain('Created TOY-1 from ABC-123');
    expect(done.runtimeSessionId).toBe(`mock-${BA_ID}-1`);
    expect(h.server.invalid).toEqual([]);
  }, 60_000);

  it('asks the manager when the ticket maps to no project', async () => {
    const s = server();
    h = await startHarness({ rpc: s.rpc });
    fixture(h, 'ZZZ-9', { title: 'Mystery', body: 'who knows' });
    const msg = chat('ZZZ-9', { externalSystem: 'jira', externalKey: 'ZZZ-9' });
    h.server.send('chat.start', msg as never);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 60_000);
    expect(s.calls.map((c) => c.method)).toEqual(['intake.unmapped']);
    expect(done.messageText).toContain('asked you on the desk');
  }, 60_000);

  it('draws one card per fixture card with its dependencies', async () => {
    const s = server();
    h = await startHarness({ rpc: s.rpc });
    fixture(h, 'ABC-5', {
      title: 'Epic',
      project: 'TOY',
      cards: [{ title: 'Backend' }, { title: 'Frontend', dependsOn: [0] }],
    });
    const msg = chat('ABC-5', { externalSystem: 'jira', externalKey: 'ABC-5' });
    h.server.send('chat.start', msg as never);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 60_000);
    expect(s.calls.map((c) => c.method)).toEqual([
      'intake.map',
      'card.create',
      'card.create',
      'card.specify',
      'card.specify',
    ]);
    expect(s.calls[2]?.params.dependencies).toEqual(['TOY-1']);
  }, 60_000);

  it('reads a GitHub issue through gh on the runner (fake gh) and maps it by repository', async () => {
    const s = server();
    const calls: string[][] = [];
    h = await startHarness(
      { rpc: s.rpc },
      {
        external: ExternalAdapters.defaults({
          exec: async (_bin, args) => {
            calls.push(args);
            return {
              exitCode: 0,
              stderr: '',
              stdout: JSON.stringify({
                title: 'Add dark mode',
                body: 'A dark theme, please.',
                state: 'OPEN',
                labels: [],
                comments: [],
              }),
            };
          },
        }),
      },
    );
    const msg = chat('acme/toy#12', { externalSystem: 'github', externalKey: 'acme/toy#12' });
    h.server.send('chat.start', msg as never);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 60_000);
    expect(calls).toEqual([
      ['issue', 'view', '12', '--repo', 'acme/toy', '--json', 'title,body,state,url,labels,comments'],
    ]);
    expect(s.calls.map((c) => c.method)).toEqual(['intake.map', 'card.create', 'card.specify']);
    expect(s.calls[0]?.params).toEqual({ project: 'TOY' });
    expect(s.calls[1]?.params).toMatchObject({ title: 'Add dark mode', externalRef: 'acme/toy#12' });
    expect(done.messageText).toContain('Read GitHub issue acme/toy#12: Add dark mode');
  }, 60_000);

  it("reads the manager's own Jira skill from the work vault into the instructions", async () => {
    const s = server();
    h = await startHarness({ rpc: s.rpc });
    const vaultId = 'work-vault-1';
    mkdirSync(join(h.dataDir, 'vaults', vaultId, 'skills'), { recursive: true });
    writeFileSync(
      join(h.dataDir, 'vaults', vaultId, 'skills', 'jira.md'),
      '# My Jira skill\nUse jira-cli.\n',
    );
    fixture(h, 'ABC-1', { title: 'T', project: 'TOY' });
    const msg = chat('ABC-1', { externalSystem: 'jira', externalKey: 'ABC-1', workVaultId: vaultId });
    h.server.send('chat.start', msg as never);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 60_000);
    const md = readFileSync(join(h.dataDir, 'agents', BA_ID, 'claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('Use jira-cli.');
    expect(md).not.toContain('Skill: read a Jira ticket');
    // without the file the built-in skill is used
    const again = chat('ABC-1', { externalSystem: 'jira', externalKey: 'ABC-1', workVaultId: 'other-vault' });
    h.server.send('chat.start', again as never);
    await h.server.waitFor('chat.done', (d) => d.chatId === again.chatId, 60_000);
    expect(readFileSync(join(h.dataDir, 'agents', BA_ID, 'claude', 'CLAUDE.md'), 'utf8')).toContain(
      'Skill: read a Jira ticket',
    );
  }, 60_000);

  it('does not read Jira without a tool and says so', async () => {
    const s = server();
    h = await startHarness({ rpc: s.rpc });
    const msg = chat('NOPE-1', { externalSystem: 'jira', externalKey: 'NOPE-1' });
    h.server.send('chat.start', msg as never);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 60_000);
    expect(s.calls).toEqual([]);
    expect(done.messageText).toContain('no Jira tool is configured');
  }, 60_000);

  it('after the manager answered the mapping question it carries on from the mapped project and does not repeat cards', async () => {
    const s = server();
    h = await startHarness({ rpc: s.rpc });
    fixture(h, 'ZZZ-9', { title: 'Mystery', body: 'who knows' });
    const first = chat('[Desk] I mapped ZZZ-9 to project TOY. Continue the intake.', {
      externalSystem: 'jira',
      externalKey: 'ZZZ-9',
      mappedProjectKey: 'TOY',
    });
    h.server.send('chat.start', first as never);
    await h.server.waitFor('chat.done', (d) => d.chatId === first.chatId, 60_000);
    expect(s.calls.map((c) => c.method)).toEqual(['card.create', 'card.specify']);
    const again = chat('anything else?', {
      externalSystem: 'jira',
      externalKey: 'ZZZ-9',
      mappedProjectKey: 'TOY',
      cards: [{ ref: 'TOY-1', title: 'Mystery', status: 'queued' }],
    });
    h.server.send('chat.start', again as never);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === again.chatId, 60_000);
    expect(s.calls).toHaveLength(2);
    expect(done.messageText).toContain('Cards of this intake: TOY-1 (queued)');
  }, 60_000);

  it('only the BA verbs are reachable in a chat: a normal chat does not get them', async () => {
    const s = server();
    h = await startHarness({ rpc: s.rpc });
    const msg = { ...chat('hello', {}), context: {} };
    h.server.send('chat.start', msg as never);
    const done = await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId, 60_000);
    expect(done.messageText).toBe('[mock] Ben heard: hello (turn 1)');
    expect(s.calls).toEqual([]);
  }, 60_000);
});

describe('the Claude runtime in an intake chat (no real session is ever started)', () => {
  it('lets only the BA intake use the Jira tool configured on this workstation', async () => {
    const { buildClaudeChatSettings } = await import('../src/adapters/claude-code.ts');
    const { ClaudeRuntimeConfigSchema } = await import('../src/config.ts');
    const cfg = ClaudeRuntimeConfigSchema.parse({
      intake: { mcpConfig: '/home/me/jira-mcp.json', allowedTools: ['mcp__atlassian'] },
    });
    expect(cfg.intake).toEqual({ mcpConfig: '/home/me/jira-mcp.json', allowedTools: ['mcp__atlassian'] });
    expect(buildClaudeChatSettings(false, cfg.intake?.allowedTools).permissions.allow).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash(aom:*)',
      'mcp__atlassian',
    ]);
    // a normal chat keeps the minimal allow list
    expect(buildClaudeChatSettings(false).permissions.allow).toEqual(['Read', 'Glob', 'Grep', 'Bash(aom:*)']);
    expect(ClaudeRuntimeConfigSchema.parse({}).intake).toBeUndefined();
  });
});
