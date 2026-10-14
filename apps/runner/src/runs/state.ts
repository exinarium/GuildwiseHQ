import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEndReason, RunEnvState, RunPurpose, RunService, RunServiceState } from '@aom/shared';

/** What the runner keeps of a run environment, in `<data dir>/runs/<envId>/state.json` (survives a runner restart). */

export interface ServicePortState {
  name: string;
  port: number;
  wanted: number;
  url?: string;
}

export interface ServiceState {
  def: RunService;
  state: RunServiceState;
  ports: ServicePortState[];
  pid?: number;
  /** The kernel start time of `pid`: with the pid it identifies the process after a runner restart. */
  startTime?: string | null;
  restarts: number;
  exitCode?: number | null;
  lastError?: string;
  health: 'unknown' | 'passing' | 'failing' | 'none';
  everHealthy: boolean;
  startedAt?: number;
}

export interface StepState {
  name: string;
  repoId: string;
  cwd: string;
  cmd: string[];
  timeoutSec: number;
  when: string;
  status: 'running' | 'ok' | 'failed';
  exitCode?: number | null;
  startedAt: number;
  finishedAt?: number;
  logFile: string;
}

export interface SourceState {
  repoId: string;
  name: string;
  remoteUrlNormalized: string;
  branch: string;
  projectPath?: string;
  /** The run worktree (a directory of its own; detached HEAD, no branch created). */
  path: string;
  commit: string | null;
}

export interface EnvState {
  envId: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  purpose: RunPurpose;
  requestId: string | null;
  sources: SourceState[];
  wanted: string[];
  portRange: { from: number; to: number };
  ttlAt: string;
  allowDocker: boolean;
  state: RunEnvState;
  activity?: string;
  error?: string;
  endReason?: RunEndReason;
  /** The final state was sent to the server (an unsent one is resent after the next welcome). */
  reportedFinal: boolean;
  services: ServiceState[];
  steps: StepState[];
  readyAt?: number;
  notes?: string;
  buildHash?: string;
  createdAt: number;
  endedAt?: number;
}

export const LIVE_ENV_STATES: readonly RunEnvState[] = [
  'requested',
  'preparing',
  'starting',
  'healthy',
  'degraded',
  'stopping',
];
export const isLiveEnv = (e: Pick<EnvState, 'state'>): boolean => LIVE_ENV_STATES.includes(e.state);

export class RunStore {
  constructor(private readonly root: string) {}

  dir(envId: string): string {
    return join(this.root, envId);
  }

  ensureDir(envId: string): string {
    const d = this.dir(envId);
    mkdirSync(join(d, 'steps'), { recursive: true, mode: 0o700 });
    return d;
  }

  save(env: EnvState): void {
    const d = this.ensureDir(env.envId);
    const tmp = join(d, `state.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, join(d, 'state.json'));
  }

  loadAll(): EnvState[] {
    if (!existsSync(this.root)) return [];
    const out: EnvState[] = [];
    for (const id of readdirSync(this.root)) {
      try {
        const env = JSON.parse(readFileSync(join(this.root, id, 'state.json'), 'utf8')) as EnvState;
        if (env && typeof env.envId === 'string') out.push(env);
      } catch {
        // not an environment folder, or a corrupt file
      }
    }
    return out;
  }

  remove(envId: string): void {
    rmSync(this.dir(envId), { recursive: true, force: true });
  }
}
