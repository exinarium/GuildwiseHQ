import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Usage } from '@aom/shared';
import type { z } from 'zod';
import type { MockRuntimeConfigSchema } from '../config.ts';
import type { RunnerPaths } from '../paths.ts';
import { selfCommand } from '../shims.ts';
import { spawnSession } from './process-session.ts';
import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  ShiftStartInput,
} from './types.ts';

type MockConfig = z.infer<typeof MockRuntimeConfigSchema>;

const ALL_CAPABILITIES = ['shell', 'edit', 'web', 'mcp', 'skills', 'sandbox_config', 'resume'];

/**
 * Deterministic adapter without tokens: runs `mock-agent`, which drives the real `aom` CLI and IPC path
 * (docs/ARCHITECTURE.md section 12.3). Its stdout is JSON lines shaped like `RuntimeEvent`.
 */
export class MockAdapter implements RuntimeAdapter {
  readonly id = 'mock';

  constructor(
    private readonly cfg: MockConfig,
    private readonly paths: RunnerPaths,
  ) {}

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      runtime: this.id,
      version: 'mock-1',
      available: this.cfg.enabled,
      capabilities: this.cfg.capabilities ?? ALL_CAPABILITIES,
    };
  }

  async writeInstructions(sandbox: { configDir: string }, markdown: string): Promise<void> {
    await mkdir(sandbox.configDir, { recursive: true });
    await writeFile(join(sandbox.configDir, 'CLAUDE.md'), markdown);
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    const [bin, ...pre] = selfCommand('mock-agent') as [string, ...string[]];
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return spawnSession({
      bin,
      args: pre,
      cwd: input.cwd,
      env: { ...input.env, AOM_MOCK_STATE_DIR: this.paths.mockState },
      logFile: input.logFile,
      usage: () => usage,
      parseLine: (line) => {
        let ev: RuntimeEvent;
        try {
          ev = JSON.parse(line) as RuntimeEvent;
        } catch {
          return [];
        }
        if (ev.kind === 'usage') {
          const u = ev.usage;
          usage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cacheReadTokens: u.cacheReadTokens ?? 0,
            cacheWriteTokens: u.cacheWriteTokens ?? 0,
          };
          return [{ kind: 'usage', usage }];
        }
        return ev.kind === 'exit' ? [] : [ev];
      },
    });
  }
}
