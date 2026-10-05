#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { resolve } from 'node:path';
import { RunnerPairRequestSchema, RunnerPairResponseSchema } from '@aom/shared';
import { Command } from 'commander';
import { execa } from 'execa';
import { sandboxDoctorLines, sandboxState } from './adapters/claude-policy.ts';
import { applyOverrides, loadConfig, type RunnerConfig, RunnerConfigSchema, saveConfig } from './config.ts';
import { toWsUrl } from './connection/client.ts';
import { requestRotatedToken } from './connection/rotate.ts';
import { gitVersion } from './git/git.ts';
import { scanRepos } from './git/repo-scan.ts';
import { createLogger } from './log.ts';
import { resolveDataDir, runnerPaths } from './paths.ts';
import { Runner } from './runner.ts';
import { RUNNER_VERSION } from './version.ts';

const dataDirOpt = [
  '--data-dir <path>',
  'runner data directory (default: $AOM_RUNNER_HOME or ~/.aom-runner)',
] as const;
const mockEnabled = (flag?: boolean) => flag === true || process.env.AOM_RUNNER_MOCK === '1';

async function pair(opts: {
  server: string;
  code: string;
  name?: string;
  dataDir?: string;
  mock?: boolean;
}): Promise<void> {
  const paths = runnerPaths(resolveDataDir(opts.dataDir));
  const body = RunnerPairRequestSchema.parse({
    code: opts.code,
    name: opts.name ?? hostname(),
    platform: platform(),
    hostname: hostname(),
    runnerVersion: RUNNER_VERSION,
  });
  const url = new URL('/api/runner/pair', opts.server).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pairing failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const paired = RunnerPairResponseSchema.parse(await res.json());
  let previous: Partial<RunnerConfig> = {};
  if (existsSync(paths.config)) {
    try {
      previous = loadConfig(paths.config);
    } catch {
      // overwritten below
    }
  }
  const config = RunnerConfigSchema.parse({
    ...previous,
    serverUrl: opts.server.replace(/\/+$/, ''),
    workstationId: paired.workstationId,
    runnerToken: paired.runnerToken,
    runtimes: {
      ...(previous.runtimes ?? {}),
      ...(mockEnabled(opts.mock) ? { mock: { ...(previous.runtimes?.mock ?? {}), enabled: true } } : {}),
    },
  });
  saveConfig(paths.config, config);
  console.log(
    `Paired as workstation ${paired.workstationId}. Config written to ${paths.config} (mode 0600).`,
  );
  console.log('Next: `aom-runner repos add <path>` for your code folders, then `aom-runner start`.');
}

