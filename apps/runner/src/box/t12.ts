import { spawnSync } from 'node:child_process';

/**
 * quiet-approvals T12 safeguard (owner: the DevBox's shared daemon is UAT-only and accepted): the doctor and the installer
 * warn when the runner's Docker daemon also runs containers of a Guildwise server stack (its compose project or image
 * name). Phase B's Docker gatekeeper (label scope) and `--unshare-net` close the path anyway.
 */

export const T12_WARNING =
  "This runner's Docker also runs a Guildwise server. That is fine for a local UAT; never do this in production.";

export interface ContainerFacts {
  image: string;
  labels: Record<string, string>;
}

const SERVER_IMAGE = /(^|\/)(guildwise|aom)[-_](server|cloud|web|app|postgres|video|worker)/i;
const SERVER_PROJECT = /^(aom|guildwise)([-_].*)?$/i;

/** Does any container belong to a Guildwise server stack? */
export function runsGuildwiseServer(containers: readonly ContainerFacts[]): boolean {
  return containers.some(
    (c) =>
      SERVER_IMAGE.test(c.image) ||
      SERVER_PROJECT.test(c.labels['com.docker.compose.project'] ?? '') ||
      /guildwise/i.test(c.labels['org.opencontainers.image.title'] ?? ''),
  );
}

/** The containers on the runner's daemon (`docker ps`), or null when it cannot be asked. `run` is a test hook. */
export function daemonContainers(
  env: NodeJS.ProcessEnv,
  run: (args: string[]) => { status: number | null; stdout: string } = (args) => {
    const r = spawnSync('docker', args, { encoding: 'utf8', env, timeout: 10_000 });
    return { status: r.status, stdout: r.stdout ?? '' };
  },
): ContainerFacts[] | null {
  const r = run(['ps', '--format', '{{json .}}']);
  if (r.status !== 0) return null;
  const out: ContainerFacts[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { Image?: string; Labels?: string };
      const labels: Record<string, string> = {};
      for (const kv of (j.Labels ?? '').split(',')) {
        const i = kv.indexOf('=');
        if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1);
      }
      out.push({ image: j.Image ?? '', labels });
    } catch {
      // a line docker did not write as JSON
    }
  }
  return out;
}

/** The doctor's line: the warning, or null. */
export function t12Warning(
  env: NodeJS.ProcessEnv,
  run?: Parameters<typeof daemonContainers>[1],
): string | null {
  const c = daemonContainers(env, run);
  return c && runsGuildwiseServer(c) ? T12_WARNING : null;
}
