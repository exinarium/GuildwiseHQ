import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { type AgentPermissions, indexCapabilityTree } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { CapabilityRegistry } from '../src/capabilities/registry.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { DelegateRunner } from '../src/delegate/delegate.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { runnerPaths } from '../src/paths.ts';
import { fakeApi, fakeServers } from './fake-claude-api.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();

/**
 * A child that works, with the REAL Claude Code binary, its real OS sandbox (bubblewrap) and the permissions the delegate runner
 * derives: the child runs in the worktree of its parent, writes a file there and cannot write outside it, and a parent that may
 * not run commands gets a child that cannot. A local fake Anthropic API plays the model (it asks for one Bash call): no tokens are
 * spent. Skipped without `claude` and a working bubblewrap.
 */
const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(userInfo().homedir, '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;
const enabled = CLAUDE !== undefined && bwrapOk;

const HOME_BASE = join(userInfo().homedir, '.aom-real-delegate-test');
afterAll(() => {
  rmSync(HOME_BASE, { recursive: true, force: true });
  for (const s of fakeServers) s.close();
});

const SHELL: AgentPermissions = {
  allowedTools: ['read', 'edit', 'shell'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: true,
  browser: false,
  riskTiers: ['small', 'large'],
  readOrgRepos: false,
  repoIds: null,
};

describe.skipIf(!enabled)(
  'a working delegate with real Claude Code and its sandbox (skipped without claude + bwrap)',
  () => {
    it('writes in the worktree of its parent, not outside it, and cannot when the parent may only read', async () => {
      mkdirSync(HOME_BASE, { recursive: true });
      const root = realpathSync(mkdtempSync(join(HOME_BASE, 'r-')));
      const paths = runnerPaths(root);
      mkdirSync(paths.root, { recursive: true });
      const cwd = join(root, 'worktrees', 'P-1', 'X-1');
      mkdirSync(cwd, { recursive: true });
      spawnSync('git', ['init', '-q', '-b', 'main', cwd]);
      spawnSync('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'init'], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'a',
          GIT_AUTHOR_EMAIL: 'a@b.c',
          GIT_COMMITTER_NAME: 'a',
          GIT_COMMITTER_EMAIL: 'a@b.c',
        },
      });
      const outside = join(root, 'outside.txt');
      const adapter = new ClaudeCodeAdapter(
        ClaudeRuntimeConfigSchema.parse({
          bin: CLAUDE,
          authMode: 'api_key',
          apiKey: 'sk-ant-fake-fake-fake',
        }),
        paths,
      );
      const capabilities = new CapabilityRegistry();
      const parsed = indexCapabilityTree({
        'personas/p.md':
          '---\nname: Coder\ndescription: Writes code\nstance: Direct\nvoice: Plain\nicon: wrench\nmodel: opus\ntools: [Read, Edit, Bash]\n---\n\nWrite what is asked.\n',
      }).entries.map((e) => ({ ...e, key: 'pk:coder', pack: { name: 'pk', sha: 'abc123' } }));
      capabilities.setPacks({ entries: () => parsed, scriptsEnabled: () => false } as never);
      const ipc = new IpcServer();
      await ipc.start();
      const calls: string[] = [];
      process.env.AOM_CLAUDE_SMOKE = '1';
      try {
        const api = await fakeApi(`echo CHILD-WROTE > ${cwd}/CHILD.txt; echo OUT > ${outside}; echo DONE`);
        const runner = new DelegateRunner({
          adapters: new Map([['claude-code', adapter]]),
          capabilities,
          paths,
          ipc,
          rpc: async (_id, method) => {
            calls.push(method);
            return { ok: true, result: {} };
          },
          childEnv: { ANTHROPIC_BASE_URL: api.url, ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1' },
        });
        const target = {
          kind: 'persona' as const,
          handle: 'pk:coder',
          key: 'pk:coder',
          name: 'Coder',
          description: '',
          maxCalls: 2,
          timeoutSec: 90,
          maxProfile: null,
        };
        const caller = {
          id: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
          runtime: 'claude-code',
          permissions: SHELL,
          delegation: { targets: [target] },
          work: { cwd, readDirs: [] },
        };
        const r = await runner.run(caller, { target: 'pk:coder', task: 'Write CHILD.txt' });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        // inside the parent's worktree: written; outside it: the sandbox keeps it out
        expect(existsSync(join(cwd, 'CHILD.txt'))).toBe(true);
        expect(readFileSync(join(cwd, 'CHILD.txt'), 'utf8')).toContain('CHILD-WROTE');
        expect(existsSync(outside)).toBe(false);
        expect(api.results.join('\n')).toContain('DONE');
        expect(calls).toEqual(['delegate.begin', 'delegate.cost']);
        // the same target under a parent that may only read: the child only reads, whatever the persona declares
        rmSync(join(cwd, 'CHILD.txt'));
        const reader = await fakeApi(`echo READER-WROTE > ${cwd}/READER.txt; echo DONE2`);
        const readerRunner = new DelegateRunner({
          adapters: new Map([['claude-code', adapter]]),
          capabilities,
          paths,
          ipc,
          rpc: async () => ({ ok: true, result: {} }),
          childEnv: { ANTHROPIC_BASE_URL: reader.url, ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1' },
        });
        const readOnly = {
          ...caller,
          id: '019e3f6a-7b1c-7a2d-8c3e-0123456789c2',
          permissions: { ...SHELL, allowedTools: ['read'], writableGlobs: [], mayCommit: false },
        };
        const r2 = await readerRunner.run(readOnly, { target: 'pk:coder', task: 'Write READER.txt' });
        expect(r2.ok, JSON.stringify(r2)).toBe(true);
        expect(existsSync(join(cwd, 'READER.txt'))).toBe(false);
      } finally {
        delete process.env.AOM_CLAUDE_SMOKE;
        await ipc.stop();
      }
    }, 180_000);
  },
);
