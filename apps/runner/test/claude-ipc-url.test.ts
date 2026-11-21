import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * REVIEW N1: the claude-code adapter carries the session's AOM_IPC_URL into the policy (`ipcUrl`), so the settings.json of
 * every sandboxed session allows exactly the runner's endpoint. Without that line every sandboxed `aom` call fails again
 * (the 1.10.0 blocker), and only the opt-in real test (aom-sandbox-real.test.ts) would notice.
 */
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};

describe('the claude-code adapter writes the runner endpoint into the sandbox allowlist', () => {
  it.each(['builder', 'reviewer', 'ceo'])(
    '%s shift: AOM_IPC_URL -> allowedDomains, nothing without it',
    async (roleKey) => {
      const t = tmp();
      const bin = join(t, 'fakeclaude');
      writeFileSync(bin, `#!/bin/sh\necho '{"type":"system"}'\nexit 0\n`);
      chmodSync(bin, 0o755);
      const cwd = join(t, 'data', 'worktrees', 'P4-98eeafb0', 'P4-3');
      mkdirSync(cwd, { recursive: true });
      const paths = runnerPaths(join(t, 'data'));
      const sandbox = await ensureSandbox(paths, A, 'Ada');
      // `best_effort`: the settings carry the sandbox block whether or not bubblewrap is on this machine
      const adapter = new ClaudeCodeAdapter(
        ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'best_effort' }),
        paths,
      );
      const run = async (env: Record<string, string>) => {
        const s = await adapter.start({
          shiftId: 'zz',
          prompt: 'go',
          instructionsMarkdown: '',
          cwd: roleKey === 'ceo' ? sandbox.scratch : cwd,
          sandbox,
          addDirs: [],
          env,
          maxShiftMinutes: 5,
          agent: {
            agentId: A,
            name: 'Ada',
            roleKey,
            seniority: 'senior',
            runtime: 'claude-code',
            model: 'sonnet',
            skills: [],
            permissions: role(roleKey).permissions,
            isDevops: false,
          },
        } as never);
        const ev: RuntimeEvent[] = [];
        for await (const e of s.events()) ev.push(e);
        return JSON.parse(readFileSync(join(sandbox.configDir, 'settings.json'), 'utf8'));
      };
      process.env.AOM_CLAUDE_SMOKE = '1';
      try {
        const withIpc = await run({
          AOM_IPC_URL: 'http://127.0.0.1:45319',
          AOM_IPC_SOCKET: '/tmp/aom-ipc-x/ipc.sock',
        });
        expect(withIpc.sandbox.network.allowedDomains).toContain('127.0.0.1:45319');
        expect(withIpc.sandbox.network.allowUnixSockets).toEqual(['/tmp/aom-ipc-x/ipc.sock']);
        expect(withIpc.sandbox.allowUnsandboxedCommands).toBe(false);
        const without = await run({});
        expect(without.sandbox.network.allowedDomains).not.toContain('127.0.0.1:45319');
        expect(withIpc.sandbox.network.allowedDomains.filter((d: string) => d !== '127.0.0.1:45319')).toEqual(
          without.sandbox.network.allowedDomains,
        );
      } finally {
        delete process.env.AOM_CLAUDE_SMOKE;
      }
    },
  );
});
