import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './env.ts';

/** The runner process started by the tests (pair + start). Its pid is recorded so global teardown can kill it. */
let current: ChildProcess | null = null;

function runnerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AOM_RUNNER_MOCK: '1',
    AOM_MOCK_STEP_MS: process.env.AOM_MOCK_STEP_MS ?? '1000',
    AOM_RUNNER_HOME: paths.runnerData,
    ...extra,
  };
}

export function pairRunner(server: string, code: string, name: string): string {
  return execFileSync(
    'node',
    [
      paths.runnerBin,
      'pair',
      '--server',
      server,
      '--code',
      code,
      '--name',
      name,
      '--mock',
      '--data-dir',
      paths.runnerData,
    ],
    { env: runnerEnv(), encoding: 'utf8' },
  );
}

export function addRepoRoot(dir: string): void {
  execFileSync('node', [paths.runnerBin, 'repos', 'add', dir, '--data-dir', paths.runnerData], {
    env: runnerEnv(),
    encoding: 'utf8',
  });
}

export function startRunner(extraEnv: Record<string, string> = {}): ChildProcess {
  const out = openSync(paths.runnerLog, 'a');
  const child = spawn('node', [paths.runnerBin, 'start', '--mock', '--data-dir', paths.runnerData], {
    env: runnerEnv(extraEnv),
    stdio: ['ignore', out, out],
    detached: true,
  });
  closeSync(out);
  current = child;
  recordPid(child.pid);
  return child;
}

/** SIGKILL the runner process group (the runner plus any mock-agent child), like a crash. */
export function killRunner(signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = current?.pid ?? readRunnerPid();
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
  current = null;
}

function readRunnerPid(): number | undefined {
  return existsSync(paths.pids) ? JSON.parse(readFileSync(paths.pids, 'utf8')).runner : undefined;
}

function recordPid(pid: number | undefined): void {
  const all = existsSync(paths.pids) ? JSON.parse(readFileSync(paths.pids, 'utf8')) : {};
  all.runner = pid;
  writeFileSync(paths.pids, JSON.stringify(all));
}
