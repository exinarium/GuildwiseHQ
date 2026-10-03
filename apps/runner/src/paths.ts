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
  bin: string;
  agents: string;
  worktrees: string;
  integration: string;
  vaults: string;
  logs: string;
  shiftLogs: string;
  runnerLog: string;
  status: string;
  mockState: string;
  agentDir(agentId: string): string;
  worktreePath(projectKey: string, cardRef: string): string;
}

export function runnerPaths(root: string): RunnerPaths {
  return {
    root,
    config: join(root, 'config.json'),
    outbox: join(root, 'outbox'),
    bin: join(root, 'bin'),
    agents: join(root, 'agents'),
    worktrees: join(root, 'worktrees'),
    integration: join(root, 'integration'),
    vaults: join(root, 'vaults'),
    logs: join(root, 'logs'),
    shiftLogs: join(root, 'logs', 'shifts'),
    runnerLog: join(root, 'logs', 'runner.log'),
    status: join(root, 'status.json'),
    mockState: join(root, 'mock-state'),
    agentDir: (agentId) => join(root, 'agents', agentId),
    worktreePath: (projectKey, cardRef) => join(root, 'worktrees', projectKey, cardRef),
  };
}
