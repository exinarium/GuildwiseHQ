/**
 * A `devcontainer.json` for a Codespace that runs a Guildwise runner (docs/design/cloud-workstations-and-forges.md 1.2,
 * 1.5). The toolchain features come from the stack ids the runner's detection (`apps/runner/src/toolchain/stacks.ts`)
 * reports; `aom-runner devcontainer` prints this file for a repository.
 */

export interface DetectedStack {
  id: string;
  params?: Record<string, string | undefined>;
}

const FEATURE_BASE = 'ghcr.io/devcontainers/features';

/** Dev container features for the detected stacks. Always Node (the runner needs it), git and the GitHub CLI. */
export function featuresFor(stacks: DetectedStack[]): Record<string, Record<string, unknown>> {
  const f: Record<string, Record<string, unknown>> = {
    [`${FEATURE_BASE}/node:1`]: { version: '22' },
    [`${FEATURE_BASE}/git:1`]: {},
    [`${FEATURE_BASE}/github-cli:1`]: {},
  };
  for (const s of stacks) {
    const p = s.params ?? {};
    switch (s.id) {
      case 'dotnet':
      case 'dotnet-maui':
        f[`${FEATURE_BASE}/dotnet:2`] = { version: p.sdkMajor ? `${p.sdkMajor}.0` : 'latest' };
        break;
      case 'python':
        f[`${FEATURE_BASE}/python:1`] = p.pythonVersion ? { version: p.pythonVersion } : {};
        break;
      case 'go':
        f[`${FEATURE_BASE}/go:1`] = p.goVersion ? { version: p.goVersion } : {};
        break;
      case 'rust':
        f[`${FEATURE_BASE}/rust:1`] = {};
        break;
      case 'maven':
      case 'gradle':
        f[`${FEATURE_BASE}/java:1`] = { version: p.javaMajor ?? '21' };
        break;
      case 'ruby':
        f[`${FEATURE_BASE}/ruby:1`] = {};
        break;
      case 'php':
        f[`${FEATURE_BASE}/php:1`] = {};
        break;
      default:
        break; // node is already there; docker is not offered (a Codespace cannot deploy Docker images)
    }
  }
  return f;
}

export interface DevcontainerInput {
  name: string;
  /** The Guildwise HQ origin, e.g. `https://app.example.com`. */
  serverUrl: string;
  stacks: DetectedStack[];
}

/**
 * The file contents. `postStartCommand` fetches the bootstrap script from the server, which installs the runner and
 * runs `aom-runner up`: that enrolls the codespace (no pairing code and no secret in the file).
 */
export function buildDevcontainer(input: DevcontainerInput): Record<string, unknown> {
  const url = input.serverUrl.replace(/\/+$/, '');
  return {
    name: input.name,
    image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
    features: featuresFor(input.stacks),
    // Agents run in an OS sandbox (bubblewrap); it needs unprivileged user namespaces inside the container.
    runArgs: ['--security-opt', 'seccomp=unconfined'],
    remoteEnv: { GUILDWISE_SERVER: url },
    postStartCommand: `curl -fsSL ${url}/api/runner/codespaces-bootstrap.sh | bash`,
  };
}

export const devcontainerText = (i: DevcontainerInput): string =>
  `${JSON.stringify(buildDevcontainer(i), null, 2)}\n`;
