import { readFileSync } from 'node:fs';
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
  OwnerTurnInput,
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
  /** The CEO's full-power turn runs like a chat in the mock runtime (nothing real starts); tests see `ownerTurns`. */
  ownerTurns: OwnerTurnInput[] = [];

  async startOwnerTurn(input: OwnerTurnInput): Promise<RuntimeSession> {
    this.ownerTurns.push(input);
    const dir = input.turnDir;
    return this.startChat({
      chatId: input.chatId,
      message: input.message,
      cwd: input.cwd,
      sandbox: { home: dir, configDir: dir, scratch: dir, tmp: dir },
      agent: input.agent,
      env: input.env,
      readOnly: false,
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.logFile ? { logFile: input.logFile } : {}),
    });
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    // A discovery session turn: the scripted mock facilitator (or CEO) drives the real `aom session ...` verbs.
    if (input.sessionTurn?.kind === 'discovery' && input.message.includes('<!--discovery:'))
      return this.startIntakeChat(input, 'discovery');
    if (input.agent.roleKey === 'ba' && input.context?.intake && !input.context.intake.fromChat)
      return this.startIntakeChat(input);
    if (input.agent.roleKey === 'ceo') return this.startIntakeChat(input, 'ceo');
    if (input.agent.roleKey === 'ba' && /^\s*design\b/i.test(input.message))
      return this.startIntakeChat(input, 'design');
    if (input.agent.roleKey === 'ba' && /^\s*(create card|request repo)\b/i.test(input.message))
      return this.startIntakeChat(input, 'desk');
    const prior = /-(\d+)$/.exec(input.resumeSessionId ?? '');
    const turn = (prior ? Number(prior[1]) : 0) + 1;
    const sessionId = `mock-${input.agent.agentId}-${turn}`;
    const reply =
      scriptedReply(input.message, input.agent.name) ??
      `[mock] ${input.agent.name} heard: ${input.message} (turn ${turn})`;
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
    mode: 'intake' | 'design' | 'desk' | 'ceo' | 'discovery' = 'intake',
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
            ...(u.model ? { model: u.model } : {}),
          };
          return [{ kind: 'usage', usage }];
        }
        return ev.kind === 'exit' ? [] : [ev];
      },
    });
  }
}

/**
 * `AOM_MOCK_REPLIES_FILE` names a JSON map of scripted chat replies. It is set for the getting-started video recording
 * and for the simulated workstation of a simulation organization (the server ships its own map). Unset (every real
 * workstation), nothing changes. Keys, tried in this order:
 * - the message itself (matched ignoring case and surrounding space);
 * - `/pattern/` or `/pattern/i`: a regular expression tested against the message (the first match in file order wins);
 * - `*`: the answer for anything else.
 * A value is a reply or a list of replies (one is picked by the message, so the same question always gets the same
 * answer). `{name}` becomes the agent's name and `{message}` the user's message.
 */
export function scriptedReply(
  message: string,
  agentName: string,
  file = process.env.AOM_MOCK_REPLIES_FILE,
): string | null {
  if (!file) return null;
  try {
    const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | string[]>;
    const text = message.trim();
    const key = text.toLowerCase();
    const fill = (v: string | string[]): string => {
      const list = Array.isArray(v) ? v : [v];
      let h = 0;
      for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return (list[h % list.length] ?? '').replaceAll('{name}', agentName).replaceAll('{message}', text);
    };
    for (const [k, v] of Object.entries(map)) if (k.trim().toLowerCase() === key) return fill(v);
    for (const [k, v] of Object.entries(map)) {
      const m = /^\/(.+)\/([a-z]*)$/.exec(k.trim());
      if (!m) continue;
      try {
        if (new RegExp(m[1] as string, m[2]).test(text)) return fill(v);
      } catch {
        /* a broken pattern is skipped */
      }
    }
    if (map['*'] !== undefined) return fill(map['*']);
  } catch {
    /* an unreadable map is ignored */
  }
  return null;
}
