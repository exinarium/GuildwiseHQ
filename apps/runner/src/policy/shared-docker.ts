import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { adminDirOf, currentUser, instanceOfUser } from '../setup/admin-command.ts';
import { SHARED_SOCKET_RE } from '../setup/options.ts';
import { assertNotAgentSession } from './integrity.ts';
import { SHARED_HOST_RE } from './schema.ts';
import { type DockerSocketFact, type HostFacts, probeHost } from './startup.ts';
import type { PolicyStore } from './store.ts';

/**
 * installer-policy-seal: `guildwise-runner policy record-shared-docker`. The runner records the accepted shared rootless
 * Docker daemon in its own sealed policy.json, with the existing key (`PolicyStore.update`), after root's checks and group
 * join (`guildwise-admin docker shared`). Root never writes policy.json: its write kept the old seal, so the next start
 * found a broken seal and fell back to the safe defaults (Combined-QA blocker 3).
 *
 * It records nothing the owner did not choose: the sealed policy must already say `docker: shared` with that socket (setup,
 * typed or flag acceptance), and this process must already be in the socket's group. The checks mirror guildwise-admin's
 * (`docker shared`): the canonical path, the pattern, never a default socket, never group root or `docker`, never the
 * runner's own socket, writable, and the daemon itself reports rootless through a root-owned CLI. CLI only: never wired to
 * the Desk API or a server message. It never creates a key and never re-seals a broken file (`update` refuses it).
 */

/** The default sockets of the root daemon: a shared daemon's socket never resolves to one of them. */
const DEFAULT_SOCKETS = ['/run/docker.sock', '/var/run/docker.sock'];

export interface SharedDockerDeps {
  /** What this process sees of the socket at its canonical path (probeHost in the product). */
  probe: (real: string) => Promise<DockerSocketFact | undefined>;
  realpath?: (p: string) => string;
  now?: () => Date;
  /** This process's uid (null: unknown, as on Windows). */
  uid?: number | null;
}

export type SharedDockerResult =
  | { recorded: false; socket: string; group: string }
  | { recorded: true; socket: string; group: string };

export async function recordSharedDocker(
  store: PolicyStore,
  deps: SharedDockerDeps,
): Promise<SharedDockerResult> {
  assertNotAgentSession();
  // the seal is never laundered: a broken, unsealed or keyless-after-seal file is refused before anything else
  const cur = store.read();
  if (cur.error)
    throw new Error(`${store.file} is not a valid policy (${cur.error}); fix or remove it first`);
  const p = cur.policy;
  if (p.docker !== 'shared')
    throw new Error(
      `the local policy does not choose a shared Docker daemon (docker: ${p.docker}): run guildwise-runner setup with --docker shared first`,
    );
  const host = p.dockerHost ?? '';
  if (!SHARED_HOST_RE.test(host))
    throw new Error(`the local policy names no shared daemon socket (${host || 'none'}): run setup again`);
  const given = host.slice('unix://'.length);
  // already recorded for exactly this socket: nothing to write. A link given to setup is resolved and written again on
  // every re-run (dockerHost is normalized to the canonical path below), so DOCKER_HOST never follows a link.
  if (p.sharedDocker && p.sharedDocker.socket === given)
    return { recorded: false, socket: given, group: p.sharedDocker.group };

  let real: string;
  try {
    real = (deps.realpath ?? realpathSync)(given);
  } catch {
    throw new Error(`${given} does not exist`);
  }
  if (!SHARED_SOCKET_RE.test(real) || DEFAULT_SOCKETS.includes(real))
    throw new Error(`${given} resolves to ${real}, which is not a shared daemon's socket: refused`);
  const f = await deps.probe(real);
  if (!f || f.real !== real)
    throw new Error(`${real} was not found (or changed while it was checked): refused`);
  const uid = deps.uid === undefined ? (process.getuid?.() ?? null) : deps.uid;
  if (f.own || (uid !== null && f.uid === uid))
    throw new Error(`${real} is this runner user's own socket: use docker rootless`);
  if (f.gid === 0) throw new Error(`${real} belongs to group root: refused`);
  if (!f.group)
    throw new Error(
      `this runner user is not in the group of ${real}: run the guildwise-admin docker shared step first (in your own account: log out and in again)`,
    );
  if (f.group === 'docker')
    throw new Error(`${real} belongs to the docker group (root-equivalent): use docker host, refused`);
  if (!f.writable) throw new Error(`${real} is not writable by this runner user: refused`);
  if (f.rootless !== true)
    throw new Error(
      `the daemon at ${real} does not report rootless (asked through a root-owned docker CLI): refused`,
    );
  const group = f.group;
  const acceptedAt = (deps.now ?? (() => new Date()))().toISOString();
  store.update((q) => {
    // the file changed between the read and the write: refuse rather than record for another choice
    if (q.docker !== 'shared' || q.dockerHost !== host)
      throw new Error('the local policy changed while the shared daemon was recorded: run this again');
    return { ...q, dockerHost: `unix://${real}`, sharedDocker: { socket: real, group, acceptedAt } };
  });
  return { recorded: true, socket: real, group };
}

/** The product's probe: the start-up check's own (probeHost), asked for exactly this socket, through the root-owned CLI. */
export function sharedDockerProbe(
  probe: (o: Parameters<typeof probeHost>[0]) => Promise<HostFacts> = probeHost,
  user: string = currentUser(),
): SharedDockerDeps['probe'] {
  return async (real) => {
    const facts = await probe({
      paths: [],
      sharedSocket: real,
      // S2: the root-owned docker CLI only, never PATH (the same candidates as the start-up check)
      dockerCli: [join(adminDirOf(instanceOfUser(user)), 'docker', 'docker'), '/usr/bin/docker'],
    });
    return facts.dockerSockets.find((s) => s.real === real);
  };
}
