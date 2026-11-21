import { delimiter, join } from 'node:path';
import type { Policy } from './schema.ts';

/**
 * The runner's Docker (DESIGN deps-without-sudo §3), applied to the runner's own environment in `start()` before
 * RunnerHost exists, so every docker step it launches (DevOps, test services opted into Docker) reaches the daemon the
 * policy names and nothing else:
 *   rootless  DOCKER_HOST = the runner's own socket under /run/user/<uid>, and the root-owned binaries first on PATH
 *   host      DOCKER_HOST from policy.json `dockerHost` (a Mac's Docker Desktop socket), else the default socket
 *   shared    DOCKER_HOST = the shared daemon's socket from policy.json
 *   none      DOCKER_HOST is removed (an inherited value never picks a daemon)
 * The start-up check reads the inherited DOCKER_HOST before this runs (see cli.ts start()).
 */
export function dockerEnvFor(
  policy: Pick<Policy, 'docker'> & Partial<Pick<Policy, 'dockerHost'>>,
  uid: number | null,
  adminDir: string,
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (policy.docker === 'rootless' && uid !== null) {
    out.DOCKER_HOST = `unix:///run/user/${uid}/docker.sock`;
    const bin = join(adminDir, 'docker');
    const rest = (env.PATH ?? '').split(delimiter).filter((p) => p && p !== bin);
    out.PATH = [bin, ...rest].join(delimiter);
    out.DOCKER_CLI_PLUGIN_EXTRA_DIRS = join(bin, 'cli-plugins');
    out.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  } else if ((policy.docker === 'host' || policy.docker === 'shared') && policy.dockerHost) {
    out.DOCKER_HOST = policy.dockerHost;
  } else if (policy.docker !== 'host') {
    out.DOCKER_HOST = undefined;
  }
  return out;
}

/** Applies `dockerEnvFor` to `env` (process.env by default). */
export function applyDockerEnv(
  policy: Pick<Policy, 'docker'> & Partial<Pick<Policy, 'dockerHost'>>,
  uid: number | null,
  adminDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [k, v] of Object.entries(dockerEnvFor(policy, uid, adminDir, env))) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}
