import { PERSONA_HOST_AGENT_ID, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
let h: Harness | undefined;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  await h?.stop();
  h = undefined;
});

async function cli(files: Record<string, string> = {}) {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'ok' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return {
        ok: true,
        result: { message: `did ${r.method}`, text: r.method === 'board.show' ? 'BOARD' : undefined },
      };
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
  };
  return { run: (...a: string[]) => runAom(a, ctx), rpcs, out, err };
}

describe('aom board (the boardroom verbs)', () => {
  it('add sends the column and the text', async () => {
    const t = await cli({ 't.txt': 'from a file' });
    expect(await t.run('board', 'add', '--column', 'risks', '--text', 'Adoption is assumed')).toBe(0);
    expect(await t.run('board', 'add', '--column', 'ideas', '--text-file', 't.txt')).toBe(0);
    expect(await t.run('board', 'add', '--text', 'no column')).toBe(1);
    expect(await t.run('board', 'add', '--column', 'ideas')).toBe(1);
    expect(t.rpcs).toEqual([
      { method: 'board.add', params: { column: 'risks', text: 'Adoption is assumed' } },
      { method: 'board.add', params: { column: 'ideas', text: 'from a file' } },
    ]);
  });

  it('next sends the speakers in order with the reason and the instruction', async () => {
    const t = await cli();
    expect(
      await t.run(
        'board',
        'next',
        '--speaker',
        'cost-hawk',
        '--speaker',
        'devils-advocate',
        '--reason',
        'They disagree',
        '--instruction',
        'Name the gap',
      ),
    ).toBe(0);
    expect(await t.run('board', 'next', '--reason', 'no speaker')).toBe(1);
    expect(await t.run('board', 'next', '--speaker', 'cost-hawk')).toBe(1);
    expect(t.rpcs).toEqual([
      {
        method: 'board.next',
        params: {
          speakers: ['cost-hawk', 'devils-advocate'],
          reason: 'They disagree',
          instruction: 'Name the gap',
        },
      },
    ]);
  });

  it('pause, converge, disagreement add, cast, minutes and show', async () => {
    const t = await cli({ 'm.md': '## Positions\n\n- x' });
    expect(await t.run('board', 'pause', '--question', 'Which way?', '--option', 'A', '--option', 'B')).toBe(
      0,
    );
    expect(await t.run('board', 'pause')).toBe(1);
    expect(await t.run('board', 'converge', '--note', 'all want a pilot')).toBe(0);
    expect(await t.run('board', 'converge')).toBe(1);
    expect(
      await t.run(
        'board',
        'disagreement',
        'add',
        '--topic',
        'Pilot now?',
        '--position',
        'Cost Hawk|later',
        '--position',
        'User Advocate|now',
      ),
    ).toBe(0);
    expect(await t.run('board', 'disagreement', 'add', '--topic', 'x', '--position', 'one|only')).toBe(1);
    expect(await t.run('board', 'disagreement', 'remove')).toBe(1);
    expect(await t.run('board', 'cast', '--persona', 'security', '--why', 'risk')).toBe(0);
    expect(
      await t.run(
        'board',
        'cast',
        '--name',
        'Regulator',
        '--brief',
        'A cautious officer',
        '--seat',
        'Compliance',
      ),
    ).toBe(0);
    expect(await t.run('board', 'cast', '--name', 'No brief')).toBe(1);
    expect(await t.run('board', 'score', '--option', 'Alpha', '--score', '4', '--why', 'cheap')).toBe(0);
    expect(await t.run('board', 'score', '--option', 'Alpha')).toBe(1);
    expect(await t.run('board', 'score', '--score', '3')).toBe(1);
    expect(await t.run('board', 'minutes', '--content-file', 'm.md')).toBe(0);
    expect(await t.run('board', 'minutes')).toBe(1);
    expect(await t.run('board', 'show')).toBe(0);
    expect(t.out.join('')).toContain('BOARD');
    expect(t.rpcs.map((r) => r.method)).toEqual([
      'board.pause',
      'board.converge',
      'board.disagreement',
      'board.cast',
      'board.cast',
      'board.score',
      'board.minutes',
      'board.show',
    ]);
    expect(t.rpcs[0]?.params).toEqual({ question: 'Which way?', options: ['A', 'B'] });
    expect(t.rpcs[2]?.params).toEqual({
      topic: 'Pilot now?',
      positions: ['Cost Hawk|later', 'User Advocate|now'],
    });
    expect(t.rpcs[3]?.params).toEqual({ persona: 'security', why: 'risk' });
    expect(t.rpcs.find((x) => x.method === 'board.score')?.params).toEqual({
      option: 'Alpha',
      score: 4,
      why: 'cheap',
    });
    expect(t.rpcs[4]?.params).toEqual({
      name: 'Regulator',
      brief: 'A cautious officer',
      seat: 'Compliance',
      why: '',
    });
    expect(t.rpcs[6]?.params).toEqual({ content: '## Positions\n\n- x' });
    expect(await t.run('board', 'bogus')).toBe(1);
  });
});

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
const THREAD_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789c2';
const boardTurn = (header: Record<string, unknown>, text = 'Topic: Should we launch a pilot?') => {
  const turnId = uuidv7();
  return {
    chatId: turnId,
    threadId: THREAD_ID,
    agent: {
      agentId: PERSONA_HOST_AGENT_ID,
      name: 'Cost Hawk',
      roleKey: 'persona',
      seniority: 'senior',
      runtime: 'mock',
      model: 'mock',
      skills: [],
      permissions: readOnly,
      isDevops: false,
    },
    message: `<!--board:${JSON.stringify(header)}-->\n${text}`,
    context: { orgId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a9' },
    session: {
      turnId,
      kind: 'boardroom',
      speaker: { kind: 'persona', name: 'Cost Hawk', personaKey: 'cost-hawk', seat: 'Panelist' },
      instructions: 'Speak.',
      roster: [],
    },
  };
};

describe('boardroom turns on the runner: the board verbs reach the server, nothing else does', () => {
  it('announces board-verbs:1 and forwards board.* and ledger.search only', async () => {
    const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
    h = await startHarness({
      rpc: (m) => {
        rpcs.push({ method: m.method, params: m.params });
        return { ok: true, result: { message: 'ok' } };
      },
    });
    expect(h.server.of('hello')[0]?.capabilities).toContain('board-verbs:1');
    const run = async (header: Record<string, unknown>, text?: string) => {
      rpcs.length = 0;
      const msg = boardTurn(header, text);
      h?.server.send('chat.start', msg);
      await h?.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
      return rpcs.map((r) => r.method);
    };
    // a speaker answers in voice and puts one note on the board
    expect(
      await run({ role: 'speaker', slug: 'cost-hawk', kind: 'independent', format: 'open', index: 0 }),
    ).toEqual(['board.add']);
    expect(rpcs[0]?.params).toMatchObject({ column: 'risks' });
    // the devil's advocate records a disagreement in a discussion round
    expect(
      await run({ role: 'speaker', slug: 'devils-advocate', kind: 'discussion', format: 'open', index: 1 }),
    ).toEqual(['board.add', 'board.disagreement']);
    // the Chair never opens with the last speaker and names the owner's mention first
    expect(
      await run({
        role: 'chair',
        round: 1,
        people: [
          { slug: 'cost-hawk', name: 'Cost Hawk', spoken: 1 },
          { slug: 'user-advocate', name: 'User Advocate', spoken: 1 },
          { slug: 'security', name: 'Security', spoken: 0 },
        ],
        mentions: ['cost-hawk'],
        lastSpeaker: 'cost-hawk',
      }),
    ).toEqual(['board.next']);
    expect(((rpcs[0]?.params.speakers ?? []) as string[])[0]).toBe('cost-hawk');
    // a topic that asks for a decision pauses; a flagged convergence converges first
    expect(
      await run(
        { role: 'chair', round: 1, people: [{ slug: 'a', name: 'A', spoken: 0 }], mentions: [] },
        '[[decide]]',
      ),
    ).toEqual(['board.pause']);
    expect(
      await run(
        { role: 'chair', round: 1, people: [{ slug: 'a', name: 'A', spoken: 0 }], mentions: [] },
        '[[converge]]',
      ),
    ).toEqual(['board.converge', 'board.next']);
    expect(await run({ role: 'cast', personas: ['devils-advocate', 'user-advocate', 'cost-hawk'] })).toEqual([
      'board.cast',
      'board.cast',
      'board.cast',
      'board.cast',
    ]);
    expect(await run({ role: 'minutes', people: ['Cost Hawk', 'User Advocate'] })).toEqual(['board.minutes']);
    const min = h.server
      .of('rpc.request')
      .filter((r) => r.method === 'board.minutes')
      .at(-1);
    expect(String(min?.params.content)).toContain('## Positions');
    expect(String(min?.params.content)).toContain('## Open questions');
    expect(h.server.invalid).toEqual([]);
  });

  it('a session verb is not available in a boardroom turn on the runner side either', async () => {
    const rpcs: string[] = [];
    h = await startHarness({
      rpc: (m) => {
        rpcs.push(m.method);
        return { ok: true, result: {} };
      },
    });
    const msg = boardTurn({
      role: 'speaker',
      slug: 'cost-hawk',
      kind: 'independent',
      format: 'open',
      index: 0,
    });
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(rpcs.every((m) => m.startsWith('board.') || m === 'ledger.search')).toBe(true);
  });
});
