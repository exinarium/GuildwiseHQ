import { delimiter } from 'node:path';
import { execa } from 'execa';
import { BREW_BIN_DIRS, userBinDirs } from '../toolchain/exec.ts';

/** A login CLI that keeps running while the user finishes it in their browser. */
export interface LoginProcess {
  /** Everything printed so far (stdout and stderr, raw: escapes included). Never leaves the runner. */
  output(): string;
  /** Calls back on every chunk. */
  onOutput(cb: () => void): void;
  /** Writes to the CLI's stdin (the terminal, with a pty). */
  write(text: string): void;
  /** The exit code when it ends. */
  done: Promise<number>;
  kill(): void;
}

export interface LoginSpawnSpec {
  cmd: string;
  args: string[];
  /** The CLI draws a terminal screen and needs a TTY (the `claude` ones). */
  pty: boolean;
  env?: Record<string, string>;
  cwd?: string;
  /** Hard limit; the process is killed after this. */
  timeoutMs: number;
}

export type LoginSpawner = (spec: LoginSpawnSpec) => LoginProcess;

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wraps a command in `script(1)` so it gets a pseudo-terminal without a native module (the runner ships as a tgz without
 * any). Linux: `script -qfec "<cmd>" /dev/null` with a wide terminal (a long token or URL never wraps); macOS: `script -q
 * /dev/null <cmd> <args>`. Native Windows has no script(1): null.
 */
export function ptyWrap(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  if (platform === 'linux')
    return {
      cmd: 'script',
      args: [
        '-qfec',
        `stty cols 1000 rows 50 2>/dev/null; exec ${[cmd, ...args].map(shQuote).join(' ')}`,
        '/dev/null',
      ],
    };
  if (platform === 'darwin') return { cmd: 'script', args: ['-q', '/dev/null', cmd, ...args] };
  return null;
}

/** The real thing: a hard time limit, a quiet environment (nothing tries to open a desktop browser), output kept raw. */
export const spawnLoginProcess: LoginSpawner = (spec) => {
  let out = '';
  const cbs: Array<() => void> = [];
  const wrapped = spec.pty ? ptyWrap(spec.cmd, spec.args) : { cmd: spec.cmd, args: spec.args };
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...spec.env,
    NO_COLOR: '1',
    COLUMNS: '1000',
    BROWSER: 'true',
    PATH: [spec.env?.PATH ?? '', ...userBinDirs(), process.env.PATH ?? '', ...BREW_BIN_DIRS]
      .filter(Boolean)
      .join(delimiter),
  };
  const feed = (b: Buffer | string) => {
    out += String(b);
    for (const cb of cbs) cb();
  };
  if (!wrapped) {
    const done = Promise.resolve(127);
    feed('This workstation has no pseudo-terminal support (script is missing).\n');
    return {
      output: () => out,
      onOutput: (cb) => void cbs.push(cb),
      write: () => undefined,
      done,
      kill: () => undefined,
    };
  }
  const child = execa(wrapped.cmd, wrapped.args, {
    reject: false,
    stdin: 'pipe',
    env,
    extendEnv: false,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    timeout: spec.timeoutMs,
    detached: process.platform !== 'win32',
    cleanup: true,
  });
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  child.stdin?.on('error', () => undefined);
  const kill = () => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, 2000).unref();
  };
  return {
    output: () => out,
    onOutput: (cb) => void cbs.push(cb),
    write: (text) => void child.stdin?.write(text),
    done: child.then((r) => (typeof r.exitCode === 'number' ? r.exitCode : 1)),
    kill,
  };
};
