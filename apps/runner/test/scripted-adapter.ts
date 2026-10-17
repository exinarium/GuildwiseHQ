import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  ShiftStartInput,
} from '../src/adapters/types.ts';

export type ScriptResult = {
  finalText?: string;
  exitCode?: number;
};

export interface Ctl {
  signal: AbortSignal;
  /** Emits a runtime event as the runtime would (e.g. a `WebFetch` tool use). */
  emit(event: RuntimeEvent): void;
  /** What `contextTokens()` of the session reports from now on. */
  setContextTokens(n: number): void;
  /** What `usage()` reports from now on (default 1 input, 2 output). */
  setUsage(u: Partial<import('@aom/shared').Usage>): void;
  /** POST to the runner's IPC the way `aom` does. */
  post(
    path: '/v1/report' | '/v1/rpc',
    body: unknown,
    token?: string,
  ): Promise<{ status: number; json: Record<string, any> }>;
}

/** A runtime whose "agent" is a function in the test, talking to the real IPC server. */
export class ScriptedAdapter implements RuntimeAdapter {
  readonly id: string;
  inputs: ShiftStartInput[] = [];
  /** How often `killTools` was called. */
  killed = 0;
  /** Test hook: the login check the supervisor makes before a shift (absent: no check). */
  checkLogin?: () => Promise<'ok' | 'expired' | 'unknown'>;

  constructor(
    private readonly script: (input: ShiftStartInput, ctl: Ctl) => Promise<unknown>,
    id = 'mock',
  ) {
    this.id = id;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { runtime: this.id, version: 'scripted', available: true, capabilities: ['shell', 'edit'] };
  }

  /** The CLAUDE.md text of each shift, as the supervisor wrote it. */
  instructions: string[] = [];

  async writeInstructions(_sandbox: unknown, markdown: string): Promise<void> {
    this.instructions.push(markdown);
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    this.inputs.push(input);
    const abort = new AbortController();
    const queue: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const push = (e: RuntimeEvent) => {
      queue.push(e);
      wake?.();
    };
    let contextTokens = 0;
    let usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const ctl: Ctl = {
      signal: abort.signal,
      emit: push,
      setContextTokens: (n) => {
        contextTokens = n;
      },
      setUsage: (u) => {
        usage = { ...usage, ...u };
      },
      post: async (path, body, token = input.env.AOM_SHIFT_TOKEN) => {
        const res = await fetch(`${input.env.AOM_IPC_URL}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
      },
    };
    const finished = (async () => {
      let exit: RuntimeEvent = { kind: 'exit', code: 0 };
      try {
        const r = (await Promise.race([
          this.script(input, ctl),
          new Promise<'aborted'>((resolve) =>
            abort.signal.addEventListener('abort', () => resolve('aborted')),
          ),
        ])) as ScriptResult | 'aborted' | undefined;
        if (r === 'aborted') exit = { kind: 'exit', code: null, signal: 'SIGTERM' };
        else {
          if (r?.finalText) push({ kind: 'final', text: r.finalText });
          exit = { kind: 'exit', code: r?.exitCode ?? 0 };
        }
      } catch (err) {
        exit = { kind: 'exit', code: 1, error: String(err) };
      }
      push(exit);
      done = true;
      wake?.();
    })();
    return {
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          async next(): Promise<IteratorResult<RuntimeEvent>> {
            for (;;) {
              const e = queue.shift();
              if (e) return { value: e, done: false };
              if (done) return { value: undefined, done: true };
              await new Promise<void>((r) => {
                wake = r;
              });
            }
          },
        }),
      }),
      stop: async () => {
        abort.abort();
        await finished;
      },
      killTools: async () => {
        this.killed++;
        return 1;
      },
      usage: () => usage,
      contextTokens: () => contextTokens,
    };
  }
}
