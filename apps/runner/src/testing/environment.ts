import { existsSync, readFileSync } from 'node:fs';
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
  fetch?: typeof fetch;
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

/** The file the earlier versions read the health URL from. Retired (D12): the run plan holds it now. */
export const LEGACY_ENV_FILE = join('.aom', 'test-env.json');

/**
 * `.aom/test-env.json` is a Guildwise trace in the user's repository (docs/design/run-and-integration-tests.md D12). It is
 * still read in this version (a deprecation note says so) and ignored in the next; a shift with a test environment never
 * reads it. Returns the note when the file exists.
 */
export function legacyEnvFileNote(worktree: string): string | null {
  return existsSync(join(worktree, LEGACY_ENV_FILE))
    ? `${LEGACY_ENV_FILE} is deprecated: the health check now comes from the project's run plan (Project settings > Run & test). The file is still read in this version and ignored in the next; it can be deleted from the repository.`
    : null;
}

/**
 * Real check: Docker answers (`docker info`) and, when the repository declares one in `.aom/test-env.json`
 * (`{"healthUrl": "http://localhost:3000/health"}`; deprecated, optional), the deployed application answers with a 2xx.
 */
export function defaultEnvChecker(opts: DefaultCheckerOptions = {}): EnvChecker {
  return async (input) => {
    if (input.msg.agent.runtime === 'mock') return mockEnvProblem(input);
    const docker = await (opts.dockerOk ?? probeDocker)();
    if (!docker.ok) return { problem: 'docker_missing', detail: docker.detail };
    const file = input.worktree ? join(input.worktree, '.aom', 'test-env.json') : null;
    if (!file || !existsSync(file)) return null;
    let url: string | undefined;
    try {
      url = (JSON.parse(readFileSync(file, 'utf8')) as { healthUrl?: string }).healthUrl;
    } catch {
      return null;
    }
    if (!url) return null;
    try {
      const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(5000) });
      return res.ok ? null : { problem: 'app_not_deployed', detail: `${url} answered ${res.status}` };
    } catch (err) {
      return {
        problem: 'app_not_deployed',
        detail: `${url}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
