import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerToRunnerOf, TestEnvProblem } from '@aom/shared';
import { execa } from 'execa';
import type { RunnerPaths } from '../paths.ts';

type ShiftStartMsg = ServerToRunnerOf<'shift.start'>;

export interface EnvProblem {
  problem: TestEnvProblem;
  detail: string;
}

export interface EnvCheckInput {
  msg: ShiftStartMsg;
  /** The card worktree (null for shifts without one). */
  worktree: string | null;
  paths: RunnerPaths;
}

/** Returns what is wrong with the test environment, or null when a tester can start. */
export type EnvChecker = (input: EnvCheckInput) => Promise<EnvProblem | null>;

/** Only testers actioning a card need the application and Docker (spec "Test environment"). */
export const needsTestEnvironment = (msg: ShiftStartMsg): boolean =>
  msg.kind === 'card' && msg.agent.roleKey === 'tester' && !msg.agent.isDevops;

/**
 * Mock runtime (CI, E2E): the card's `mockEnv` field names a problem that persists until the mock DevOps engineer
 * marked it fixed (`<mockState>/env-ok-<problem>`). Deterministic, touches no Docker.
 */
export function mockEnvProblem(input: EnvCheckInput): EnvProblem | null {
  const want = input.msg.brief.card.fields.mockEnv;
  if (want !== 'app_not_deployed' && want !== 'docker_missing') return null;
  if (existsSync(join(input.paths.mockState, `env-ok-${want}`))) return null;
  return {
    problem: want,
    detail:
      want === 'docker_missing' ? 'mock: docker is not installed' : 'mock: the application is not running',
  };
}

export interface DefaultCheckerOptions {
  /** Docker probe; default `docker info`. */
  dockerOk?: () => Promise<{ ok: boolean; detail: string }>;
}

async function probeDocker(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await execa('docker', ['info', '--format', '{{.ServerVersion}}'], {
      reject: false,
      stdin: 'ignore',
      timeout: 15_000,
    });
    if (r.exitCode === 0) return { ok: true, detail: '' };
    return {
      ok: false,
      detail: String(r.stderr || r.stdout || 'docker info failed')
        .trim()
        .slice(0, 300),
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Real check: Docker answers (`docker info`). The health URL of the application comes from the run plan. */
export function defaultEnvChecker(opts: DefaultCheckerOptions = {}): EnvChecker {
  return async (input) => {
    if (input.msg.agent.runtime === 'mock') return mockEnvProblem(input);
    const docker = await (opts.dockerOk ?? probeDocker)();
    if (!docker.ok) return { problem: 'docker_missing', detail: docker.detail };
    return null;
  };
}
