import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { BASE_URL, E2E_DIR, paths, ROOT } from '../../support/env.ts';
import { addRepoRoot, pairRunner } from '../../support/runner.ts';
import { devopsAgentOf, pairingCode } from './flow.ts';
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

/**
 * runner-bare-bin [A11]: a host that runs a REAL runtime in the runner-built box must look like an installed runner from inside
 * that box: `aom` (the runner's bin shim and the guard hook) is the standalone bundle `aom.mjs` next to the runner code, the only
 * runner folder the box mounts (read-only). Under tsx the shim would start tsx and the TypeScript sources, which the box does
 * not mount. So this host is bundled (esbuild, the runner's own dependencies external, resolved from apps/runner/node_modules)
 * into a folder that also holds the build's `aom.mjs`, `mock-agent.mjs` and assets, exactly the layout of `dist/`.
 */
function bundledHost(): string {
  const runner = join(ROOT, 'apps', 'runner');
  const out = join(runner, 'node_modules', '.cache', 'aom-box-host');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const dist = join(runner, 'dist');
  for (const f of readdirSync(dist))
    if (f !== 'aom-runner.mjs') cpSync(join(dist, f), join(out, f), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(runner, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter(
    (d) => d !== '@aom/shared',
  );
  const tsup = createRequire(join(runner, 'package.json')).resolve('tsup/package.json');
  const esbuild = createRequire(tsup)('esbuild') as {
    buildSync: (o: Record<string, unknown>) => unknown;
  };
  esbuild.buildSync({
    entryPoints: [join(ROOT, 'e2e', 'combined', 'support', 'scripted-runner-host.ts')],
    outfile: join(out, 'host.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: [...external, ...external.map((d) => `${d}/*`)],
    banner: {
      js: "import { createRequire as __aomCreateRequire } from 'node:module'; const require = __aomCreateRequire(import.meta.url);",
    },
    logLevel: 'error',
  });
  return join(out, 'host.mjs');
}

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
    /** Grant the workstation's DevOps engineer locally (default). The grant is written BEFORE the first start so the runner seals it. */
    grant?: boolean;
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
  // The runner SEALS policy.json at its first start (it adopts what is there once); later plain writes are tamper and are
  // ignored. So everything the policy must say is written here, before the start, the DevOps grant included; after the start only the
  // approvals page changes it (ApprovalsPage.change).
  let grant: { orgId: string; agentId: string } | undefined;
  if (o.grant !== false) {
    const wsRow = await waitFor(
      `workstation ${o.name} row`,
      () => q<{ id: string }>(`SELECT id FROM workstations WHERE name=$1`, [o.name]),
      (r) => r.length === 1,
      30_000,
    );
    grant = await devopsAgentOf(wsRow[0]?.id as string);
  }
  write({ ...(o.policy ?? {}), ...(grant ? { grant } : {}) });
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
    o.extraEnv?.AOM_COMBINED_CLAUDE_BOX === '1'
      ? [bundledHost()]
      : [tsxCli(), join(ROOT, 'e2e', 'combined', 'support', 'scripted-runner-host.ts')],
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

/** What the scripted runtime says about the DevOps safety box (see ScenarioAdapter.boxMissing); read on every shift start. */
export function setBoxState(h: { gateDir: string }, state: 'ok' | 'none' | `broken:${string}`): void {
  const f = join(h.gateDir, 'box-state');
  if (state === 'ok') rmSync(f, { force: true });
  else writeFileSync(f, state);
}

/**
 * Runs the REAL `guildwise-runner` CLI (apps/runner/dist/aom-runner.mjs) against this host's folders, the way the person at the
 * machine does: in a terminal (a pty from `script`, because the approving commands refuse to run without one) with `answers`
 * typed. Same environment rules as the host: the allowlist, a fake HOME, the host's data and policy folders.
 */
export function runnerCli(
  h: { home: string; policyDir: string; name: string },
  args: string[],
  answers: string[] = [],
): { out: string; code: number } {
  const fakeHome = join(E2E_DIR, `home-${h.name}`);
  const env: NodeJS.ProcessEnv = {};
  for (const k of HOST_ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    HOME: fakeHome,
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
    AOM_RUNNER_HOME: h.home,
    AOM_RUNNER_POLICY_DIR: h.policyDir,
    AOM_RUNNER_MOCK: '1',
    NO_COLOR: '1',
  });
  const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
  const cmd = [process.execPath, paths.runnerBin, ...args].map(quote).join(' ');
  const r = spawnSync('script', ['-qec', cmd, '/dev/null'], {
    env,
    input: answers.map((a) => `${a}\n`).join(''),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\r/g, ''), code: r.status ?? 1 };
}
