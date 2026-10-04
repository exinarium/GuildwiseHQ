import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Usage } from '@aom/shared';
import { execa } from 'execa';
import type { RuntimeEvent, RuntimeSession } from './types.ts';

export interface ProcessSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Maps one stdout line to runtime events. */
  parseLine: (line: string) => RuntimeEvent[];
  usage: () => Usage;
  /** Also pass the runner's own environment to the child (default). Agent sessions with an allow-listed `env` set false. */
  inheritEnv?: boolean;
  /** Raw stdout lines are appended here. */
  logFile?: string;
  /** Appended to the exit event's error when the process fails (e.g. a parsed API error). */
  exitError?: () => string | undefined;
}

class EventQueue {
  private items: RuntimeEvent[] = [];
  private waiters: Array<(r: IteratorResult<RuntimeEvent>) => void> = [];
  private done = false;

  push(e: RuntimeEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false });
    else this.items.push(e);
  }

  end(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  iterable(): AsyncIterable<RuntimeEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<RuntimeEvent>> => {
          const item = this.items.shift();
          if (item) return Promise.resolve({ value: item, done: false });
          if (this.done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => this.waiters.push(resolve));
        },
      }),
    };
  }
}

/** Spawns a child process (no shell) and exposes it as a `RuntimeSession`. Shared by the Claude and mock adapters. */
export function spawnSession(spec: ProcessSpec): RuntimeSession {
  const queue = new EventQueue();
  if (spec.logFile) mkdirSync(dirname(spec.logFile), { recursive: true });

  const sub = execa(spec.bin, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    extendEnv: spec.inheritEnv ?? true,
    reject: false,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    forceKillAfterDelay: 10_000,
    cleanup: true,
  });

  let stderrTail = '';
  sub.stderr?.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString('utf8')).slice(-2000);
  });
  const rl = sub.stdout ? createInterface({ input: sub.stdout }) : null;
  rl?.on('line', (line) => {
    if (spec.logFile) {
      try {
        appendFileSync(spec.logFile, `${line}\n`);
      } catch {
        // log is best effort
      }
    }
    for (const ev of spec.parseLine(line)) queue.push(ev);
  });

  const finished = (async () => {
    const r = await sub;
    // Let readline drain remaining lines before announcing the exit.
    await new Promise<void>((resolve) => {
      if (!rl) return resolve();
      rl.once('close', () => resolve());
      setTimeout(resolve, 500).unref?.();
    });
    const code = typeof r.exitCode === 'number' ? r.exitCode : null;
    const failed = code !== 0;
    const error = failed
      ? [
          spec.exitError?.(),
          r.failed && code === null && !r.signal ? r.shortMessage : undefined,
          stderrTail.trim(),
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 1000) || undefined
      : undefined;
    queue.push({
      kind: 'exit',
      code,
      ...(r.signal ? { signal: String(r.signal) } : {}),
      ...(error ? { error } : {}),
    });
    queue.end();
  })();

  return {
    events: () => queue.iterable(),
    async stop() {
      if (sub.exitCode === null && !sub.killed) sub.kill('SIGTERM');
      await finished;
    },
    usage: spec.usage,
  };
}
