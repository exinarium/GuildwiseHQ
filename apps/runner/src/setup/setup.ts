import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { entryDir, loadIndex } from '../pairings.ts';
import type { Policy } from '../policy/schema.ts';
import { RunnerKeys } from '../secrets/keys.ts';
import { SudoVault } from '../secrets/sudo.ts';
import type { Executor } from '../toolchain/exec.ts';
import { adminCommand, dedicatedUserOf, instanceOfUser, isDedicatedUser } from './admin-command.ts';
import { readOffers } from './offers.ts';
import { type ApproveApp, parseApproveApp, SetupError, type SetupOptions } from './options.ts';
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
  readStdin: () => Promise<string>;
  exec: Executor;
}

export interface SetupResult {
  policy: Policy | null;
  adminCommands: string[];
  /** 0 done; 3 the root part (a dedicated user) must happen first, nothing was written. */
  exitCode: number;
  wrote: boolean;
}

export const SUDO_WARNING =
  'With sudo on, the runner can become root whenever your local policy allows a DevOps step; every such step still needs your local yes.';

const DOCKER_EXPLAINED = [
  'How deploys reach Docker:',
  '  none    no Docker for deploys (the default)',
  '  narrow  a small root-owned helper runs only compose apps you approved, frozen; every compose change asks you again (recommended when deploys use Docker)',
  '  group   the docker group: no prompts, but the runner user becomes root-equivalent',
].join('\n');

const ROOT_EQUIVALENT_PHRASE = 'root-equivalent';
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

function pairingDirsOf(dataRoot: string): string[] {
  try {
    return loadIndex(dataRoot).pairings.map((e) => entryDir(dataRoot, e));
  } catch {
    return [];
  }
}

function inside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** RSA-OAEP (SHA-256) with the runner's own public key: the same ciphertext the browser would send for `sudo.set`. */
function sealFor(keys: RunnerKeys, password: string): string {
  const pub = createPublicKey({
    key: Buffer.from(keys.publicKey.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return publicEncrypt(
    { key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(password),
  ).toString('base64');
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
      `The runner keeps running as ${deps.username}. It refuses to start while ${deps.username} is root-equivalent (passwordless sudo, the docker group, a writable Docker socket) unless you accept that below.`,
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

  // ---- 4. sudo [R20 step 3, rv6-7]
  let sudo = opts.sudo;
  if (!sudo) {
    if (p) {
      say(SUDO_WARNING);
      sudo = (await p.confirm('Turn sudo on for the runner?', false)) ? 'on' : 'off';
    } else sudo = 'off';
  } else if (sudo === 'on') say(SUDO_WARNING);
  if (sudo === 'on') {
    if (!posix) throw new SetupError('sudo does not exist on Windows; use the dedicated WSL distro');
    if (dirs.length === 0)
      throw new SetupError(
        'pair this machine first (`guildwise-runner pair`), then run setup again: sudo is sealed with the pairing key',
      );
    const keys = dirs.map((d) => ({ dir: d, keys: new RunnerKeys(join(d, 'secrets', 'runner-key.pem')) }));
    if (mode === 'dedicated') admin.push(adminCmd(['sudo', 'on']));
    else {
      let password: string;
      if (opts.sudoPasswordStdin) password = (await deps.readStdin()).replace(/\r?\n$/, '');
      else if (p)
        password = await p.secret('Your sudo password (sealed on this machine, never sent anywhere):');
      else
        throw new SetupError(
          'with the current user, --sudo on needs your own sudo password: add --sudo-password-stdin',
        );
      if (!password) throw new SetupError('empty sudo password: sudo stays off');
      for (const k of keys) {
        const vault = new SudoVault({
          file: join(k.dir, 'secrets', 'sudo.enc'),
          keys: k.keys,
          exec: deps.exec,
          platform: deps.platform,
        });
        const r = await vault.set({ keyId: k.keys.publicKey.keyId, ciphertext: sealFor(k.keys, password) });
        if (!r.stored || !r.works) {
          vault.clear();
          throw new SetupError(
            `sudo did not accept that password (${r.error ?? 'not stored'}); sudo stays off`,
          );
        }
      }
      say(`Sealed your sudo password for ${keys.length} pairing(s) on this machine.`);
    }
    next.devops = { ...next.devops, sudo: true };
    // with sudo, asking is always on
    next.devopsRequests = 'ask';
  } else {
    if (current.devops.sudo && mode === 'dedicated') admin.push(adminCmd(['sudo', 'off']));
    if (mode === 'current') for (const d of dirs) rmSync(join(d, 'secrets', 'sudo.enc'), { force: true });
    next.devops = { ...next.devops, sudo: false };
  }

  // ---- 5. Docker for deploys [R20 step 4]
  const userArg = mode === 'current' ? ['--user', deps.username] : [];
  let docker = opts.docker;
  if (!docker) {
    if (p) {
      say(DOCKER_EXPLAINED);
      docker = await p.choose('Docker access for deploys', ['none', 'narrow', 'group'] as const, 'none');
    } else docker = 'none';
  }
  let accept = opts.acceptRootEquivalent;
  const typedAccept = async (why: string): Promise<boolean> =>
    p
      ? (
          await p.text(`${why} Type "${ROOT_EQUIVALENT_PHRASE}" to accept (anything else declines):`)
        ).trim() === ROOT_EQUIVALENT_PHRASE
      : false;
  if (docker === 'group' && !accept) {
    accept = await typedAccept('The docker group makes the runner user root-equivalent.');
    if (!accept) {
      say('Not accepted: Docker access stays none.');
      docker = 'none';
    }
  }
  if (!accept && p && mode === 'current' && posix)
    accept = await typedAccept(
      `If ${deps.username} is root-equivalent, the runner refuses to start. Accept starting anyway, with a warning?`,
    ).catch(() => false);
  next.docker = docker;
  next.acceptRootEquivalent = accept;
  if (docker === 'narrow') admin.push(adminCmd(['docker', 'narrow', ...userArg]));
  else if (docker === 'group')
    admin.push(adminCmd(['docker', 'group', '--accept-root-equivalent', ...userArg]));
  else if (current.docker !== 'none') admin.push(adminCmd(['docker', 'none', ...userArg]));
  const apps: ApproveApp[] = [...opts.approveApps];
  if (p && docker === 'narrow' && apps.length === 0) {
    const t = (
      await p.text('Compose apps to approve now, as app=folder separated by commas (empty for none):')
    ).trim();
    for (const spec of t
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      apps.push(parseApproveApp(spec));
  }
  if (apps.length > 0 && docker !== 'narrow') throw new SetupError('--approve-app needs --docker narrow');
  for (const a of apps) {
    if (!inside(deps.home, a.folder))
      throw new SetupError(
        `${a.folder} is not one of the runner's own clones (inside ${deps.home}): clone the app there first`,
      );
    admin.push(adminCmd(['approve-app', a.app, '--source', a.folder]));
  }

  // ---- 6. deploy defaults [R20 step 5]
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

  // ---- 7. summary [R20 step 6]
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
  say(`  sudo             ${written.devops.sudo ? 'on (each DevOps step still asks here)' : 'off'}`);
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
    say('  gh auth login --insecure-storage');
  } else {
    say('  claude               (sign in, then /exit)');
    say('  gh auth login        (or git credentials for your remotes)');
  }
  return { policy: written, adminCommands: admin, exitCode: 0, wrote: true };
}
