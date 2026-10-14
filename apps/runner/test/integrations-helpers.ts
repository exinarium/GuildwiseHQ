import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginProcess, LoginSpawner, LoginSpawnSpec } from '../src/integrations/pty.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';

export const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'integrations', name), 'utf8');

/** A pretend CLI: tests feed it output, read what was written to its stdin, and end it. */
export class ScriptedLogin implements LoginProcess {
  private out = '';
  private cbs: Array<() => void> = [];
  readonly writes: string[] = [];
  killed = false;
  private resolve!: (code: number) => void;
  readonly done = new Promise<number>((r) => {
    this.resolve = r;
  });
  constructor(readonly spec: LoginSpawnSpec) {}
  output() {
    return this.out;
  }
  onOutput(cb: () => void) {
    this.cbs.push(cb);
  }
  write(t: string) {
    this.writes.push(t);
  }
  kill() {
    this.killed = true;
    this.resolve(143);
  }
  feed(text: string) {
    this.out += text;
    for (const cb of this.cbs) cb();
  }
  exit(code: number) {
    this.resolve(code);
  }
}

/** A spawner that hands out `ScriptedLogin`s, remembering them. */
export function scriptedSpawner(): { spawn: LoginSpawner; procs: ScriptedLogin[] } {
  const procs: ScriptedLogin[] = [];
  return {
    procs,
    spawn: (spec) => {
      const p = new ScriptedLogin(spec);
      procs.push(p);
      return p;
    },
  };
}

export const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until `cond` holds (polling), or fails the test with `what`. */
export async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(10);
  }
}

export interface ExecCall {
  cmd: string;
  args: string[];
  input?: string;
}

/** An Executor that answers from a table of `(cmd args)` prefixes and records every call. */
export function fakeExec(
  answers: Array<{ match: (cmd: string, args: string[]) => boolean; result: Partial<ExecResult> }> = [],
): { exec: Executor; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: {
      async run(cmd: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
        calls.push({ cmd, args, ...(o.input !== undefined ? { input: o.input } : {}) });
        const hit = answers.find((a) => a.match(cmd, args));
        return { exitCode: 0, stdout: '', stderr: '', ...(hit?.result ?? {}) };
      },
    },
  };
}
