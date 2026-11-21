import { entryDir, loadIndex } from '../pairings.ts';
import type { Policy } from '../policy/schema.ts';
import type { Executor } from '../toolchain/exec.ts';
import { adminCommand, dedicatedUserOf, instanceOfUser, isDedicatedUser } from './admin-command.ts';
import { readOffers } from './offers.ts';
import {
  DESKTOP_SOCKET_RE,
  type DockerMode,
  SetupError,
  type SetupOptions,
  SHARED_SOCKET_RE,
} from './options.ts';
import { policyPath, readPolicy, writePolicy } from './policy-file.ts';
import type { Prompter } from './prompt.ts';
import { clonesDir, ensureClonesDir, gitVersionAtLeast, MIN_FETCH_GIT } from './workspace.ts';

/**
 * `guildwise-runner setup` (R20, unprivileged half): asks on this machine, writes only `policy.json` (mode 600), and
 * prints the exact `guildwise-admin` command (`admin-command.ts`) for anything that needs root. Nothing is
 * taken from the server: what it reports (organizations, roles, DevOps engineers) is shown as a suggestion that
 * defaults to no. Re-runnable; the installer runs it in its "Setting local permissions" step.
 */

export interface SetupDeps {
  home: string;
  /** Effective uid; 0 refuses. */
  uid: number;
  username: string;
  platform: NodeJS.Platform;
  /** The runner data directory (`~/.aom-runner`), whose pairings carry the keys and the server's offers. */
  dataRoot: string;
  policyFile?: string;
  /** null: no questions (non-interactive); every unanswered step takes the safe value. */
  prompter: Prompter | null;
  out: (line: string) => void;
  exec: Executor;
}

export interface SetupResult {
  policy: Policy | null;
  adminCommands: string[];
  /** 0 done; 3 the root part (a dedicated user) must happen first, nothing was written. */
  exitCode: number;
  wrote: boolean;
}

/** The owner's words (OWNER-TODO 2026-11-21) for Docker that is not rootless. */
/** Owner 2026-11-21: "UAT will not use github and it should be able to setup through the UI". Never required. */
export const GITHUB_OPTIONAL =
  '  (optional) gh auth login, only for GitHub repositories; repositories and set-up can come through the Guildwise UI';
export const ROOTFUL_WARNING = 'Docker detected, not running in rootless mode';
export const MAC_DOCKER_WARNING =
  'Docker Desktop: containers can read and write the folders Docker Desktop shares, by default all of /Users, your files included; narrow them in Settings > Resources > File sharing.';
export const SHARED_WARNING =
  "The runner joins that daemon's group: it can then control every container on that daemon. Runners that share a daemon can each control the other's containers; your typed acceptance records that you chose it.";
const SHARED_DAEMON_PHRASE = 'shared-daemon';

/**
 * The groups of the user that own a Docker socket (or `docker`): any of them reaches a daemon that is not the runner's
 * own. Read with `id -nG`, `stat -c %g` on the sockets and `getent group`, so it works as the unprivileged user.
 */
async function dockerGroupsOf(deps: SetupDeps): Promise<string[]> {
  const mine = (await deps.exec.run('id', ['-nG'])).stdout.trim().split(/\s+/).filter(Boolean);
  const r = await deps.exec.run('sh', [
    '-c',
    'for s in /var/run/docker.sock /run/docker.sock /run/*/docker.sock; do [ -S "$s" ] && stat -L -c %g "$s"; done 2>/dev/null | sort -u | while read g; do getent group "$g" | cut -d: -f1; done',
  ]);
  const owning = new Set(['docker', ...r.stdout.trim().split(/\s+/).filter(Boolean)]);
  return mine.filter((g) => owning.has(g));
}

const ROOT_EQUIVALENT_PHRASE = 'root-equivalent';
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

function pairingDirsOf(dataRoot: string): string[] {
  try {
    return loadIndex(dataRoot).pairings.map((e) => entryDir(dataRoot, e));
  } catch {
    return [];
  }
}

