import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './env.ts';

/**
 * Runner processes started by the tests (pair + start). The default runner (`paths.runnerData`) is the one the M1
 * specs use; M3 specs run more runners, each with its own data dir (`home`). Pids are recorded so global teardown can
 * kill them all.
 */
const current = new Map<string, ChildProcess>();
const logFile = (home: string) => (home === paths.runnerData ? paths.runnerLog : `${home}.out.log`);

function runnerEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AOM_RUNNER_MOCK: '1',
    AOM_MOCK_STEP_MS: process.env.AOM_MOCK_STEP_MS ?? '1000',
    AOM_RUNNER_HOME: home,
    ...extra,
  };
}

export function pairRunner(server: string, code: string, name: string, home = paths.runnerData): string {
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
      home,
    ],
    { env: runnerEnv(home), encoding: 'utf8' },
  );
}

export function addRepoRoot(dir: string, home = paths.runnerData): void {
  execFileSync('node', [paths.runnerBin, 'repos', 'add', dir, '--data-dir', home], {
    env: runnerEnv(home),
    encoding: 'utf8',
  });
}

export function startRunner(extraEnv: Record<string, string> = {}, home = paths.runnerData): ChildProcess {
  const out = openSync(logFile(home), 'a');
  const child = spawn('node', [paths.runnerBin, 'start', '--mock', '--data-dir', home], {
    env: runnerEnv(home, extraEnv),
    stdio: ['ignore', out, out],
    detached: true,
  });
  closeSync(out);
  current.set(home, child);
  recordPid(home, child.pid);
  return child;
}

/** SIGKILL the runner process group (the runner plus any mock-agent child), like a crash. */
export function killRunner(signal: NodeJS.Signals = 'SIGKILL', home = paths.runnerData): void {
  const pid = current.get(home)?.pid ?? readPids()[home];
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
  current.delete(home);
}

/** Global teardown: every runner any spec started. */
export function killAllRunners(signal: NodeJS.Signals = 'SIGTERM'): void {
  const homes = new Set([...current.keys(), ...Object.keys(readPids())]);
  for (const h of homes) killRunner(signal, h);
}

const readAll = (): Record<string, any> =>
  existsSync(paths.pids) ? JSON.parse(readFileSync(paths.pids, 'utf8')) : {};

function readPids(): Record<string, number> {
  const all = readAll();
  return { ...(all.runners ?? {}), ...(all.runner ? { [paths.runnerData]: all.runner } : {}) };
}

function recordPid(home: string, pid: number | undefined): void {
  const all = readAll();
  if (home === paths.runnerData) all.runner = pid;
  else all.runners = { ...(all.runners ?? {}), [home]: pid };
  writeFileSync(paths.pids, JSON.stringify(all));
}
