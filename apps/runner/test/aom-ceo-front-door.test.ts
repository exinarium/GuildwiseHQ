import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcRpcRequest } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { readGuardState } from '../src/ceo/guard-hook.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ceoChatStart, FakeChatAdapter } from './owner-helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
let h: Harness | undefined;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  await h?.stop();
  h = undefined;
});

async function cli(
  files: Record<string, string> = {},
  answer: (req: IpcRpcRequest) => unknown = () => ({ status: 'executed', message: 'Done.' }),
  extra: Partial<AomContext> = {},
) {
  const calls: IpcRpcRequest[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'Recorded.' }) as never,
    rpc: async (req) => {
      calls.push(req);
      return { ok: true, result: answer(req) };
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
      if (f === undefined) throw new Error(`no such file ${p}`);
      return f;
    },
    ...extra,
  };
  return { run: (...a: string[]) => runAom(a, ctx), calls, out, err };
}

describe('aom ceo (front door verbs)', () => {
  it('correction record sends the owner words, the rule and the remedy', async () => {
    const t = await cli();
    expect(
      await t.run(
        'ceo',
        'correction',
        'record',
        '--action',
        '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        '--text',
        'no, assign it to Bob',
        '--rule',
        'reviews go to Bob',
        '--undo',
      ),
    ).toBe(0);
    expect(t.calls[0]?.params).toEqual({
      op: 'correction',
      action: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      text: 'no, assign it to Bob',
      rule: 'reviews go to Bob',
      remedy: 'undo',
    });
    expect(await t.run('ceo', 'correction', 'record', '--text', 'x')).toBe(1); // the rule is required
  });

  it('job start, log and repeats', async () => {
    const t = await cli();
    await t.run('ceo', 'job', 'start', '--kind', 'direct-edit', '--why', 'he said so');
    await t.run(
      'ceo',
      'job',
      'log',
      '--kind',
      'install-tool',
      '--title',
      'Install pwsh',
      '--summary',
      'done',
      '--project',
      'P4',
      '--command',
      'pwsh -c x',
    );
    await t.run('ceo', 'job', 'repeats');
    expect(t.calls.map((c) => c.params)).toEqual([
      { op: 'job', sub: 'start', kind: 'direct-edit', why: 'he said so' },
      {
        op: 'job',
        sub: 'log',
        kind: 'install-tool',
        title: 'Install pwsh',
        summary: 'done',
        project: 'P4',
        command: 'pwsh -c x',
      },
      { op: 'job', sub: 'repeats' },
    ]);
    expect(await t.run('ceo', 'job', 'log', '--kind', 'x')).toBe(1);
  });

  it('order invoke, decline and done', async () => {
    const t = await cli({ 'cmds.json': JSON.stringify(['ls', 'git status']) });
    await t.run('ceo', 'order', 'invoke', 'e1', '--wake', 'w1', '--why', 'fits', '--confidence', '0.9');
    await t.run('ceo', 'order', 'decline', '--ask', 'unsure?');
    await t.run('ceo', 'order', 'done', '--summary', 'did it', '--commands-file', 'cmds.json');
    expect(t.calls.map((c) => c.params)).toEqual([
      { op: 'order', sub: 'invoke', entryId: 'e1', wake: 'w1', why: 'fits', confidence: 0.9 },
      { op: 'order', sub: 'decline', ask: 'unsure?' },
      { op: 'order', sub: 'done', summary: 'did it', commands: ['ls', 'git status'] },
    ]);
    expect(await t.run('ceo', 'order', 'invoke', 'e1')).toBe(1);
  });

  it('dir add and draft-cards', async () => {
    const t = await cli({ 'cards.json': JSON.stringify([{ title: 'A' }, { title: 'B' }]) });
    await t.run('ceo', 'dir', 'add', '/srv/foo');
    await t.run('ceo', 'draft-cards', '--project', 'P4', '--file', 'cards.json');
    expect(t.calls[0]?.params).toEqual({ op: 'dir', sub: 'add', path: '/srv/foo' });
    expect(t.calls[1]?.params).toMatchObject({
      op: 'act',
      action: 'draft-cards',
      params: { project: 'P4', cards: [{ title: 'A' }, { title: 'B' }] },
    });
    expect(await t.run('ceo', 'draft-cards', '--project', 'P4')).toBe(1);
  });

  it('devops files the request by project, env or workstation without waiting', async () => {
    const t = await cli({}, () => ({ status: 'executed', message: 'sent', result: { requestId: 'r1' } }));
    expect(await t.run('ceo', 'devops', '--project', 'P5', '--text', 'install pwsh 7.4')).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.params).toMatchObject({
      op: 'act',
      action: 'devops',
      params: { project: 'P5', text: 'install pwsh 7.4' },
      confidence: 0.9,
    });
    await t.run(
      'ceo',
      'devops',
      '--env',
      'uat',
      '--text',
      'fix docker',
      '--reason',
      'owner asked',
      '--confidence',
      '0.8',
    );
    expect(t.calls[1]?.params).toMatchObject({
      params: { env: 'uat' },
      reason: 'owner asked',
      confidence: 0.8,
    });
  });

  it('devops --wait polls every 10 s, prints progress and returns the DevOps summary', async () => {
    let n = 0;
    let clock = 0;
    const t = await cli(
      {},
      (req) => {
        const p = req.params as { op: string };
        if (p.op === 'act') return { status: 'executed', message: 'sent', result: { requestId: 'r1' } };
        n++;
        return n < 3
          ? { status: 'running', progress: n === 1 ? ['cloning'] : ['cloning', 'installing'] }
          : {
              status: 'done',
              summary: 'pwsh 7.4 installed',
              progress: ['cloning', 'installing', 'verified'],
            };
      },
      {
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(await t.run('ceo', 'devops', '--project', 'P5', '--text', 'install pwsh', '--wait', '600')).toBe(
      0,
    );
    const out = t.out.join('');
    expect(out).toContain('DevOps: cloning');
    expect(out).toContain('DevOps: installing');
    expect(out).toContain('DevOps is done: pwsh 7.4 installed');
    expect(clock).toBe(20_000);
  });

  it('devops --wait gives up after the timeout: still running, it will follow up', async () => {
    let clock = 0;
    const t = await cli(
      {},
      (req) =>
        (req.params as { op: string }).op === 'act'
          ? { status: 'executed', message: 'sent', result: { requestId: 'r9' } }
          : { status: 'running' },
      {
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(await t.run('ceo', 'devops', '--project', 'P5', '--text', 'long job', '--wait', '30')).toBe(0);
    expect(t.out.join('')).toContain("still running: request r9; I'll follow up");
  });

  it('aom runner restart asks the runner (rpc runner.restart)', async () => {
    const t = await cli({}, () => ({ message: 'Restart scheduled after this reply.' }));
    expect(await t.run('runner', 'restart', '--reason', 'new tools')).toBe(0);
    expect(t.calls[0]).toEqual({ method: 'runner.restart', params: { reason: 'new tools' } });
    expect(t.out.join('')).toContain('Restart scheduled');
    expect(await t.run('runner', 'bogus')).toBe(1);
  });
});

describe('the owner turn handler', () => {
  async function turn(script: (env: Record<string, string>) => Promise<void>) {
    h = await startHarness();
    const adapter = new FakeChatAdapter();
    const orig = adapter.startOwnerTurn.bind(adapter);
    adapter.startOwnerTurn = async (input) => {
      await script(input.env);
      return orig(input);
    };
    h.runner.chat.deps.adapters.set('mock', adapter);
    (h.runner as unknown as { opts: { config: { ceo: { fullPower: boolean } } } }).opts.config.ceo = {
      fullPower: true,
    };
    return adapter;
  }
  const post = (env: Record<string, string>, method: string, params: Record<string, unknown>) =>
    fetch(`${env.AOM_IPC_URL}/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AOM_SHIFT_TOKEN}` },
      body: JSON.stringify({ method, params }),
    }).then((r) => r.json() as Promise<{ ok: boolean; result?: unknown; error?: string }>);

  it('`job start` opens the guard hook locally; `runner restart` schedules the restart after the reply is acknowledged', async () => {
    const results: Record<string, unknown> = {};
    const adapter = await turn(async (env) => {
      const dir = env.AOM_CEO_TURN_DIR as string;
      results.before = readGuardState(dir).jobStarted;
      await post(env, 'ceo', { op: 'job', sub: 'start', kind: 'direct-edit' });
      results.after = readGuardState(dir).jobStarted;
      results.restart = await post(env, 'runner.restart', { reason: 'tools installed' });
      results.guardConfig = readFileSync(join(dir, 'guard.json'), 'utf8');
    });
    const m = ceoChatStart('install it', { ceoMode: 'owner' });
    h!.server.send('chat.start', m);
    await h!.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(adapter.ownerTurns).toHaveLength(1);
    expect(results.before).toBe(false);
    expect(results.after).toBe(true);
    expect((results.restart as { ok: boolean }).ok).toBe(true);
    expect(h!.runner.restartAfterReply.requested?.reason).toBe('tools installed');
    expect(JSON.parse(results.guardConfig as string)).toHaveProperty('clones');
  });

  it('`runner restart` is refused in a plain chat', async () => {
    h = await startHarness();
    const adapter = new FakeChatAdapter();
    const seen: { r?: { ok: boolean; error?: string } } = {};
    const orig = adapter.startChat.bind(adapter);
    adapter.startChat = async (input) => {
      seen.r = await post(input.env, 'runner.restart', {});
      return orig(input);
    };
    h.runner.chat.deps.adapters.set('mock', adapter);
    const m = ceoChatStart('hi', {});
    h.server.send('chat.start', m);
    await h.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(seen.r?.ok).toBe(false);
    expect(seen.r?.error).toMatch(/owner/);
  });
});
