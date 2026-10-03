import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, RealClaudeBlockedError, realClaudeBlocked } from '../src/adapters/claude-code.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';

describe('real Claude guard', () => {
  it('blocks in mock mode and test environments, unless the smoke test opts in', () => {
    expect(realClaudeBlocked({ AOM_RUNNER_MOCK: '1' })).toBe(true);
    expect(realClaudeBlocked({ NODE_ENV: 'test' })).toBe(true);
    expect(realClaudeBlocked({ VITEST: 'true' })).toBe(true);
    expect(realClaudeBlocked({})).toBe(false);
    expect(realClaudeBlocked({ AOM_RUNNER_MOCK: '1', AOM_CLAUDE_SMOKE: '1' })).toBe(false);
  });

  it('refuses to start a shift or chat and reports itself unavailable under vitest', async () => {
    const a = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({}));
    expect((await a.capabilities()).available).toBe(false);
    await expect(a.start({} as never)).rejects.toBeInstanceOf(RealClaudeBlockedError);
    await expect(a.startChat({} as never)).rejects.toBeInstanceOf(RealClaudeBlockedError);
  });
});
