import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RUNNER_TOKEN_PREFIX } from '@aom/shared';
import { createPairingCode, pairRunner, unlinkWorkstationIn } from '../commands/workstations.ts';
import type { Ctx, SimulationHost } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { issueRotatedToken } from '../runner-gateway/rotation.ts';
import { SIMULATION_REPLIES } from './replies.ts';
import { createLocalOrigin } from './repos.ts';

const run = promisify(execFile);

/** The commit identity of the simulated workstation's owner: its runner has no personal git setup (backlog #65). */
export const SIMULATION_GIT_IDENTITY = { name: 'Simulation Owner', email: 'owner@simulation.example.test' };

/**
 * Writes the simulated workstation's global git config (the identity above) and returns the environment that makes the
 * runner and its git processes read it, instead of the server machine's own config. Without it a simulation project that
 * has no Commit-as is refused `no_commit_identity`.
 */
export function simulationGitEnv(dir: string): Record<string, string> {
  const file = join(dir, 'gitconfig');
  writeFileSync(
    file,
    `[user]\n\tname = ${SIMULATION_GIT_IDENTITY.name}\n\temail = ${SIMULATION_GIT_IDENTITY.email}\n`,
  );
  return { GIT_CONFIG_GLOBAL: file };
}

export type SimulationPaceName = 'fast' | 'normal' | 'slow';
/** How long each mock progress step and each chat word takes, per pace. */
export const PACES: Record<SimulationPaceName, { stepMs: number; chatTokenMs: number }> = {
  fast: { stepMs: 100, chatTokenMs: 5 },
  normal: { stepMs: 1500, chatTokenMs: 30 },
  slow: { stepMs: 5000, chatTokenMs: 60 },
};

export type SimulationState = 'running' | 'starting' | 'stopped' | 'unavailable';

interface OrgState {
  child: ChildProcess | null;
  /** The process should be running (the organization is a simulation). */
  wanted: boolean;
  pace: SimulationPaceName | null;
  restarts: number;
  timer: NodeJS.Timeout | null;
  state: SimulationState;
  detail: string;
}

