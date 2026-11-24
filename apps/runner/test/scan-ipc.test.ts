import { afterEach, describe, expect, it } from 'vitest';
import { SCAN_RPC_ALLOWED } from '../src/devops/requests.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

/**
 * runner-authority-fixes T3 (AC5): a "Scan with DevOps" shift reaches only its read-only runner verbs at the supervisor
 * IPC, whatever its shell managed to run. A plain DevOps request keeps every verb.
 */

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function rpcInShift(
  devops: Record<string, unknown>,
  methods: Array<[string, Record<string, unknown>]>,
) {
  const repo = makeRepo();
  const seen: Record<string, { ok: boolean; error?: string }> = {};
  const adapter = new ScriptedAdapter(async (_i, ctl) => {
    for (const [method, params] of methods) {
      const r = await ctl.post('/v1/rpc', { method, params });
      seen[method] = r.json as { ok: boolean; error?: string };
    }
  });
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]) }, repo);
  const base = makeDevopsStart({ summary: 'scan the repositories' }) as Record<string, any>;
  const msg: Record<string, any> = { ...base, devops: { ...base.devops, ...devops } };
  h.server.send('shift.start', msg);
  await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
  await h.runner.supervisor.whenSettled(msg.shiftId);
  return { seen, repo };
}

describe('AC5: a scan shift is limited to its read-only verbs at the supervisor', () => {
  it('the allowed set is exactly the guard-allowed aom verbs plus the audit', () => {
    expect([...SCAN_RPC_ALLOWED].sort()).toEqual([
      'deploy.probe',
      'deploy.status',
      'devops.audit',
      'setup.propose',
    ]);
  });

  it.each(['run_scan', 'deploy_scan'])(
    'scanKind %s: toolchain.add, git.push and hygiene.run are refused',
    async (scanKind) => {
      const { seen, repo } = await rpcInShift({ scanKind }, [
        ['toolchain.add', { name: 'x', dir: '/tmp' }],
        ['git.push', { repo: '/tmp', refspecs: ['main'] }],
        ['hygiene.run', {}],
        ['setup.propose', { proposal: {} }],
      ]);
      for (const m of ['toolchain.add', 'git.push', 'hygiene.run']) {
        expect(seen[m]?.ok, m).toBe(false);
        expect(seen[m]?.error, m).toMatch(/not available in a read-only scan/);
      }
      // setup.propose reaches its own handler (it may still refuse the empty proposal there, but not as a scan refusal)
      expect(seen['setup.propose']?.error ?? '').not.toMatch(/read-only scan/);
      expect(repo).toBeTruthy();
    },
  );

  it('a plain DevOps request (no scan) still reaches toolchain.add', async () => {
    const { seen } = await rpcInShift({}, [['toolchain.add', { name: 'x', dir: '/nonexistent-dir' }]]);
    expect(seen['toolchain.add']?.error ?? '').not.toMatch(/read-only scan/);
  });
});
