import type { IpcRpcRequest, ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(answer: unknown) {
  const calls: IpcRpcRequest[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r: { report: ShiftReport }) => ({ accepted: true, message: 'Recorded.', r }) as never,
    rpc: async (req) => {
      calls.push(req);
      return { ok: true, result: answer };
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: () => {
      throw new Error('no files');
    },
  };
  return { run: (...a: string[]) => runAom(a, ctx), calls, out, err };
}

const why = ['--reason', 'the workstation is gone', '--confidence', '0.8'];
const BULK = [
  'Moved 2 of 3 agent(s) from old-box to Laptop.',
  'moved: Ada, Bo',
  'blocked: Cy: In a running shift: Cy is in a running shift: wait until it ends',
].join('\n');

describe('aom ceo act move-workstation / move-agents-off', () => {
  it('sends --agent and --to as parameters of the single move', async () => {
    const t = await cli({ status: 'executed', message: 'Ada moved to Laptop.' });
    const code = await t.run('ceo', 'act', 'move-workstation', '--agent', 'Ada', '--to', 'Laptop', ...why);
    expect(code).toBe(0);
    expect((t.calls[0]!.params as any).action).toBe('move-workstation');
    expect((t.calls[0]!.params as any).params).toEqual({ agent: 'Ada', to: 'Laptop' });
    expect(t.out.join('')).toContain('executed: Ada moved to Laptop.');
  });

  it('keeps --agent-id and --target-workstation-id working', async () => {
    const t = await cli({ status: 'executed', message: 'ok' });
    await t.run(
      'ceo',
      'act',
      'move-workstation',
      '--agent-id',
      'Ada',
      '--target-workstation-id',
      'L',
      ...why,
    );
    expect((t.calls[0]!.params as any).params).toEqual({ agentId: 'Ada', targetWorkstationId: 'L' });
  });

  it('sends --from and --to for the bulk move and prints the per-agent lines', async () => {
    const t = await cli({ status: 'executed', message: BULK });
    const code = await t.run('ceo', 'act', 'move-agents-off', '--from', 'old-box', '--to', 'Laptop', ...why);
    expect(code).toBe(0);
    expect((t.calls[0]!.params as any).params).toEqual({ from: 'old-box', to: 'Laptop' });
    const text = t.out.join('');
    expect(text).toContain('executed: Moved 2 of 3 agent(s) from old-box to Laptop.');
    expect(text).toContain('moved: Ada, Bo');
    expect(text).toContain('blocked: Cy: In a running shift');
  });

  it('prints a refusal with its reason and exits 1', async () => {
    const t = await cli({ status: 'refused', message: 'old-box is online: move its agents one by one' });
    const code = await t.run('ceo', 'act', 'move-agents-off', '--from', 'old-box', '--to', 'Laptop', ...why);
    expect(code).toBe(1);
    expect(t.out.join('') + t.err.join('')).toContain('refused: old-box is online');
  });

  it('prints the full result with --json', async () => {
    const result = {
      status: 'executed',
      message: BULK,
      result: { moved: [{ name: 'Ada' }], blocked: [{ name: 'Cy' }] },
    };
    const t = await cli(result);
    await t.run('ceo', 'act', 'move-agents-off', '--from', 'a', '--to', 'b', ...why, '--json');
    const printed = JSON.parse(t.out.join(''));
    expect(printed.result.moved[0].name).toBe('Ada');
    expect(printed.result.blocked[0].name).toBe('Cy');
  });

  it('refuses a call without a reason before sending anything', async () => {
    const t = await cli({ status: 'executed', message: 'ok' });
    const code = await t.run('ceo', 'act', 'move-agents-off', '--from', 'a', '--to', 'b');
    expect(code).toBe(1);
    expect(t.calls).toHaveLength(0);
  });
});