/** The runner entry file: configured, unpacked from the release tarball, or built in the repository (dev). */
export async function resolveRunnerBin(ctx: Ctx): Promise<string | null> {
  const configured = ctx.config.simulationRunnerBin;
  if (configured) return existsSync(configured) ? configured : null;
  const base = ctx.config.simulationDir;
  const releaseDir = ctx.config.runnerReleaseDir;
  if (releaseDir && existsSync(releaseDir)) {
    const tgz = readdirSync(releaseDir)
      .filter((f) => /^aom-runner-.+\.tgz$/.test(f))
      .sort()
      .at(-1);
    if (tgz) {
      const target = join(base, '_runner', tgz.replace(/\.tgz$/, ''));
      const bin = join(target, 'aom-runner', 'dist', 'aom-runner.mjs');
      if (!existsSync(bin)) {
        mkdirSync(target, { recursive: true });
        try {
          await run('tar', ['-xzf', join(releaseDir, tgz), '-C', target]);
        } catch (err) {
          ctx.log.warn({ err: String(err) }, 'simulation: could not unpack the runner release');
        }
      }
      if (existsSync(bin)) return bin;
    }
  }
  // Development: apps/runner/dist next to the server sources (cwd is the repo root or apps/server).
  for (let dir = resolve(process.cwd()); ; dir = dirname(dir)) {
    const dev = join(dir, 'apps', 'runner', 'dist', 'aom-runner.mjs');
    if (existsSync(dev)) return dev;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The simulated workstations of simulation organizations (docs/RUNNER.md, "Simulated workstation"). For each simulation
 * organization the server pairs a workstation of the organization's Owner (no installer, no code to type), writes the
 * runner's config, and starts and supervises ONE runner child process: mock runtime only, scripted chat replies, its own
 * data directory and local throwaway repositories under `AOM_SIMULATION_DIR/<org id>`. The runner connects back to this
 * server like any other and the dispatcher, cards, reviews, tests, desk and finalize flow as for a real organization.
 */
export class SimulationHostImpl implements SimulationHost {
  private readonly orgs = new Map<string, OrgState>();
  private readonly queue = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly ctx: Ctx) {}

  orgDir = (orgId: string): string => join(this.ctx.config.simulationDir, orgId);
  originsDir = (orgId: string): string => join(this.orgDir(orgId), 'origin');

  private st(orgId: string): OrgState {
    let s = this.orgs.get(orgId);
    if (!s) {
      s = { child: null, wanted: false, pace: null, restarts: 0, timer: null, state: 'stopped', detail: '' };
      this.orgs.set(orgId, s);
    }
    return s;
  }

  /** What the platform page shows about an organization's simulated workstation. */
  status(orgId: string): { state: SimulationState; detail: string } {
    const s = this.orgs.get(orgId);
    return s ? { state: s.state, detail: s.detail } : { state: 'stopped', detail: '' };
  }

  /** Boot: start the simulated workstation of every simulation organization. */
  async start(): Promise<void> {
    const list = await rows<{ id: string }>(this.ctx.pool, 'SELECT id FROM organizations WHERE simulation');
    for (const o of list) this.reconcile(o.id);
  }

  reconcile(orgId: string): void {
    if (this.stopped) return;
    const prev = this.queue.get(orgId) ?? Promise.resolve();
    const next = prev
      .then(() => this.ensure(orgId))
      .catch((err) => {
        const s = this.st(orgId);
        s.state = 'unavailable';
        s.detail = `could not start: ${String(err)}`;
        this.ctx.log.error({ err: String(err), orgId }, 'simulation: reconcile failed');
      });
    this.queue.set(orgId, next);
  }

  /** Resolves when the queued work of the organization is done. */
  idle(orgId: string): Promise<void> {
    return this.queue.get(orgId) ?? Promise.resolve();
  }

  ready(orgId: string): Promise<void> {
    return this.idle(orgId);
  }

  /** A local throwaway origin for a repository added in this organization (whatever URL the user typed). */
  createOrigin(orgId: string, name: string): Promise<string> {
    return createLocalOrigin(this.originsDir(orgId), name);
  }

  async dispose(orgId: string): Promise<void> {
    const s = this.orgs.get(orgId);
    if (s) {
      s.wanted = false;
      await this.stopProcess(orgId);
    }
    this.orgs.delete(orgId);
    this.queue.delete(orgId);
    rmSync(this.orgDir(orgId), { recursive: true, force: true });
  }

  /** Server shutdown: stop every runner (they would only be reconnect-looping against a dead server). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.orgs.keys()]) {
      const s = this.orgs.get(id);
      if (s) s.wanted = false;
      await this.stopProcess(id);
    }
  }

  // ------------------------------------------------------------------------------------------------ internals

  private async ensure(orgId: string): Promise<void> {
    const s = this.st(orgId);
    const org = await one(
      this.ctx.pool,
      'SELECT id, simulation, simulation_pace, owner_user_id, status FROM organizations WHERE id=$1',
      [orgId],
    );
    if (!org || !org.simulation) {
      s.wanted = false;
      await this.stopProcess(orgId);
      if (org) await this.retireWorkstation(orgId);
      return;
    }
    if (!['trial', 'active'].includes(org.status)) {
      s.wanted = false;
      await this.stopProcess(orgId);
      s.state = 'stopped';
      s.detail = `the organization is ${org.status}`;
      return;
    }
    const pace = org.simulation_pace as SimulationPaceName;
    if (s.wanted && s.child && s.pace === pace) return; // already running as wanted
    s.wanted = true;
    if (s.child) await this.stopProcess(orgId); // pace changed: restart with the new speed
    s.wanted = true;
    s.pace = pace;
    s.state = 'starting';
    s.detail = '';

    const bin = await resolveRunnerBin(this.ctx);
    if (!bin) {
      s.state = 'unavailable';
      s.detail =
        'the runner program was not found (set AOM_SIMULATION_RUNNER_BIN, or AOM_RUNNER_RELEASE_DIR with the packaged runner)';
      this.ctx.log.warn({ orgId }, `simulation: ${s.detail}`);
      return;
    }

    const dir = this.orgDir(orgId);
    const home = join(dir, 'runner');
    const repos = join(dir, 'repos');
    for (const d of [home, repos, this.originsDir(orgId)]) mkdirSync(d, { recursive: true });
    this.killStale(dir);

    // Pair (first time) or take a fresh token (restart): the server pairs the Owner's simulated workstation itself.
    let ws = await one<{ id: string }>(
      this.ctx.pool,
      `SELECT id FROM workstations WHERE simulation_org_id=$1 AND status='active' ORDER BY paired_at LIMIT 1`,
      [orgId],
    );
    let token: string;
    if (!ws) {
      const code = await createPairingCode(this.ctx, { id: org.owner_user_id } as never, { ttlMs: 60_000 });
      const paired = await pairRunner(this.ctx, {
        code: code.code,
        name: 'Simulated workstation',
        platform: 'linux',
        hostname: 'guildwise-simulation',
        runnerVersion: '0.0.0-simulation',
        simulationOrgId: orgId,
      });
      ws = { id: paired.workstationId };
      token = paired.runnerToken;
    } else token = await issueRotatedToken(this.ctx, ws.id);
    if (!token.startsWith(RUNNER_TOKEN_PREFIX)) throw new Error('unexpected runner token');

    const serverUrl = this.ctx.config.simulationServerUrl ?? `http://127.0.0.1:${this.ctx.config.port}`;
    const cfgFile = join(home, 'config.json');
    writeFileSync(
      cfgFile,
      JSON.stringify(
        {
          serverUrl,
          workstationId: ws.id,
          runnerToken: token,
          repoRoots: [repos],
          runtimes: { mock: { enabled: true } },
        },
        null,
        2,
      ),
    );
    chmodSync(cfgFile, 0o600);
    const repliesFile = join(dir, 'replies.json');
    writeFileSync(repliesFile, JSON.stringify(SIMULATION_REPLIES));
    this.spawnRunner(orgId, bin, home, repliesFile);
  }

  private spawnRunner(orgId: string, bin: string, home: string, repliesFile: string): void {
    const s = this.st(orgId);
    const pace = PACES[s.pace ?? 'normal'];
    const logFile = join(this.orgDir(orgId), 'runner.out.log');
    const out = openSync(logFile, 'a');
    const child = spawn(process.execPath, [bin, 'start', '--mock', '--data-dir', home], {
      env: {
        ...process.env,
        AOM_RUNNER_MOCK: '1',
        // The only remotes are the local throwaway repositories of this simulation.
        AOM_ALLOW_LOCAL_REMOTES: '1',
        AOM_RUNNER_HOME: home,
        ...simulationGitEnv(this.orgDir(orgId)),
        AOM_MOCK_STEP_MS: String(pace.stepMs),
        AOM_MOCK_CHAT_TOKEN_MS: String(pace.chatTokenMs),
        AOM_MOCK_REPLIES_FILE: repliesFile,
        // Nothing here may reach a real forge or model.
        ANTHROPIC_API_KEY: '',
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      },
      stdio: ['ignore', out, out],
      detached: true,
    });
    closeSync(out);
    s.child = child;
    s.state = 'running';
    s.detail = '';
    if (child.pid) writeFileSync(join(this.orgDir(orgId), 'runner.pid'), String(child.pid));
    child.on('exit', (code, signal) => {
      if (s.child !== child) return;
      s.child = null;
      if (!s.wanted || this.stopped) {
        s.state = 'stopped';
        return;
      }
      s.restarts++;
      s.state = 'starting';
      s.detail = `the simulated runner stopped (${signal ?? code}); restarting`;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(s.restarts, 5));
      s.timer = setTimeout(() => {
        s.timer = null;
        if (s.wanted && !this.stopped) this.reconcileAgain(orgId);
      }, delay);
      s.timer.unref();
    });
    child.on('error', (err) => {
      s.state = 'unavailable';
      s.detail = `could not start the runner: ${String(err)}`;
    });
  }

  /** A restart after a crash: forget the dead process so `ensure` starts a fresh one. */
  private reconcileAgain(orgId: string): void {
    const s = this.st(orgId);
    s.pace = null;
    this.reconcile(orgId);
  }

  private async stopProcess(orgId: string): Promise<void> {
    const s = this.orgs.get(orgId);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const child = s.child;
    s.child = null;
    s.pace = null;
    if (!child?.pid) return;
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => resolveExit());
      setTimeout(resolveExit, 5000).unref();
    });
    signalGroup(child.pid, 'SIGTERM');
    await exited;
    signalGroup(child.pid, 'SIGKILL'); // anything of the group still alive (a mock agent)
    s.state = 'stopped';
  }

  /** A runner left over from a server that crashed: its process group is stopped before a new one starts. */
  private killStale(dir: string): void {
    const pidFile = join(dir, 'runner.pid');
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      // Only a process that still is our runner (pids are reused after a reboot).
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (pid > 1 && cmd.includes('aom-runner')) signalGroup(pid, 'SIGKILL');
    } catch {
      /* no stale runner */
    }
  }

  /** Simulation turned off: the simulated workstation is unlinked (its agents need a real one) and its files go. */
  private async retireWorkstation(orgId: string): Promise<void> {
    const list = await rows<{ id: string; user_id: string }>(
      this.ctx.pool,
      `SELECT id, user_id FROM workstations WHERE simulation_org_id=$1 AND status='active'`,
      [orgId],
    );
    for (const w of list)
      await withAppendTx(this.ctx.pool, (tx) =>
        unlinkWorkstationIn(this.ctx, tx, w.user_id, w.id, w.user_id, 'owner'),
      );
    rmSync(join(this.orgDir(orgId), 'runner'), { recursive: true, force: true });
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
