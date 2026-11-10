import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { E2E_DIR, paths } from './env.ts';

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
    AOM_ALLOW_LOCAL_REMOTES: '1',
    AOM_MOCK_STEP_MS: process.env.AOM_MOCK_STEP_MS ?? '1000',
    AOM_RUNNER_HOME: home,
    // the agents' temp dirs (`aom-<hash>`, `aom-run-*`) live in the suite's dir, which the next run deletes, not in /tmp.
    // Only the runners get it: in the suite's own env it would read as "inside a tester shift" (test-services.ts).
    // A tester shift's own value wins.
    AOM_AGENT_TMP_ROOT: process.env.AOM_AGENT_TMP_ROOT ?? join(E2E_DIR, 'agent-tmp'),
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

/**
 * Linux: SIGTERM the fake web servers of our user (busybox `httpd`, python `http.server`) whose command line names `dir`.
 * The fake docker of the deploy specs starts them in the background and nothing stops them on `compose down`. Limited to
 * web servers because `dir` is a fixed path someone may be reading (`tail -f` of a log). Returns the number signalled.
 */
export function killFakeServers(dir: string): number {
  if (process.platform !== 'linux') return 0;
  const uid = process.getuid?.();
  const inside = `${dir.replace(/\/+$/, '')}/`;
  let n = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (uid !== undefined && statSync(`/proc/${name}`).uid !== uid) continue;
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const exe = basename(args[0] ?? '');
      const server =
        exe === 'httpd' || (exe === 'busybox' && args[1] === 'httpd') || args.includes('http.server');
      if (!server || !args.some((a) => a === dir || a.includes(inside))) continue;
      process.kill(Number(name), 'SIGTERM');
      n++;
    } catch {
      /* gone meanwhile, or not ours */
    }
  }
  return n;
}
