import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();

/**
 * Opt-in (spends tokens): `AOM_CLAUDE_SMOKE=1 CLAUDE_CODE_OAUTH_TOKEN=... pnpm --filter @aom/runner test:smoke`.
 * Runs one real builder shift with Claude Code on a toy repo and asserts that a handoff is recorded.
 */
const enabled = process.env.AOM_CLAUDE_SMOKE === '1';

describe.skipIf(!enabled)('claude smoke (real Claude Code shift)', () => {
  it(
    'a builder shift on a toy repo records a handoff',
    async () => {
      const { makeShiftStart } = await import('./fixtures.ts');
      const cfg = ClaudeRuntimeConfigSchema.parse(
        process.env.CLAUDE_CODE_OAUTH_TOKEN
          ? { authMode: 'oauth', oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN }
          : {},
      );
      const h = await startHarness({}, { adapters: new Map([['claude-code', new ClaudeCodeAdapter(cfg)]]) });
      try {
        const msg = makeShiftStart({
          remoteNormalized: h.repo.remoteNormalized,
          title: 'Add hello file',
        }) as any;
        msg.agent.runtime = 'claude-code';
        msg.agent.model = process.env.AOM_CLAUDE_SMOKE_MODEL ?? 'haiku';
        msg.brief.card.fields = {
          context: 'Smoke test on a toy repo.',
          requirements: 'Create a file hello.txt containing the single word hello, commit it, then hand off.',
          acceptanceCriteria: ['hello.txt exists and contains "hello"'],
          affectedAreas: 'hello.txt',
          constraints: 'Do not touch other files.',
          testPlan: 'cat hello.txt',
        };
        h.server.send('shift.start', msg);
        const ended = await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 10 * 60_000);
        expect(ended.outcome).toBe('reported');
        expect(h.server.of('shift.report').some((r) => r.shiftId === msg.shiftId)).toBe(true);
        expect(existsSync(join(worktreeOf(h), 'hello.txt'))).toBe(true);
      } finally {
        await h.stop();
      }
    },
    11 * 60_000,
  );
});
