import { chatToolsFor } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { playbookNote } from '../src/playbooks/note.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(answer: { ok: boolean; result?: unknown; error?: string }) {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'ok' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return answer;
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
  return { run: (...a: string[]) => runAom(a, ctx), rpcs, out, err };
}

describe('aom playbook run', () => {
  it('sends the key and the input and prints what the server says', async () => {
    const t = await cli({ ok: true, result: { message: 'Started the guided session.' } });
    expect(await t.run('playbook', 'run', 'sample:create-epics-and-stories', '--input', 'billing PRD')).toBe(
      0,
    );
    expect(t.rpcs).toEqual([
      { method: 'playbook.run', params: { key: 'sample:create-epics-and-stories', input: 'billing PRD' } },
    ]);
    expect(t.out.join('')).toContain('Started the guided session.');
    expect(await t.run('playbook', 'run', 'prd')).toBe(0);
    expect(t.rpcs[1]).toEqual({ method: 'playbook.run', params: { key: 'prd' } });
  });

  it('needs a key and the run word', async () => {
    const t = await cli({ ok: true, result: {} });
    expect(await t.run('playbook', 'run')).toBe(1);
    expect(await t.run('playbook', 'list')).toBe(1);
    expect(await t.run('playbook')).toBe(1);
    expect(t.rpcs).toEqual([]);
    expect(t.err.join('')).toContain('usage: aom playbook run');
  });

  it('shows the refusal of the server (no grant) and fails', async () => {
    const t = await cli({ ok: false, error: 'nobody granted this agent that playbook' });
    expect(await t.run('playbook', 'run', 'prd')).toBe(1);
    expect(t.err.join('')).toContain('nobody granted this agent that playbook');
  });
});

describe('aom session step', () => {
  it('sends the step with an optional title and total', async () => {
    const t = await cli({ ok: true, result: { message: 'Step 2 of 5: Run' } });
    expect(await t.run('session', 'step', '2', '--title', 'Run', '--total', '5')).toBe(0);
    expect(await t.run('session', 'step', '3')).toBe(0);
    expect(await t.run('session', 'step', 'x')).toBe(1);
    expect(await t.run('session', 'step', '0')).toBe(1);
    expect(t.rpcs).toEqual([
      { method: 'session.step', params: { step: 2, title: 'Run', total: 5 } },
      { method: 'session.step', params: { step: 3 } },
    ]);
  });
});

describe('what an agent is told', () => {
  it('says nothing without a grant, and names the granted playbooks with one', () => {
    expect(playbookNote(undefined)).toBe('');
    expect(playbookNote([])).toBe('');
    const n = playbookNote(['prd', 'sample:create-epics-and-stories']);
    expect(n).toContain('`prd`');
    expect(n).toContain('`sample:create-epics-and-stories`');
    expect(n).toContain('aom playbook run');
    expect(n).toContain('do not wait');
  });
  it('the direct-model tool exists only with a grant', () => {
    expect(chatToolsFor().map((t) => t.name)).not.toContain('playbook_run');
    expect(chatToolsFor({ playbook: true }).map((t) => t.name)).toContain('playbook_run');
  });
});
