import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { BASE_URL, E2E_DIR, paths, ROOT } from '../../support/env.ts';
import { addRepoRoot, pairRunner } from '../../support/runner.ts';
import { pairingCode } from './flow.ts';
import { gateDirOf, initGates, release, waitReached } from './gates.ts';
import { assertLoopback } from './guards.ts';

export interface HostPolicy {
  /** `ask` (default of the product) holds a DevOps shift for a local yes; `auto` runs it. */
  devopsRequests?: 'ask' | 'auto';
  devopsInstall?: boolean;
  /** Written as is over the defaults (policy.json, schema in apps/runner/src/policy/schema.ts). */
  extra?: Record<string, unknown>;
}

export interface Host {
  name: string;
  home: string;
  policyDir: string;
  gateDir: string;
  workstationId: string;
  approvalsPort: number;
  child: ChildProcess;
  logFile: string;
  /** Rewrites policy.json (the running runner re-reads it when the file changes). */
  writePolicy(p: HostPolicy & { grant?: { orgId: string; agentId: string } }): void;
  stop(): Promise<void>;
}

/** What the runner host may inherit: where programs are, the temp dirs the run set up, locale and identity of the account. */
const HOST_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'NODE_NO_WARNINGS',
  'PLAYWRIGHT_BROWSERS_PATH',
  'AOM_MOCK_STEP_MS',
] as const;

/** The host is detached (its own process group): record it where the global teardown and combined.sh look, so an interrupted run leaves none. */
function recordHostPid(home: string, pid: number | undefined): void {
  const all = existsSync(paths.pids) ? JSON.parse(readFileSync(paths.pids, 'utf8')) : {};
  all.runners = { ...(all.runners ?? {}), [home]: pid };
  writeFileSync(paths.pids, JSON.stringify(all));
}

const tsxCli = (): string =>
  join(dirname(createRequire(join(ROOT, 'package.json')).resolve('tsx/package.json')), 'dist', 'cli.mjs');

export const policyJson = (p: HostPolicy, grant?: { orgId: string; agentId: string }): string =>
  `${JSON.stringify({
    version: 1,
    setupDone: true,
    devopsRequests: p.devopsRequests ?? 'auto',
    ...(p.devopsInstall === undefined ? {} : { devopsInstall: p.devopsInstall }),
    devops: { agents: grant ? { [grant.orgId]: grant.agentId } : {} },
    ...(p.extra ?? {}),
  })}\n`;

/**
 * Pairs a runner with the real server through the real pairing code, and starts the scripted runner host on it
 * (scripted-runner-host.ts, under tsx). HOME and XDG_* move into the temp dir for the host only; the specs' own process
 * keeps the real HOME (browsers, pnpm). `identity: false` leaves the host with no git identity at all (A10).
 */
export async function startHost(
  api: APIRequestContext,
  o: {
    /** The owner's password: pairing starts with a step-up. */
    password: string;
    name: string;
    repoRoot: string;
    policy?: HostPolicy;
    identity?: boolean;
    extraEnv?: Record<string, string>;
  },
): Promise<Host> {
  assertLoopback(BASE_URL);
  const home = join(E2E_DIR, `runner-${o.name}`);
  const policyDir = join(home, 'policy');
  const fakeHome = join(E2E_DIR, `home-${o.name}`);
  mkdirSync(policyDir, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  if (o.identity !== false)
    writeFileSync(
      join(fakeHome, '.gitconfig'),
      '[user]\n\tname = Combined Tester\n\temail = tester@e2e.test\n',
    );
  const code = await pairingCode(api, o.password);
  pairRunner(BASE_URL, code, o.name, home);
  addRepoRoot(o.repoRoot, home);
  const write = (p: HostPolicy & { grant?: { orgId: string; agentId: string } }) =>
    writeFileSync(join(policyDir, 'policy.json'), policyJson(p, p.grant), { mode: 0o600 });
  write(o.policy ?? {});
  initGates(gateDirOf(home));
  const logFile = join(home, 'host.out.log');
  const out = openSync(logFile, 'a');
  // An explicit allowlist: nothing else of the caller's environment (GH_TOKEN, AWS_*, SSH_AUTH_SOCK, ANTHROPIC_*, GIT_AUTHOR_*)
  // reaches the runner host or the agents it starts.
  const env: NodeJS.ProcessEnv = {};
  for (const k of HOST_ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^LC_/.test(k)) env[k] = process.env[k];
  Object.assign(env, {
    HOME: fakeHome,
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
    XDG_DATA_HOME: join(fakeHome, '.local', 'share'),
    XDG_CACHE_HOME: join(fakeHome, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...(o.identity === false ? { GIT_CONFIG_GLOBAL: '/dev/null' } : {}),
    AOM_RUNNER_HOME: home,
    AOM_RUNNER_POLICY_DIR: policyDir,
    AOM_RUNNER_MOCK: '1',
    AOM_ALLOW_LOCAL_REMOTES: '1',
    AOM_MOCK_STEP_MS: process.env.AOM_MOCK_STEP_MS ?? '200',
    AOM_AGENT_TMP_ROOT: join(E2E_DIR, 'agent-tmp'),
    NODE_NO_WARNINGS: '1',
    ...(o.extraEnv ?? {}),
  });
  const child = spawn(
    process.execPath,
    [tsxCli(), join(ROOT, 'e2e', 'combined', 'support', 'scripted-runner-host.ts')],
    { env, stdio: ['ignore', 'pipe', out], detached: true, cwd: ROOT },
  );
  closeSync(out);
  recordHostPid(home, child.pid);
  const line = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`the runner host did not start; see ${logFile}`)), 60_000);
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(t);
        resolve(buf.slice(0, nl));
      }
    });
    child.once('exit', (c) => reject(new Error(`the runner host exited (${c}); see ${logFile}`)));
  });
  const info = JSON.parse(line) as { approvalsPort: number; error: string | null };
  if (info.error) throw new Error(`approvals page did not start: ${info.error}`);
  const ws = await waitFor(
    `workstation ${o.name} connected`,
    async () =>
      (await q<{ id: string; connected: boolean }>(`SELECT id, connected FROM workstations WHERE name=$1`, [
        o.name,
      ]).catch(() => [])) as Array<{ id: string; connected: boolean }>,
    (r) => r[0]?.connected === true,
    60_000,
  );
  const host: Host = {
    name: o.name,
    home,
    policyDir,
    gateDir: gateDirOf(home),
    workstationId: ws[0]?.id as string,
    approvalsPort: info.approvalsPort,
    child,
    logFile,
    writePolicy: write,
    async stop() {
      try {
        process.kill(-(child.pid as number), 'SIGTERM');
      } catch {
        /* gone */
      }
    },
  };
  return host;
}

export { release, waitReached };
