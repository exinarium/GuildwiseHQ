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
        result: { message: `did ${r.method}`, text: r.method === 'session.show' ? 'PANEL' : undefined },
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

describe('aom session (the discovery verbs)', () => {
  it('ask sends the question, its options and whether free text is allowed', async () => {
    const t = await cli();
    expect(
      await t.run(
        'session',
        'ask',
        '--question',
        'Who is it for?',
        '--option',
        'Freelancers',
        '--option',
        'Agencies',
        '--why',
        'It decides scope',
      ),
    ).toBe(0);
    expect(
      await t.run(
        'session',
        'ask',
        '--question',
        'Pick one',
        '--option',
        'A',
        '--no-free-text',
        '--allow-free-text',
      ),
    ).toBe(0);
    expect(t.rpcs).toEqual([
      {
        method: 'session.ask',
        params: {
          question: 'Who is it for?',
          options: ['Freelancers', 'Agencies'],
          allowFreeText: true,
          why: 'It decides scope',
        },
      },
      { method: 'session.ask', params: { question: 'Pick one', options: ['A'], allowFreeText: false } },
    ]);
    expect(await t.run('session', 'ask')).toBe(1);
    expect(t.err.join('')).toMatch(/--question/);
  });

  it('answer needs an option or a text; the CEO sends its reason', async () => {
    const t = await cli();
    expect(await t.run('session', 'answer', '--option', 'o2', '--why', 'smallest market')).toBe(0);
    expect(await t.run('session', 'answer', '--text', 'Paid, 10 euro')).toBe(0);
    expect(await t.run('session', 'answer')).toBe(1);
    expect(t.rpcs).toEqual([
      { method: 'session.answer', params: { option: 'o2', why: 'smallest market' } },
      { method: 'session.answer', params: { text: 'Paid, 10 euro' } },
    ]);
  });

  it('note add, update and remove', async () => {
    const t = await cli({ 'n.txt': 'from a file' });
    expect(await t.run('session', 'note', 'add', '--section', 'ideas', '--text', 'Recurring invoices')).toBe(
      0,
    );
    expect(await t.run('session', 'note', 'add', '--section', 'parked', '--text-file', 'n.txt')).toBe(0);
    expect(
      await t.run('session', 'note', 'update', 'abcd1234', '--text', 'New', '--section', 'decisions'),
    ).toBe(0);
    expect(await t.run('session', 'note', 'remove', 'abcd1234')).toBe(0);
    expect(await t.run('session', 'note', 'update', 'abcd1234')).toBe(1);
    expect(await t.run('session', 'note', 'add', '--text', 'no section')).toBe(1);
    expect(await t.run('session', 'note', 'remove')).toBe(1);
    expect(t.rpcs).toEqual([
      { method: 'session.note', params: { op: 'add', section: 'ideas', text: 'Recurring invoices' } },
      { method: 'session.note', params: { op: 'add', section: 'parked', text: 'from a file' } },
      { method: 'session.note', params: { op: 'update', id: 'abcd1234', text: 'New', section: 'decisions' } },
      { method: 'session.note', params: { op: 'remove', id: 'abcd1234' } },
    ]);
  });

  it('propose, phase, draft, validate and show', async () => {
    const t = await cli({ 'prd.md': '# PRD\n\ntext' });
    const doc = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
    expect(
      await t.run(
        'session',
        'propose',
        '--title',
        'Sharper goals',
        '--change',
        'Cut time in half',
        '--rationale',
        'Measurable',
        '--doc',
        doc,
        '--section',
        'Goals',
      ),
    ).toBe(0);
    expect(await t.run('session', 'propose', '--title', 'x', '--change', 'y')).toBe(1);
    expect(await t.run('session', 'phase', '--to', 'converge', '--reason', 'done')).toBe(0);
    expect(await t.run('session', 'phase')).toBe(1);
    expect(
      await t.run(
        'session',
        'draft',
        '--kind',
        'prd',
        '--content',
        '# PRD',
        '--title',
        'My PRD',
        '--note',
        'v1',
      ),
    ).toBe(0);
    expect(await t.run('session', 'draft', '--kind', 'brief', '--file', 'prd.md')).toBe(0);
    expect(await t.run('session', 'draft', '--kind', 'minutes', '--content', 'x')).toBe(1);
    expect(await t.run('session', 'draft', '--kind', 'prd')).toBe(1);
    expect(
      await t.run(
        'session',
        'validate',
        '--summary',
        'ok',
        '--check',
        'Goal has a measure|fail|no target',
        '--check',
        'Non-goals|pass|',
      ),
    ).toBe(0);
    expect(await t.run('session', 'validate')).toBe(1);
    expect(await t.run('session', 'show')).toBe(0);
    expect(t.out.join('')).toContain('PANEL');
    expect(t.rpcs.map((r) => r.method)).toEqual([
      'session.propose',
      'session.phase',
      'session.draft',
      'session.draft',
      'session.validate',
      'session.show',
    ]);
    expect(t.rpcs[0]?.params).toEqual({
      title: 'Sharper goals',
      change: 'Cut time in half',
      rationale: 'Measurable',
      doc,
      section: 'Goals',
    });
    expect(t.rpcs[2]?.params).toEqual({ kind: 'prd', content: '# PRD', title: 'My PRD', note: 'v1' });
    expect(t.rpcs[3]?.params).toEqual({ kind: 'brief', content: '# PRD\n\ntext' });
    expect(t.rpcs[4]?.params).toEqual({
      summary: 'ok',
      items: ['Goal has a measure|fail|no target', 'Non-goals|pass|'],
    });
    expect(await t.run('session', 'bogus')).toBe(1);
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
const THREAD_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
const discoveryTurn = (header: Record<string, unknown>, text = 'Starting idea: Invoices for freelancers') => {
  const turnId = uuidv7();
  return {
    chatId: turnId,
    threadId: THREAD_ID,
    agent: {
      agentId: PERSONA_HOST_AGENT_ID,
      name: 'Analyst',
      roleKey: 'persona',
      seniority: 'senior',
      runtime: 'mock',
      model: 'mock',
      skills: [],
      permissions: readOnly,
      isDevops: false,
    },
    message: `<!--discovery:${JSON.stringify(header)}-->\n${text}`,
    context: { orgId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a9' },
    session: {
      turnId,
      kind: 'discovery',
      speaker: { kind: 'persona', name: 'Analyst', personaKey: 'analyst', seat: 'Facilitator' },
      instructions: 'Facilitate.',
      roster: [],
    },
  };
};

describe('session turns on the runner: the verbs reach the server, nothing else does', () => {
  it('announces session-verbs:1 and forwards session.* and ledger.search only', async () => {
    const rpcs: Array<{ method: string; shiftId: string }> = [];
    h = await startHarness({
      rpc: (m) => {
        rpcs.push({ method: m.method, shiftId: m.shiftId });
        return { ok: true, result: { message: 'ok', questionId: 'q1' } };
      },
    });
    expect(h.server.of('hello')[0]?.capabilities).toContain('session-verbs:1');
    const msg = discoveryTurn({ role: 'facilitator', trigger: 'start', phase: 'frame', asked: 0 });
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    const methods = rpcs.filter((r) => r.shiftId === msg.chatId).map((r) => r.method);
    expect(methods).toEqual(['session.note', 'session.ask']);
    const ask = h.server.of('rpc.request').find((r) => r.method === 'session.ask');
    expect(ask?.params).toMatchObject({
      question: 'Who is the primary user?',
      options: ['Freelancers', 'Small agencies', 'Finance teams'],
    });
    expect(h.server.invalid).toEqual([]);
  });

  it('the mock CEO proposes the first option and never asks', async () => {
    const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
    h = await startHarness({
      rpc: (m) => {
        rpcs.push({ method: m.method, params: m.params });
        return { ok: true, result: { message: 'ok' } };
      },
    });
    const msg = discoveryTurn({ role: 'ceo_answer', questionId: 'q', options: ['o1', 'o2'], mode: 'joint' });
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(rpcs.map((r) => r.method)).toEqual(['session.answer']);
    expect(rpcs[0]?.params).toMatchObject({ option: 'o1' });
  });

  it('the mock facilitator walks the phases, proposes once and drafts the PRD at the end', async () => {
    const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
    h = await startHarness({
      rpc: (m) => {
        rpcs.push({ method: m.method, params: m.params });
        return {
          ok: true,
          result: { text: '### Decisions\n- [abc12345] Send in a minute (Analyst)\n', message: 'ok' },
        };
      },
    });
    const run = async (header: Record<string, unknown>, text: string) => {
      rpcs.length = 0;
      const msg = discoveryTurn(header, text);
      h?.server.send('chat.start', msg);
      await h?.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
      return rpcs.map((r) => r.method);
    };
    expect(
      await run(
        { role: 'facilitator', trigger: 'answer', phase: 'frame', asked: 3, openProposals: 0 },
        '- [frame] Q -> Fewer late payments',
      ),
    ).toEqual(['session.note', 'session.propose', 'session.phase', 'session.ask']);
    expect(
      await run(
        { role: 'facilitator', trigger: 'answer', phase: 'stress_test', asked: 6, hasPrd: false },
        '- [x] Q -> No, write it down',
      ),
    ).toEqual(['session.phase', 'session.show', 'session.draft']);
    const draft = rpcs.find((r) => r.method === 'session.draft');
    expect(draft?.params).toMatchObject({ kind: 'prd' });
    expect(String(draft?.params.content)).toContain('| R1 |');
    expect(
      await run(
        { role: 'facilitator', trigger: 'validate', phase: 'capture', asked: 6 },
        '- [ ] Each goal has a measure\n- [ ] Non-goals are listed',
      ),
    ).toEqual(['session.validate']);
    expect(
      await run(
        { role: 'facilitator', trigger: 'message', phase: 'frame', asked: 1, openQuestion: true },
        'x',
      ),
    ).toEqual([]);
  });
});
