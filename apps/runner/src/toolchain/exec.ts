import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execa } from 'execa';
import { redact } from '../secrets/redact.ts';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Written to stdin (the sudo password). Never logged. */
  input?: string;
  env?: Record<string, string>;
}

/** Runs one command (no shell). Tests inject a scripted one; the runner uses `realExecutor`. */
export interface Executor {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
}

/** User-level install locations the installers use: not on a service's PATH, but where the tools end up. */
export function userBinDirs(home = homedir()): string[] {
  return [
    join(home, '.dotnet'),
    join(home, '.dotnet', 'tools'),
    join(home, '.cargo', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
  ];
}

/** Where Homebrew installs (macOS Apple Silicon and Intel, Linux): not on a service's PATH. */
export const BREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];

/** Real executor: output is always run through the secret redaction; a missing binary is exit code 127. */
export const realExecutor: Executor = {
  async run(cmd, args, opts = {}) {
    try {
      const r = await execa(cmd, args, {
        reject: false,
        stdin: opts.input !== undefined ? 'pipe' : 'ignore',
        ...(opts.input !== undefined ? { input: opts.input } : {}),
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30 * 60_000,
        env: {
          ...process.env,
          ...opts.env,
          PATH: [...userBinDirs(), process.env.PATH ?? '', ...BREW_BIN_DIRS].join(delimiter),
          DEBIAN_FRONTEND: 'noninteractive',
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          DOTNET_NOLOGO: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      return {
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : r.failed ? 1 : 0,
        stdout: redact(String(r.stdout ?? '')),
        stderr: redact(String(r.stderr ?? '')),
      };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return {
        exitCode: e.code === 'ENOENT' ? 127 : 1,
        stdout: '',
        stderr: redact(e.message ?? String(err)),
      };
    }
  },
};
