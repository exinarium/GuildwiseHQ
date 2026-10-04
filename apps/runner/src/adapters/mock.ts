import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Usage } from '@aom/shared';
import type { z } from 'zod';
import type { MockRuntimeConfigSchema } from '../config.ts';
import type { RunnerPaths } from '../paths.ts';
import { selfCommand } from '../shims.ts';
import { spawnSession } from './process-session.ts';
import type {
  ChatStartInput,
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
      ...(this.cfg.sandbox ? { sandbox: this.cfg.sandbox, sandboxReason: this.cfg.sandboxReason } : {}),
    };
  }

  async writeInstructions(sandbox: { configDir: string }, markdown: string): Promise<void> {
    await mkdir(sandbox.configDir, { recursive: true });
    await writeFile(join(sandbox.configDir, 'CLAUDE.md'), markdown);
  }

  /**
   * Deterministic chat: echoes `[mock] <name> heard: <message> (turn <n>)` word by word. The runtime session id is
   * `mock-<agentId>-<n>`, so resuming counts turns. No process, no tokens.
   */
  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    if (input.agent.roleKey === 'ba' && input.context?.intake && !input.context.intake.fromChat)
      return this.startIntakeChat(input);
    if (input.agent.roleKey === 'ba' && /^\s*design\b/i.test(input.message))
      return this.startIntakeChat(input, 'design');
    if (input.agent.roleKey === 'ba' && /^\s*(create card|request repo)\b/i.test(input.message))
      return this.startIntakeChat(input, 'desk');
    const prior = /-(\d+)$/.exec(input.resumeSessionId ?? '');
    const turn = (prior ? Number(prior[1]) : 0) + 1;
    const sessionId = `mock-${input.agent.agentId}-${turn}`;
    const reply = `[mock] ${input.agent.name} heard: ${input.message} (turn ${turn})`;
    const tokenMs = Number(process.env.AOM_MOCK_CHAT_TOKEN_MS ?? 40);
    const usage: Usage = {
      inputTokens: input.message.length,
      outputTokens: reply.length,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let stopped = false;
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    async function* gen(): AsyncGenerator<RuntimeEvent> {
      try {
        yield { kind: 'session', runtimeSessionId: sessionId };
        for (const word of reply.split(/(?<= )/)) {
          if (stopped) break;
          await new Promise((r) => setTimeout(r, tokenMs));
          yield { kind: 'delta', text: word };
        }
        if (stopped) {
          yield { kind: 'exit', code: null, signal: 'SIGTERM' };
          return;
        }
        yield { kind: 'usage', usage };
        yield { kind: 'final', text: reply };
        yield { kind: 'exit', code: 0 };
      } finally {
        finish();
      }
    }
    const events = gen();
    return {
      events: () => ({ [Symbol.asyncIterator]: () => events }),
      async stop() {
        stopped = true;
        await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
      },
      usage: () => usage,
    };
  }

  /**
   * The BA's intake chat: the scripted mock BA (`mock-agent` in intake mode) drives the real `aom` verbs through the
   * chat-scoped IPC token, so the whole path (rpc, server validation, cards) is exercised without a model.
   */
  private async startIntakeChat(
    input: ChatStartInput,
    mode: 'intake' | 'design' | 'desk' = 'intake',
  ): Promise<RuntimeSession> {
    const [bin, ...pre] = selfCommand('mock-agent') as [string, ...string[]];
    const prior = /-(\d+)$/.exec(input.resumeSessionId ?? '');
    const turn = (prior ? Number(prior[1]) : 0) + 1;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return spawnSession({
      bin,
      args: pre,
      cwd: input.cwd,
      env: {
        ...input.env,
        AOM_MOCK_CHAT: mode,
        AOM_MOCK_MESSAGE: input.message,
        AOM_MOCK_CONTEXT: JSON.stringify(input.context ?? {}),
        AOM_MOCK_SESSION: `mock-${input.agent.agentId}-${turn}`,
        AOM_MOCK_STATE_DIR: this.paths.mockState,
        AOM_MOCK_SOURCES_DIR: join(this.paths.root, 'mock-sources'),
      },
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
          usage = {
            inputTokens: ev.usage.inputTokens ?? 0,
            outputTokens: ev.usage.outputTokens ?? 0,
            cacheReadTokens: ev.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: ev.usage.cacheWriteTokens ?? 0,
          };
          return [{ kind: 'usage', usage }];
        }
        return ev.kind === 'exit' ? [] : [ev];
      },
    });
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    const [bin, ...pre] = selfCommand('mock-agent') as [string, ...string[]];
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return spawnSession({
      bin,
      args: pre,
      cwd: input.cwd,
      env: {
        ...input.env,
        AOM_MOCK_STATE_DIR: this.paths.mockState,
        // Test hook: slow the mock's three progress steps so UIs can observe each stage.
        ...(process.env.AOM_MOCK_STEP_MS ? { AOM_MOCK_STEP_MS: process.env.AOM_MOCK_STEP_MS } : {}),
      },
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