async function start(opts: { dataDir?: string; mock?: boolean }): Promise<void> {
  const paths = runnerPaths(resolveDataDir(opts.dataDir));
  const config = applyOverrides(loadConfig(paths.config), { mock: mockEnabled(opts.mock) });
  const log = createLogger(paths.runnerLog);
  const override = process.env.AOM_RUNNER_MAX_SHIFT_MS
    ? Number(process.env.AOM_RUNNER_MAX_SHIFT_MS)
    : undefined;
  const runner = new Runner({ config, dataDir: paths.root, log, maxShiftMsOverride: override });
  await runner.start();
  log.info(
    `aom-runner ${RUNNER_VERSION} started (workstation ${config.workstationId}, server ${config.serverUrl})`,
  );

  const code = await new Promise<number>((done) => {
    const shutdown = (sig: string) => {
      log.info(`${sig} received, shutting down`);
      done(0);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    void runner.fatal.then(done);
  });
  await runner.stop();
  process.exit(code);
}

function status(opts: { dataDir?: string }): void {
  const paths = runnerPaths(resolveDataDir(opts.dataDir));
  const config = loadConfig(paths.config);
  console.log(`data dir:     ${paths.root}`);
  console.log(`server:       ${config.serverUrl}`);
  console.log(`workstation:  ${config.workstationId}`);
  console.log(`repo roots:   ${config.repoRoots.join(', ') || '(none; use `aom-runner repos add <path>`)'}`);
  console.log(`mock runtime: ${config.runtimes.mock?.enabled ? 'enabled' : 'disabled'}`);
  if (existsSync(paths.status)) {
    const s = JSON.parse(readFileSync(paths.status, 'utf8')) as {
      pid: number;
      connected: boolean;
      updatedAt: string;
      activeShifts: number;
      outboxPending: number;
    };
    let alive = false;
    try {
      process.kill(s.pid, 0);
      alive = true;
    } catch {
      // not running
    }
    console.log(
      alive
        ? `process:      running (pid ${s.pid}), ${s.connected ? 'connected' : 'not connected'}, ${s.activeShifts} active shifts, ${s.outboxPending} outbox entries`
        : 'process:      not running',
    );
  } else console.log('process:      not running');
}

async function doctor(opts: { dataDir?: string }): Promise<void> {
  const paths = runnerPaths(resolveDataDir(opts.dataDir));
  let failed = false;
  const line = (ok: boolean | 'warn', name: string, detail: string) => {
    if (ok === false) failed = true;
    console.log(`${ok === true ? 'ok  ' : ok === 'warn' ? 'warn' : 'FAIL'}  ${name}: ${detail}`);
  };
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line(nodeMajor >= 22, 'node', process.version);
  const g = await gitVersion();
  line(
    !!g && (g.major > 2 || (g.major === 2 && g.minor >= 40)),
    'git',
    g ? `${g.raw} (need >= 2.40)` : 'not found',
  );

  let config: RunnerConfig | undefined;
  try {
    config = loadConfig(paths.config);
    line(true, 'config', paths.config);
  } catch (err) {
    line(false, 'config', err instanceof Error ? err.message : String(err));
  }
  const claudeBin = config?.runtimes['claude-code'].bin ?? 'claude';
  const c = await execa(claudeBin, ['--version'], { reject: false, stdin: 'ignore', timeout: 10_000 }).catch(
    () => undefined,
  );
  line(
    c && c.exitCode === 0 ? true : 'warn',
    'claude',
    c && c.exitCode === 0
      ? String(c.stdout).trim()
      : `\`${claudeBin}\` not found (only needed for the claude-code runtime)`,
  );
  const sbCfg = config?.runtimes['claude-code'] ?? RunnerConfigSchema.shape.runtimes.parse({})['claude-code'];
  for (const l of sandboxDoctorLines(sandboxState(sbCfg), platform())) line(l.ok, l.name, l.detail);
  const d = await execa('docker', ['--version'], { reject: false, stdin: 'ignore', timeout: 10_000 }).catch(
    () => undefined,
  );
  line(
    d && d.exitCode === 0 ? true : 'warn',
    'docker',
    d && d.exitCode === 0 ? String(d.stdout).trim() : 'not found (optional)',
  );
  const y = await execa('yt-dlp', ['--version'], { reject: false, stdin: 'ignore', timeout: 10_000 }).catch(
    () => undefined,
  );
  line(
    y && y.exitCode === 0 ? true : 'warn',
    'yt-dlp',
    y && y.exitCode === 0
      ? String(y.stdout).trim()
      : 'not found (optional: `aom transcript` needs it for YouTube and other video sites; ask DevOps to install it)',
  );
  if (config) {
    const repos = await scanRepos(config.repoRoots);
    line(
      repos.length > 0 ? true : 'warn',
      'repos',
      `${repos.length} found under ${config.repoRoots.length} root(s)`,
    );
    try {
      const res = await fetch(new URL('/api/health', config.serverUrl), {
        signal: AbortSignal.timeout(8000),
      });
      line(res.ok, 'server', `${config.serverUrl} /api/health -> HTTP ${res.status}`);
    } catch (err) {
      line(
        false,
        'server',
        `${config.serverUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (failed) process.exitCode = 1;
}

function runnerAlive(statusFile: string): boolean {
  if (!existsSync(statusFile)) return false;
  try {
    process.kill((JSON.parse(readFileSync(statusFile, 'utf8')) as { pid: number }).pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Replaces the runner token. The runner must be stopped: a second connection would supersede the running one. */
async function rotateToken(opts: { dataDir?: string }): Promise<void> {
  const paths = runnerPaths(resolveDataDir(opts.dataDir));
  const config = loadConfig(paths.config);
  if (runnerAlive(paths.status))
    throw new Error(
      'the runner is running: stop it first (`aom-runner rotate-token` replaces its credentials)',
    );
  const token = await requestRotatedToken({ url: toWsUrl(config.serverUrl), token: config.runnerToken });
  saveConfig(paths.config, { ...config, runnerToken: token });
  console.log(
    `Runner token rotated. The new token is stored in ${paths.config} (mode 0600); start the runner again.`,
  );
}

function reposAdd(path: string, opts: { dataDir?: string }): void {
  const paths = runnerPaths(resolveDataDir(opts.dataDir));
  const config = loadConfig(paths.config);
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`${abs} does not exist`);
  if (!config.repoRoots.includes(abs)) config.repoRoots.push(abs);
  saveConfig(paths.config, config);
  console.log(`Added ${abs}. Restart is not needed: repos are re-scanned on connect and every 10 minutes.`);
}

async function reposList(opts: { dataDir?: string }): Promise<void> {
  const config = loadConfig(runnerPaths(resolveDataDir(opts.dataDir)).config);
  const repos = await scanRepos(config.repoRoots);
  if (repos.length === 0)
    console.log('No repositories found. Add a folder with `aom-runner repos add <path>`.');
  for (const r of repos) console.log(`${r.localPath}\t${r.remoteUrl}\t${r.headBranch ?? '(detached)'}`);
}

export function buildProgram(): Command {
  const program = new Command('aom-runner').description('Agent Org Manager runner').version(RUNNER_VERSION);
  program
    .command('pair')
    .description('pair this machine with the server using a code from the Workstations page')
    .requiredOption('--server <url>', 'server URL, e.g. https://aom.example.com')
    .requiredOption('--code <code>', 'pairing code XXXX-XXXX')
    .option('--name <name>', 'workstation name (default: hostname)')
    .option('--mock', 'enable the mock runtime (CI and development)')
    .option(...dataDirOpt)
    .action(pair);
  program
    .command('start')
    .description('connect to the server and run shifts (foreground)')
    .option('--mock', 'enable the mock runtime for this process (also AOM_RUNNER_MOCK=1)')
    .option(...dataDirOpt)
    .action(start);
  program
    .command('status')
    .description('show configuration and process state')
    .option(...dataDirOpt)
    .action(status);
  program
    .command('doctor')
    .description('check git, node, claude, docker and server connectivity')
    .option(...dataDirOpt)
    .action(doctor);
  program
    .command('rotate-token')
    .description('replace the runner token with a freshly issued one (stop the runner first)')
    .option(...dataDirOpt)
    .action(rotateToken);
  const repos = program.command('repos').description('manage the folders scanned for git repositories');
  repos
    .command('add <path>')
    .option(...dataDirOpt)
    .action(reposAdd);
  repos
    .command('list')
    .option(...dataDirOpt)
    .action(reposList);
  return program;
}

// `pnpm run dev -- --data-dir x` forwards the literal `--`; drop it so the options still parse.
const argv = [...process.argv];
const dashdash = argv.indexOf('--');
if (dashdash > 1) argv.splice(dashdash, 1);

buildProgram()
  .parseAsync(argv)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