export async function runSetup(deps: SetupDeps, opts: SetupOptions): Promise<SetupResult> {
  if (deps.uid === 0)
    throw new SetupError(
      `\`guildwise-runner setup\` refuses to run as root. Run it as the runner user (\`sudo -u ${dedicatedUserOf(opts.instance)} -H guildwise-runner setup\`); the root steps it needs are printed for \`guildwise-admin\`.`,
    );
  // a named instance is the user it runs as (guildwise-runner-<name>); --instance may only confirm it
  const ownInstance = instanceOfUser(deps.username);
  if (opts.instance !== undefined && isDedicatedUser(deps.username) && opts.instance !== ownInstance)
    throw new SetupError(
      `this is ${deps.username}, not the runner user of instance ${opts.instance} (${dedicatedUserOf(opts.instance)}): run setup as that user`,
    );
  const instance = ownInstance ?? opts.instance ?? null;
  const DEDICATED_USER = dedicatedUserOf(instance);
  const adminCmd = (args: readonly string[]) => adminCommand(args, instance);
  const p = opts.yes ? null : deps.prompter;
  const say = deps.out;
  const policyFile = deps.policyFile ?? policyPath(deps.home);
  const current = readPolicy(policyFile);
  const next: Policy = structuredClone(current);
  const admin: string[] = [];
  const dirs = pairingDirsOf(deps.dataRoot);
  const posix = deps.platform !== 'win32';

  // ---- 1. runner user [R20 step 1, R18-P]
  let mode: 'dedicated' | 'current';
  if (!posix) mode = 'current';
  else if (isDedicatedUser(deps.username)) mode = 'dedicated';
  else {
    const want =
      opts.runnerUser ??
      (p
        ? (await p.confirm(`Run the runner as its own dedicated user ${DEDICATED_USER} (recommended)?`, true))
          ? 'dedicated'
          : 'current'
        : 'dedicated');
    if (want === 'dedicated') {
      say(`The runner should run as ${DEDICATED_USER}, not as ${deps.username}. As an administrator, run:`);
      const cmds = [
        adminCmd(['user', 'create']),
        adminCmd(['service', 'install']),
        adminCmd(['migrate-user', '--from', deps.username]),
      ];
      for (const c of cmds) say(`  ${c}`);
      say(
        `(migrate-user only if this user already has a 1.10.0 runner to move.) Then run setup as that user:`,
      );
      say(
        `  sudo -u ${DEDICATED_USER} -H guildwise-runner setup${instance ? ` --instance ${instance}` : ''}`,
      );
      return { policy: null, adminCommands: cmds, exitCode: 3, wrote: false };
    }
    if (instance)
      throw new SetupError(
        `--instance ${instance} needs the dedicated runner user ${DEDICATED_USER} (not --runner-user current)`,
      );
    mode = 'current';
    say(
      `The runner keeps running as ${deps.username}. It refuses to start while ${deps.username} is root-equivalent (passwordless sudo, the docker group, a writable socket of another Docker daemon) unless you accept that below.`,
    );
  }
  next.runnerUser = { mode, name: deps.username };

  // ---- 2. own clones [rv6-3, rv7-13]
  const clones = clonesDir(deps.home, mode);
  ensureClonesDir(clones);
  say(
    `The runner works only in its own clones under ${clones}; you get its work through git (by default it pushes branches to your remote).`,
  );
  if (p && posix && mode === 'dedicated') {
    if (
      await p.confirm("Also let a person on this machine fetch from the runner's clones (read-only)?", false)
    ) {
      const gv = await deps.exec.run('git', ['--version']);
      if (!gitVersionAtLeast(gv.stdout, MIN_FETCH_GIT))
        say(
          `That needs git ${MIN_FETCH_GIT} or newer (found: ${gv.stdout.trim() || 'none'}); only the remote route is offered.`,
        );
      else {
        const who = (await p.text('Their user name on this machine:')).trim();
        // never another runner user: two instances never read each other's clones
        if (!USER_RE.test(who) || isDedicatedUser(who)) say(`Not a user name: ${who}; skipped.`);
        else admin.push(adminCmd(['readers', 'add', who]));
      }
    }
  }

  // ---- 3. DevOps organizations [rv6-6]: the server only offers; every one defaults to no
  const offers = readOffers(dirs);
  const agents: Record<string, string> = {};
  if (opts.devopsOrgs !== undefined) {
    if (opts.devopsOrgs !== 'none')
      for (const id of opts.devopsOrgs) {
        const o = offers.find((x) => x.orgId.toLowerCase() === id);
        if (!o) throw new SetupError(`organization ${id} is not one the server offers for this workstation`);
        if (!o.devopsAgentId)
          throw new SetupError(
            `${o.orgName} (${id}) has no DevOps engineer on this workstation yet: hire one, then run setup again (or \`guildwise-runner devops grant ${id}\`)`,
          );
        agents[o.orgId] = o.devopsAgentId;
      }
  } else if (p) {
    for (const [org, agent] of Object.entries(current.devops.agents)) {
      const name = offers.find((o) => o.orgId === org)?.orgName ?? org;
      if (await p.confirm(`Keep the local DevOps grant for ${name} (${org})?`, true)) agents[org] = agent;
    }
    for (const o of offers) {
      if (agents[o.orgId]) continue;
      say(`${o.orgName} (${o.orgId}): the server says you are ${o.role}.`);
      if (!o.devopsAgentId) {
        say(
          `  No DevOps engineer on this workstation yet; grant later with \`guildwise-runner devops grant ${o.orgId}\`.`,
        );
        continue;
      }
      if (await p.confirm(`  May its DevOps engineer work outside the sandbox on this machine?`, false))
        agents[o.orgId] = o.devopsAgentId;
    }
  }
  next.devops = { ...next.devops, agents };

  // ---- 4. Docker for the runner [R20 step 4, DESIGN deps-without-sudo §3]
  const userArg = mode === 'current' ? ['--user', deps.username] : [];
  const mac = deps.platform === 'darwin';
  const found = opts.dockerFound ?? (current.docker === 'rootless' ? 'own' : 'none');
  let accept = opts.acceptRootEquivalent;
  const typed = async (why: string, phrase: string): Promise<boolean> =>
    p
      ? (await p.text(`${why} Type "${phrase}" to accept (anything else declines):`)).trim() === phrase
      : false;
  let docker: DockerMode | undefined = opts.docker;
  const socket = opts.dockerSocket;
  let acceptShared = opts.acceptSharedDaemon;
  if (!docker) {
    if (!posix) docker = 'none';
    else if (mac) {
      if (found === 'desktop' && p) {
        say(MAC_DOCKER_WARNING);
        docker = 'host';
      } else docker = 'none';
    } else if (found === 'rootful' && p) {
      say(ROOTFUL_WARNING);
      docker =
        (await p.choose(
          '1) a separate rootless Docker for the runner (recommended), 2) the installed Docker (root-equivalent)',
          ['1', '2'] as const,
          '1',
        )) === '2'
          ? 'host'
          : 'rootless';
    } else if (found === 'shared' && p && socket) {
      say(`A rootless Docker daemon of another user is running (${socket}).`);
      docker =
        (await p.choose(
          '1) a separate rootless Docker for the runner (recommended), 2) that shared daemon',
          ['1', '2'] as const,
          '1',
        )) === '2'
          ? 'shared'
          : 'rootless';
    } else docker = 'rootless';
  }
  if (docker === 'rootless' && (mac || !posix))
    throw new SetupError(
      'rootless Docker is a Linux set-up: on a Mac use Docker Desktop (--docker host), or none',
    );
  if (docker === 'host' && mac) {
    if (!socket || !DESKTOP_SOCKET_RE.test(socket))
      throw new SetupError(
        '--docker host on a Mac needs --docker-socket /Users/<you>/.docker/run/docker.sock',
      );
  }
  if (docker === 'host' && !accept) {
    accept = await typed(
      mac
        ? 'Docker Desktop makes the runner user root-equivalent inside Docker.'
        : 'The installed Docker daemon makes the runner user root-equivalent.',
      ROOT_EQUIVALENT_PHRASE,
    );
    if (!accept) {
      say('Not accepted: the runner gets no Docker.');
      docker = 'none';
    }
  }
  if (docker === 'shared') {
    if (!socket || !SHARED_SOCKET_RE.test(socket))
      throw new SetupError('--docker shared needs --docker-socket /run/<name>/docker.sock');
    if (!acceptShared) {
      say(SHARED_WARNING);
      acceptShared = await typed('', SHARED_DAEMON_PHRASE);
      if (!acceptShared) {
        say('Not accepted: the runner gets its own rootless Docker instead.');
        docker = 'rootless';
      }
    }
  }
  // F1: in current-user mode the person's own groups stay as they are; a group that reaches a Docker daemon is refused
  // at start-up, so say so now instead of writing a policy that refuses
  if (mode === 'current' && posix && !mac && (docker === 'rootless' || docker === 'none') && !accept) {
    const reach = await dockerGroupsOf(deps);
    if (reach.length > 0) {
      const why = `${deps.username} is in ${reach.join(', ')}, which reaches a Docker daemon: the runner would refuse to start (the start-up check), and setup does not change your groups.`;
      if (!p)
        throw new SetupError(
          `${why} Use a dedicated runner user (--runner-user dedicated, recommended) or the installed Docker (--docker host --accept-root-equivalent).`,
        );
      say(why);
      const pick = await p.choose(
        '1) a dedicated runner user (recommended), 2) the installed Docker (root-equivalent)',
        ['1', '2'] as const,
        '1',
      );
      if (pick === '1') {
        const cmds = [adminCmd(['user', 'create']), adminCmd(['service', 'install'])];
        say('As an administrator, run:');
        for (const c of cmds) say(`  ${c}`);
        say(`Then run setup as that user:  sudo -u ${DEDICATED_USER} -H guildwise-runner setup`);
        return { policy: null, adminCommands: cmds, exitCode: 3, wrote: false };
      }
      accept = await typed(
        'The installed Docker daemon makes the runner user root-equivalent.',
        ROOT_EQUIVALENT_PHRASE,
      );
      if (!accept) throw new SetupError('not accepted: nothing was written');
      docker = 'host';
    }
  }
  if (!accept && p && mode === 'current' && posix)
    accept = await typed(
      `If ${deps.username} is root-equivalent, the runner refuses to start. Accept starting anyway, with a warning?`,
      ROOT_EQUIVALENT_PHRASE,
    ).catch(() => false);
  next.docker = docker;
  next.acceptRootEquivalent = accept;
  delete next.dockerHost;
  if (docker !== 'shared') delete next.sharedDocker;
  if (docker === 'rootless') admin.push(adminCmd(['docker', 'rootless', ...userArg]));
  else if (docker === 'host') {
    if (mac && socket) next.dockerHost = `unix://${socket}`;
    admin.push(
      adminCmd([
        'docker',
        'host',
        '--accept-root-equivalent',
        ...(mac && socket ? ['--desktop-socket', socket] : []),
        ...userArg,
      ]),
    );
  } else if (docker === 'shared' && socket) {
    next.dockerHost = `unix://${socket}`;
    admin.push(
      adminCmd(['docker', 'shared', '--docker-socket', socket, '--accept-shared-daemon', ...userArg]),
    );
  } else if (current.docker !== 'none') admin.push(adminCmd(['docker', 'none', ...userArg]));

  // ---- 5. deploy defaults [R20 step 5]
  next.deploy =
    opts.deploy ?? (p ? await p.choose('Deploys', ['ask', 'off'] as const, current.deploy) : 'ask');
  next.deployPinCommit =
    opts.deployPinCommit ??
    (p
      ? await p.confirm(
          'Bind approved redeploys to the commit too, so every new commit asks again (otherwise anyone who can push to the deployed branch gets code run at the next redeploy)?',
          current.deployPinCommit,
        )
      : current.deployPinCommit);
  if (p) {
    const known = Object.keys(current.installScripts);
    if (known.length > 0) say(`Repositories whose installs may run their scripts: ${known.join(', ')}`);
    const t = (
      await p.text(
        'Repositories whose installs may run their scripts (URLs separated by commas; empty keeps the list, "none" clears it):',
      )
    ).trim();
    if (t === 'none') next.installScripts = {};
    else if (t)
      next.installScripts = Object.fromEntries(
        t
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((u) => [u, true as const]),
      );
  }
  if (opts.allowUnsignedFrom) next.allowUnsignedUpdatesFrom = opts.allowUnsignedFrom;
  else if (p && current.allowUnsignedUpdatesFrom.length > 0) {
    const keep: string[] = [];
    for (const o of current.allowUnsignedUpdatesFrom)
      if (await p.confirm(`Keep accepting unsigned runner updates from ${o} (test machines only)?`, true))
        keep.push(o);
    next.allowUnsignedUpdatesFrom = keep;
  }
  if (current.legacyUpdateOrigin && p) {
    const keep = await p.confirm(
      `This runner arrived by the old self-update. Keep accepting unsigned updates from your server ${current.legacyUpdateOrigin}, as before?`,
      true,
    );
    if (!keep) delete next.legacyUpdateOrigin;
  }

  // ---- 6. summary [R20 step 6]
  next.startupRefusal = true;
  next.setupDone = true;
  const written = writePolicy(policyFile, next);
  const orgName = (id: string) => offers.find((o) => o.orgId === id)?.orgName ?? id;
  say('');
  say(`Local policy written to ${policyFile} (mode 600):`);
  say(
    `  runner user      ${mode === 'dedicated' ? `${deps.username} (dedicated${instance ? `, instance ${instance}` : ''})` : `${deps.username} (current user)`}`,
  );
  say(`  clones           ${clones}`);
  say(
    `  DevOps for       ${Object.keys(written.devops.agents).map(orgName).join(', ') || 'no organization'}`,
  );
  say(
    `  Docker           ${written.docker}${written.acceptRootEquivalent ? ' (root-equivalence accepted)' : ''}`,
  );
  say(`  deploys          ${written.deploy}${written.deployPinCommit ? ', pinned to the commit' : ''}`);
  say(
    `  install scripts  ${Object.keys(written.installScripts).length} repositor${Object.keys(written.installScripts).length === 1 ? 'y' : 'ies'} allowed`,
  );
  if (written.allowUnsignedUpdatesFrom.length > 0)
    say(`  unsigned updates from ${written.allowUnsignedUpdatesFrom.join(', ')}`);
  say('  start-up refusal on (a root-equivalent runner user refuses to start unless accepted)');
  if (admin.length > 0) {
    say('');
    say('Finish the root part as an administrator:');
    for (const c of admin) say(`  ${c}`);
  }
  say('');
  say(`Sign in as ${deps.username} where the runner needs it (logins are never copied from another user):`);
  if (deps.platform === 'darwin' && mode === 'dedicated') {
    say(
      '  claude setup-token   then: guildwise-runner auth oauth-token   (a daemon user has no login keychain)',
    );
    say(GITHUB_OPTIONAL);
  } else {
    say('  claude               (sign in, then /exit)');
    say(GITHUB_OPTIONAL);
  }
  return { policy: written, adminCommands: admin, exitCode: 0, wrote: true };
}
