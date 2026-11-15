import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { type ReviewerRun, reviewerPolicy } from '../src/review/reviewer-sandbox.ts';

// Starts the real adapter's chat start-up for a review run (the claude binary is a name that does not exist, so
// nothing runs) and checks the files Claude Code is pointed at.
describe('Claude Code chat for a review run', () => {
  it('writes an empty mcp.json and the reviewer settings, and no skills or agents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'review-chat-'));
    const configDir = join(root, 'claude');
    const checkout = join(root, 'checkout');
    mkdirSync(checkout, { recursive: true });
    const run = {
      spec: { runId: 'r1' },
      runDir: root,
      checkout,
      sandbox: {
        agentId: 'pr-review-r1',
        root,
        home: join(root, 'home'),
        configDir,
        scratch: join(root, 's'),
        tmp: join(root, 't'),
      },
    } as unknown as ReviewerRun;
    const a = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ bin: 'no-such-claude-binary' }));
    const input: any = {
      reviewRun: run,
      cwd: checkout,
      sandbox: run.sandbox,
      env: {},
      readOnly: true,
      message: 'review',
      agent: { roleKey: 'reviewer', model: 'sonnet', permissions: { allowedTools: [] } },
      chatId: 'c1',
      orgId: 'o1',
    };
    const start = (a as any).startChatSession(input, input, false, (a as any).account('main'), undefined);
    await Promise.resolve(start).catch(() => undefined);
    expect(existsSync(join(configDir, 'mcp.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: {} });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings).toEqual(
      JSON.parse(JSON.stringify(reviewerPolicy(run, (a as any).policy(input, checkout, true)).settings)),
    );
    const files = readdirSync(configDir);
    expect(files).not.toContain('skills');
    expect(files).not.toContain('agents');
  });
});
