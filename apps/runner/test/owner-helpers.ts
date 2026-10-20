import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import type {
  ChatStartInput,
  OwnerTurnInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
} from '../src/adapters/types.ts';

const ceoRole = BUILTIN_ROLES.find((r) => r.key === 'ceo');
if (!ceoRole) throw new Error('role');

export const THREAD = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
export const CEO_AGENT = '019e3f6a-7b1c-7a2d-8c3e-0123456789a2';

export const ceoAgent = (over: Record<string, unknown> = {}) => ({
  agentId: CEO_AGENT,
  name: 'Ada',
  roleKey: 'ceo',
  seniority: 'senior',
  runtime: 'mock',
  model: 'sonnet',
  skills: [],
  permissions: ceoRole.permissions,
  isDevops: false,
  ...over,
});

export const ceoChatStart = (message: string, over: Record<string, unknown> = {}) => ({
  chatId: uuidv7(),
  threadId: THREAD,
  agent: ceoAgent(),
  message,
  context: { ceo: { brief: 'STATIC BRIEF' } },
  ...over,
});

/** A chat runtime whose sessions the test controls: `release()` lets a session finish; `tools` are emitted first. */
export class FakeChatAdapter implements RuntimeAdapter {
  readonly id = 'mock';
  chats: ChatStartInput[] = [];
  ownerTurns: OwnerTurnInput[] = [];
  tools: Array<{ name: string; summary: string }> = [];
  /** When set, a session emits exactly these events (then usage, final if `final` is set, exit 0) instead of tools + delta. */
  script?: RuntimeEvent[];
  scriptFinal?: string;
  hold = false;
  private gate: Promise<void> = Promise.resolve();
  private open: () => void = () => {};

  async capabilities(): Promise<RuntimeCapabilities> {
    return { runtime: 'mock', version: 'fake', available: true, capabilities: ['shell'] };
  }
  async writeInstructions(): Promise<void> {}
  async start(): Promise<RuntimeSession> {
    throw new Error('shifts are not run by this adapter');
  }

  holdSessions(): void {
    this.hold = true;
    this.gate = new Promise((r) => {
      this.open = r;
    });
  }
  release(): void {
    this.hold = false;
    this.open();
  }

  private session(text: string): RuntimeSession {
    const stopped = { v: false };
    const tools = this.tools;
    const script = this.script;
    const scriptFinal = this.scriptFinal;
    const gate = () => (this.hold ? this.gate : Promise.resolve());
    async function* gen(): AsyncGenerator<RuntimeEvent> {
      yield { kind: 'session', runtimeSessionId: 'sess-1' };
      if (script) {
        for (const e of script) yield e;
        if (scriptFinal !== undefined) yield { kind: 'final', text: scriptFinal };
        yield { kind: 'exit', code: 0 };
        return;
      }
      for (const t of tools) yield { kind: 'tool', ...t };
      await gate();
      if (stopped.v) {
        yield { kind: 'exit', code: null, signal: 'SIGTERM' };
        return;
      }
      yield { kind: 'delta', text };
      yield {
        kind: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: 'claude-sonnet-x',
        },
      };
      yield { kind: 'final', text };
      yield { kind: 'exit', code: 0 };
    }
    return {
      events: () => gen(),
      stop: async () => {
        stopped.v = true;
        this.open();
      },
      usage: () => ({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: 'claude-sonnet-x',
      }),
    };
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    this.chats.push(input);
    return this.session('restricted reply');
  }
  async startOwnerTurn(input: OwnerTurnInput): Promise<RuntimeSession> {
    this.ownerTurns.push(input);
    return this.session('owner reply');
  }
}
