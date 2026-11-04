import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { E2E_DIR, JOURNEY_PORTS, ROOT } from './env.ts';

/** The throwaway registry and sshd "server" of the deploy-setup journey, started and removed by the setup/teardown projects. */
export const JOURNEY_IMAGE = 'aom-test-sshd:1';
export const JOURNEY_STATE = join(E2E_DIR, 'journey-containers.json');
export const NAME_PREFIX = 'aom-e2e-journey-';

export type JourneyState = {
  registry: string;
  box: string;
  regPort: number;
  sshPort: number;
  httpPort: number;
  shopPort: number;
};

export type DockerFn = (...args: string[]) => string;

export const realDocker: DockerFn = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }).trim();

export const NO_DOCKER_MESSAGE =
  'Docker is not reachable here. Tester shifts have no Docker: DevOps runs the Docker projects (README "Docker projects")';

export function registryArgs(name: string, regPort: number): string[] {
  return [
    'run', '-d', '--rm', '--name', name,
    '-p', `127.0.0.1:${regPort}:5000`,
    '-p', `172.17.0.1:${regPort}:5000`,
    'registry:2',
  ];
}

export function boxArgs(name: string, p: { sshPort: number; httpPort: number; shopPort: number }): string[] {
  return [
    'run', '-d', '--rm', '--name', name,
    '-p', `127.0.0.1:${p.sshPort}:22`,
    '-p', `127.0.0.1:${p.httpPort}:5500`,
    '-p', `127.0.0.1:${p.shopPort}:8090`,
    JOURNEY_IMAGE,
  ];
}

export function startJourneyContainers(docker: DockerFn = realDocker, stateFile = JOURNEY_STATE): JourneyState {
  try {
    execDockerVersion(docker);
  } catch {
    throw new Error(NO_DOCKER_MESSAGE);
  }
  // leftovers of an earlier run with the same name prefix
  for (const n of docker('ps', '-a', '--filter', `name=${NAME_PREFIX}`, '--format', '{{.Names}}').split('\n')) {
    if (n.trim()) docker('rm', '-f', n.trim());
  }
  const id = `${process.pid}`;
  const state: JourneyState = {
    registry: `${NAME_PREFIX}registry-${id}`,
    box: `${NAME_PREFIX}box-${id}`,
    regPort: JOURNEY_PORTS.registry,
    sshPort: JOURNEY_PORTS.ssh,
    httpPort: JOURNEY_PORTS.http,
    shopPort: JOURNEY_PORTS.shop,
  };
  docker('build', '-q', '-t', JOURNEY_IMAGE, join(ROOT, 'apps/runner/test/fixtures/sshd'));
  docker(...registryArgs(state.registry, state.regPort));
  docker(...boxArgs(state.box, state));
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
  return state;
}

function execDockerVersion(docker: DockerFn): void {
  docker('version', '--format', '{{.Server.Version}}');
}

export function readJourneyState(stateFile = JOURNEY_STATE): JourneyState {
  if (!existsSync(stateFile)) {
    throw new Error(
      'the journey containers are not running: run with the journey-containers setup project (it is a dependency of deploy-setup-journey)',
    );
  }
  return JSON.parse(readFileSync(stateFile, 'utf8')) as JourneyState;
}

export function stopJourneyContainers(docker: DockerFn = realDocker, stateFile = JOURNEY_STATE): void {
  if (process.env.AOM_JOURNEY_KEEP === '1') return;
  if (!existsSync(stateFile)) return;
  const s = JSON.parse(readFileSync(stateFile, 'utf8')) as JourneyState;
  for (const n of [s.box, s.registry]) {
    try {
      docker('rm', '-f', n);
    } catch {
      // already gone
    }
  }
  try {
    for (const t of docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}')
      .split('\n')
      .filter((x) => x.startsWith(`127.0.0.1:${s.regPort}/`)))
      docker('image', 'rm', t);
  } catch {
    // already gone
  }
  rmSync(stateFile, { force: true });
}
