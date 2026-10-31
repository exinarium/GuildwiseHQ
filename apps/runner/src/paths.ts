import { homedir } from 'node:os';
import { join } from 'node:path';

/** Data dir: `--data-dir` flag, then `AOM_RUNNER_HOME`, then `~/.aom-runner` (Windows `%LOCALAPPDATA%\aom-runner`). */
export function resolveDataDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (flag) return flag;
  if (env.AOM_RUNNER_HOME) return env.AOM_RUNNER_HOME;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'aom-runner');
  return join(homedir(), '.aom-runner');
}

export interface RunnerPaths {
  root: string;
  config: string;
  outbox: string;
  /** M8: one record per outbound draft posted from this workstation (never post twice). */
  outbound: string;
  bin: string;
  agents: string;
  worktrees: string;
  integration: string;
  vaults: string;
  logs: string;
  /** Full logs of environment preparation (`env.ensure`), one file per project. */
  envLogs: string;
  /** Keys and the stored sudo password (mode 0600/0700, never read by agents: sandboxes deny the data dir). */
  secrets: string;
  shiftLogs: string;
  runnerLog: string;
  status: string;
  mockState: string;
  /** Persisted `shift.start` messages of running shifts, so a restarted runner can resume them. */
  activeShifts: string;
  /** Toolchains the DevOps engineer registered for the agents (`aom toolchain add`), mode 0600. */
  toolchains: string;
  /** The project graph's runner-local cache: parsed facts per file, and the shards of a repository too big for the vault. */
  graphCache: string;
  /** Cloned capability packs (`packs/<packId>/repo`) and their state (docs/ARCHITECTURE.md section 38.4). */
  packs: string;
  /** Inbound relay: events handed to the `generic` handler (`relay/inbox/<integrationId>/`). Denied to agent sandboxes like the rest of the data dir. */
  relay: string;
  agentDir(agentId: string): string;
  /**
   * Default worktree location. Project keys are only unique per organization, so the project id (first 8 hex
   * digits) is part of the directory name; without it (old callers) the legacy `<KEY>/<REF>` path is returned.
   */
  worktreePath(projectKey: string, cardRef: string, projectId?: string): string;
}

export function runnerPaths(root: string): RunnerPaths {
  return {
    root,
    config: join(root, 'config.json'),
    outbox: join(root, 'outbox'),
    outbound: join(root, 'outbound'),
    bin: join(root, 'bin'),
    agents: join(root, 'agents'),
    worktrees: join(root, 'worktrees'),
    integration: join(root, 'integration'),
    vaults: join(root, 'vaults'),
    logs: join(root, 'logs'),
    envLogs: join(root, 'logs', 'env'),
    secrets: join(root, 'secrets'),
    shiftLogs: join(root, 'logs', 'shifts'),
    runnerLog: join(root, 'logs', 'runner.log'),
    status: join(root, 'status.json'),
    mockState: join(root, 'mock-state'),
    activeShifts: join(root, 'active-shifts'),
    toolchains: join(root, 'toolchains.json'),
    graphCache: join(root, 'graph-cache'),
    packs: join(root, 'packs'),
    relay: join(root, 'relay'),
    agentDir: (agentId) => join(root, 'agents', agentId),
    worktreePath: (projectKey, cardRef, projectId) =>
      join(root, 'worktrees', projectId ? `${projectKey}-${projectId.slice(0, 8)}` : projectKey, cardRef),
  };
}
