#!/usr/local/lib/guildwise/node/bin/node
'use strict';
/*
 * guildwise-admin (R20, R18-P): everything the runner set-up needs root for, as one self-contained, root-owned program.
 *
 * The installer copies this file from the verified runner package to /usr/local/lib/guildwise/guildwise-admin
 * (root:root 0755, parents root-owned) and runs it with sudo. It is never changed by a runner self-update, it imports
 * nothing but `node:` built-ins (no file from the runner tree, which the runner user can rewrite), and it refuses to run
 * under any interpreter other than the bundled Node in /usr/local/lib/guildwise/node [rv7-12].
 *
 *   guildwise-admin user create                     the dedicated `guildwise-runner` user (Linux useradd, macOS dscl)
 *   guildwise-admin service install|remove          the system unit / LaunchDaemon that runs the runner as that user
 *   guildwise-admin docker rootless|host|shared|none  the runner's Docker (own rootless daemon by default)
 *   guildwise-admin cleanup-legacy                  remove what 1.10.0 dropped: sudoers, sealed sudo, deploy-compose
 *   guildwise-admin readers add|remove <user>       read-only `git fetch` access to the runner's own clones
 *   guildwise-admin migrate-user [--finish]         move a 1.10.0 current-user install to the dedicated user
 *   guildwise-admin apply <flags>                   the installer's non-interactive form of the above
 *   guildwise-admin verify                          check the root-owned install, the sudoers files and root's PATH
 *
 * Every command takes --dry-run (print what would change, change nothing; also allowed without root).
 * Every command takes --instance <name> for a named runner (two or more runners on one machine, for example one paired
 * with UAT and one with production): its own user `guildwise-runner-<name>`, service, CA copy, sudoers rules, readers
 * group, migration marker, AppArmor profile and subuid range (instanceLayout below). Without it, the single
 * `guildwise-runner` of before. A named instance also has its own copy of the root-owned tools,
 * /usr/local/lib/guildwise/<name>/ (guildwise-admin, node, docker), installed from that instance's server's verified
 * release: an instance is managed only by its own copy (the interpreter decides, see checkInterpreter), so one server's
 * release never supplies another's root tools.
 * 1.10.0 removed every standing root path of the runner: no sudo grant, no sealed sudo password, no narrow Docker helper.
 * `cleanup-legacy` removes what an earlier install left; a sealed sudo password file is deleted and never opened.
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const readline = require('node:readline');
const util = require('node:util');

const ADMIN_DIR = '/usr/local/lib/guildwise';
const NODE_DIR = `${ADMIN_DIR}/node`;
const NODE_PATH = `${NODE_DIR}/bin/node`;
const SELF_PATH = `${ADMIN_DIR}/guildwise-admin`;
/** The narrow-mode helper of before 1.10.0: only `cleanup-legacy` names it now (it removes it). */
const DEPLOY_COMPOSE = `${ADMIN_DIR}/deploy-compose`;
const RUNNER_USER = 'guildwise-runner';
const READERS_GROUP = 'guildwise-readers';
/** MIN_TRUSTED_RUNNER (apps/runner/src/update/floor.ts): state written by an older runner is never carried over (R21).
 * Raised by hand with the floor, never with RUNNER_VERSION; a test keeps the two equal (this file may not import it). */
const RUNNER_FLOOR = '1.10.0';
const SUDOERS_SUDO = '/etc/sudoers.d/guildwise-runner';
const SUDOERS_DOCKER = '/etc/sudoers.d/guildwise-runner-docker';
/** Narrow-mode approvals of before 1.10.0 (removed by `cleanup-legacy`). */
const APPS_CONF_DIR = '/etc/guildwise-runner/apps';
/** `service install --ca-file`: the root-owned copy of a private CA the runner service trusts (NODE_EXTRA_CA_CERTS). */
const RUNNER_CA_FILE = '/etc/guildwise-runner/ca.pem';
const MAX_CA_FILE = 256 * 1024;
const STATE_DIR = '/var/lib/guildwise';
const MIGRATE_MARKER = `${STATE_DIR}/migrate-user.json`;
const SYSTEMD_UNIT = '/etc/systemd/system/guildwise-runner.service';
const LAUNCHD_LABEL = 'com.guildwisehq.runner';
const LAUNCHD_PLIST = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
const MAC_HOME = '/var/guildwise-runner';
const MAC_STAFF_GID = 20;
const SAFE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
/** Groups that make an account root-equivalent or an administrator; the dedicated user is never in one. */
const PRIVILEGED_GROUPS = ['sudo', 'wheel', 'admin', 'docker', 'root', 'adm', 'lxd', 'libvirt'];
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
/** Paths that end up inside unit files, plists and sudoers lines: no quotes, spaces, newlines or `%`. */
const SAFE_ABS_RE = /^\/[A-Za-z0-9._/-]{0,500}$/;
const MAX_COPY_FILE = 512 * 1024 * 1024;
const PLATFORMS = ['linux', 'darwin'];
/**
 * `--instance <name>`: lowercase letters, digits and inner dashes, at most 15 (`guildwise-runner-<name>` stays within the
 * 32 characters of a Linux user name). No underscore, so the instance's sudoers files (`..._sudo`, `..._docker`) and
 * compose projects (`guildwise_<name>_<app>`) can never collide with the default runner's or another instance's: every
 * default project, volume and network starts `guildwise-`, every instance's starts `guildwise_`, and the first `_` after
 * it ends the instance name.
 */
const INSTANCE_RE = /^[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?$/;
/** Names already taken inside /usr/local/lib/guildwise (an instance's tools folder may never be one of them). */
const RESERVED_INSTANCES = ['node', 'guildwise-admin', 'deploy-compose', 'docker'];
/** Where Docker's sockets live: the default ones and one level below /run (a shared daemon such as /run/docker-svc). */
const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];
/** A Mac's Docker Desktop socket of the logged-in user (`docker host` on macOS). */
const DESKTOP_SOCKET_RE = /^\/Users\/([^/]+)\/\.docker\/run\/docker\.sock$/;
/** Subordinate id ranges for rootless Docker: 65536 ids, aligned, from 100000 up (never overlapping another entry). */
const SUBID_COUNT = 65536;
/** A shared daemon's socket one level below /run (never a dot segment, never the default /run/docker.sock). */
const SHARED_SOCKET_RE = /^\/(?:var\/)?run\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/docker\.sock$/;
const SUBID_FLOOR = 100000;
/** The runner's policy.json inside its HOME (apps/runner/src/policy/store.ts policyDir). */
const POLICY_REL = '.config/aom-runner/policy.json';

/**
 * Every name and path that belongs to one runner. `null`: the single runner of before (the exact constants above); a
 * name: a fully separate set, so two instances share nothing they could read or write of each other's.
 */
function instanceLayout(name) {
  if (name === undefined || name === null || name === '')
    return Object.freeze({
      instance: null,
      user: RUNNER_USER,
      service: 'guildwise-runner',
      systemdUnit: SYSTEMD_UNIT,
      launchdLabel: LAUNCHD_LABEL,
      launchdPlist: LAUNCHD_PLIST,
      macHome: MAC_HOME,
      sudoersSudo: SUDOERS_SUDO,
      sudoersDocker: SUDOERS_DOCKER,
      etcDir: '/etc/guildwise-runner',
      appsConfDir: APPS_CONF_DIR,
      appsStateDir: `${STATE_DIR}/apps`,
      composePrefix: 'guildwise-',
      caFile: RUNNER_CA_FILE,
      migrateMarker: MIGRATE_MARKER,
      readersGroup: READERS_GROUP,
      logName: 'guildwise-runner.log',
      toolsDir: ADMIN_DIR,
      adminPath: SELF_PATH,
      deployCompose: DEPLOY_COMPOSE,
      dockerDir: `${ADMIN_DIR}/docker`,
      apparmorProfile: `/etc/apparmor.d/${RUNNER_USER}-rootlesskit`,
      nodePath: NODE_PATH,
      flag: [],
    });
  if (!INSTANCE_RE.test(String(name)) || RESERVED_INSTANCES.includes(String(name)))
    throw new AdminError(
      `not a valid instance name: ${JSON.stringify(name)} (lowercase letters, digits and inner dashes, at most 15)`,
      64,
    );
  const user = `${RUNNER_USER}-${name}`;
  const etcDir = `/etc/${user}`;
  return Object.freeze({
    instance: name,
    user,
    service: user,
    systemdUnit: `/etc/systemd/system/${user}.service`,
    launchdLabel: `${LAUNCHD_LABEL}.${name}`,
    launchdPlist: `/Library/LaunchDaemons/${LAUNCHD_LABEL}.${name}.plist`,
    macHome: `/var/${user}`,
    sudoersSudo: `/etc/sudoers.d/${user}_sudo`,
    sudoersDocker: `/etc/sudoers.d/${user}_docker`,
    etcDir,
    appsConfDir: `${etcDir}/apps`,
    appsStateDir: `${STATE_DIR}/apps-${name}`,
    composePrefix: `guildwise_${name}_`,
    caFile: `${etcDir}/ca.pem`,
    migrateMarker: `${STATE_DIR}/migrate-user-${name}.json`,
    readersGroup: `${READERS_GROUP}-${name}`,
    logName: `${user}.log`,
    toolsDir: `${ADMIN_DIR}/${name}`,
    adminPath: `${ADMIN_DIR}/${name}/guildwise-admin`,
    deployCompose: `${ADMIN_DIR}/${name}/deploy-compose`,
    dockerDir: `${ADMIN_DIR}/${name}/docker`,
    apparmorProfile: `/etc/apparmor.d/${user}-rootlesskit`,
    nodePath: `${ADMIN_DIR}/${name}/node/bin/node`,
    flag: ['--instance', name],
  });
}

const DEFAULT_LAYOUT = instanceLayout(null);

/** `sudo guildwise-admin [--instance <name>] <args>` for the messages this tool prints. */
function adminHint(L, args) {
  return ['sudo', L.adminPath, ...L.flag, ...args].join(' ');
}

class AdminError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

// ----------------------------------------------------------------------------------------------- the system

/**
 * The real system. Tests pass their own (a temp `root` that system paths are mapped into, a fake `run`, a recording
 * `chown`), so nothing here needs real root, real users or real system files to be exercised.
 */
function realSystem() {
  return {
    platform: process.platform,
    root: '/',
    execPath: process.execPath,
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    env: process.env,
    now: () => new Date(),
    dryRun: false,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    /** Runs a program with a clean environment (fixed PATH, no caller variables). `input` goes to stdin only. */
    run(cmd, args, opts = {}) {
      const r = childProcess.spawnSync(cmd, args, {
        input: opts.input,
        encoding: 'utf8',
        env: { PATH: SAFE_PATH, LANG: 'C', ...(opts.env || {}) },
        stdio: opts.inherit ? 'inherit' : 'pipe',
        timeout: opts.timeoutMs || 120000,
      });
      return {
        code: r.error ? 127 : r.status === null ? 1 : r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || (r.error ? String(r.error.message) : ''),
      };
    },
    chown: (p, uid, gid) => fs.lchownSync(p, uid, gid),
    fchown: (fd, uid, gid) => fs.fchownSync(fd, uid, gid),
    pidAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e && e.code === 'EPERM';
      }
    },
    async ask(question) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise((resolve) => rl.question(question, resolve));
      } finally {
        rl.close();
      }
    },
  };
}

/** A system path mapped into the system root (the identity on a real machine). */
function P(sys, abs) {
  return sys.root === '/' ? abs : path.join(sys.root, abs);
}

function note(sys, line) {
  sys.out(line);
}

function mustRun(sys, cmd, args, opts = {}) {
  if (sys.dryRun && !opts.readOnly) {
    note(sys, `would run: ${[cmd, ...args].join(' ')}${opts.input ? ' (with input on stdin)' : ''}`);
    return { code: 0, stdout: '', stderr: '' };
  }
  const r = sys.run(cmd, args, opts);
  if (r.code !== 0 && !opts.allowFail)
    throw new AdminError(
      `${cmd} ${args[0] || ''} failed (exit ${r.code}): ${String(r.stderr).trim().slice(0, 400)}`,
    );
  return r;
}

// ----------------------------------------------------------------------------------------------- guards

/** [rv7-12] Only the bundled, root-owned Node may run this file (never /usr/bin/node, nvm or Homebrew). */
function checkInterpreter(sys, L = DEFAULT_LAYOUT) {
  if (sys.execPath !== L.nodePath)
    throw new AdminError(
      `guildwise-admin runs only under the bundled Node at ${L.nodePath} (this is ${sys.execPath}). Run it as \`sudo ${L.adminPath} ...\`.`,
      2,
    );
}

/**
 * The instance whose tools are running: the bundled Node of /usr/local/lib/guildwise/<name>/ belongs to instance
 * <name>; the top-level one (or any other interpreter, refused by checkInterpreter) to no instance.
 */
function toolsInstance(execPath) {
  const prefix = `${ADMIN_DIR}/`;
  const tail = '/node/bin/node';
  const p = String(execPath || '');
  if (!p.startsWith(prefix) || !p.endsWith(tail)) return null;
  const name = p.slice(prefix.length, p.length - tail.length);
  return INSTANCE_RE.test(name) && !RESERVED_INSTANCES.includes(name) ? name : null;
}

function checkRoot(sys) {
  if (sys.dryRun) return;
  if (sys.uid() !== 0)
    throw new AdminError(`guildwise-admin needs root: run it as \`sudo ${SELF_PATH} ...\`.`, 2);
}

function checkPlatform(sys) {
  if (!PLATFORMS.includes(sys.platform))
    throw new AdminError(
      `guildwise-admin supports Linux and macOS (inside the dedicated WSL distro on Windows); this is ${sys.platform}.`,
    );
}

function checkUserName(name) {
  if (!USER_RE.test(String(name || '')))
    throw new AdminError(`not a valid user name: ${JSON.stringify(name)}`);
  return name;
}

function checkSafeAbs(p, what) {
  if (!SAFE_ABS_RE.test(String(p || '')) || String(p).includes('..'))
    throw new AdminError(
      `${what} must be an absolute path of letters, digits, '.', '_', '-' and '/': ${JSON.stringify(p)}`,
    );
  return p;
}

// ----------------------------------------------------------------------------------------------- users

/** `{name, uid, gid, home}` or null. */
function lookupUser(sys, name) {
  checkUserName(name);
  if (sys.platform === 'darwin') {
    const r = sys.run('dscl', [
      '.',
      '-read',
      `/Users/${name}`,
      'UniqueID',
      'PrimaryGroupID',
      'NFSHomeDirectory',
    ]);
    if (r.code !== 0) return null;
    const get = (k) => {
      const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(r.stdout);
      return m ? m[1].trim() : '';
    };
    const uid = Number(get('UniqueID'));
    const gid = Number(get('PrimaryGroupID'));
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { name, uid, gid, home: get('NFSHomeDirectory') };
  }
  const r = sys.run('getent', ['passwd', name]);
  if (r.code !== 0) return null;
  const f = r.stdout.trim().split('\n')[0].split(':');
  if (f.length < 7 || f[0] !== name) return null;
  return { name, uid: Number(f[2]), gid: Number(f[3]), home: f[5] };
}

function requireUser(sys, name, hint) {
  const u = lookupUser(sys, name);
  if (!u) throw new AdminError(`user ${name} does not exist${hint ? `: ${hint}` : ''}`);
  return u;
}

function groupsOf(sys, name) {
  if (sys.platform === 'darwin') {
    const r = sys.run('id', ['-Gn', name]);
    return r.code === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean) : [];
  }
  const r = sys.run('id', ['-nG', name]);
  return r.code === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean) : [];
}

function removeFromGroup(sys, name, group) {
  if (sys.platform === 'darwin') mustRun(sys, 'dseditgroup', ['-o', 'edit', '-d', name, '-t', 'user', group]);
  else mustRun(sys, 'gpasswd', ['-d', name, group]);
}

function addToGroup(sys, name, group) {
  if (sys.platform === 'darwin') mustRun(sys, 'dseditgroup', ['-o', 'edit', '-a', name, '-t', 'user', group]);
  else mustRun(sys, 'usermod', ['-aG', group, name]);
}

/** Picks a free UniqueID below 500 (hidden from the login window), from the top down. */
function freeMacUid(sys) {
  const r = mustRun(sys, 'dscl', ['.', '-list', '/Users', 'UniqueID'], { readOnly: true });
  const used = new Set(
    r.stdout
      .split('\n')
      .map((l) => Number(l.trim().split(/\s+/)[1]))
      .filter((n) => Number.isInteger(n)),
  );
  for (let id = 499; id >= 400; id--) if (!used.has(id)) return id;
  throw new AdminError('no free user id between 400 and 499 for the hidden runner user');
}

/** R20 step 1: the dedicated user, not in sudo or docker, with its own HOME and `~/src` for its own clones. */
function userCreate(sys, opts = {}) {
  const L = opts.L || DEFAULT_LAYOUT;
  const name = checkUserName(opts.name || L.user);
  // it removes the account from admin groups: only ever the dedicated user, never a person's account
  if (name !== L.user) throw new AdminError(`user create is only for the dedicated ${L.user} user`);
  let u = lookupUser(sys, name);
  if (u) note(sys, `User ${name} exists (uid ${u.uid}, home ${u.home}).`);
  else if (sys.platform === 'darwin') {
    const uid = freeMacUid(sys);
    const rec = `/Users/${name}`;
    mustRun(sys, 'dscl', ['.', '-create', rec]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'UserShell', '/usr/bin/false']);
    mustRun(sys, 'dscl', [
      '.',
      '-create',
      rec,
      'RealName',
      L.instance ? `Guildwise runner ${L.instance}` : 'Guildwise runner',
    ]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'UniqueID', String(uid)]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'PrimaryGroupID', String(MAC_STAFF_GID)]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'NFSHomeDirectory', L.macHome]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'IsHidden', '1']);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'Password', '*']);
    u = { name, uid, gid: MAC_STAFF_GID, home: L.macHome };
    note(sys, `Created the hidden standard user ${name} (uid ${uid}, home ${L.macHome}).`);
  } else {
    mustRun(sys, 'useradd', ['--system', '--create-home', '--shell', '/usr/sbin/nologin', name]);
    u = sys.dryRun ? { name, uid: -1, gid: -1, home: `/home/${name}` } : requireUser(sys, name);
    note(sys, `Created the system user ${name} (home ${u.home}, no login shell).`);
  }
  if (!sys.dryRun || lookupUser(sys, name)) {
    for (const g of groupsOf(sys, name))
      if (PRIVILEGED_GROUPS.includes(g)) {
        removeFromGroup(sys, name, g);
        note(sys, `Removed ${name} from the ${g} group (it must not be root-equivalent).`);
      }
  }
  ensureOwnedDir(sys, u.home, u, 0o700);
  ensureOwnedDir(sys, path.posix.join(u.home, 'src'), u, 0o700);
  note(sys, `The runner works only in its own clones under ${path.posix.join(u.home, 'src')}.`);
  return u;
}

// ----------------------------------------------------------------------------------------------- files

/** Writes a root-owned file atomically (temp file in the same directory, then rename). */
function writeRootFile(sys, abs, content, mode) {
  if (sys.dryRun) {
    note(sys, `would write ${abs} (mode ${mode.toString(8)})`);
    return;
  }
  const real = P(sys, abs);
  fs.mkdirSync(path.dirname(real), { recursive: true, mode: 0o755 });
  // sudoers skips file names with a '.', so the temp file is never read by sudo
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.new`);
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(),
    mode,
  );
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, mode);
    sys.fchown(fd, 0, 0);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, real);
}

function noFollow() {
  return fs.constants.O_NOFOLLOW || 0;
}

function removeFile(sys, abs) {
  if (!fs.existsSync(P(sys, abs))) return false;
  if (sys.dryRun) note(sys, `would remove ${abs}`);
  else fs.rmSync(P(sys, abs), { force: true });
  return true;
}

/**
 * Every component of `abs` below `base` must be a real directory (no symlink), so a user cannot redirect a root write
 * out of their own HOME. Returns the mapped path.
 */
function assertNoSymlinkBelow(sys, base, abs) {
  const rel = path.posix.relative(base, abs);
  if (rel.startsWith('..') || path.posix.isAbsolute(rel))
    throw new AdminError(`${abs} is not inside ${base}`);
  let cur = base;
  for (const part of rel.split('/').filter(Boolean)) {
    cur = path.posix.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(P(sys, cur));
    } catch {
      return;
    }
    if (st.isSymbolicLink()) throw new AdminError(`refusing to follow the symlink ${cur}`);
  }
}

/** A directory owned by `u` with `mode` (no setgid, no group or other write). */
function ensureOwnedDir(sys, abs, u, mode) {
  if (sys.dryRun) {
    note(sys, `would ensure ${abs}/ (owner ${u.name}, mode ${mode.toString(8)})`);
    return;
  }
  const real = P(sys, abs);
  const st = fs.lstatSync(real, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw new AdminError(`${abs} exists and is not a directory`);
  if (!st) fs.mkdirSync(real, { mode });
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollow());
  try {
    sys.fchown(fd, u.uid, u.gid);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes a file owned by `u` inside `u`'s HOME without following symlinks (temp + rename). */
function writeUserFile(sys, u, abs, content, mode) {
  if (sys.dryRun) {
    note(sys, `would write ${abs} (owner ${u.name}, mode ${mode.toString(8)})`);
    return;
  }
  assertNoSymlinkBelow(sys, u.home, abs);
  const real = P(sys, abs);
  const dir = path.dirname(real);
  const tmp = path.join(dir, `.${path.basename(real)}.${process.pid}.new`);
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(),
    mode,
  );
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, mode);
    sys.fchown(fd, u.uid, u.gid);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, real);
}

/** Reads a small regular file owned by `uid` without following a symlink; null when absent. */
function readOwnedFile(sys, abs, uid, maxBytes = 1024 * 1024) {
  const real = P(sys, abs);
  const st = fs.lstatSync(real, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile()) throw new AdminError(`${abs} is not a regular file`);
  if (uid !== undefined && st.uid !== uid && !isTestOwner(sys, st.uid))
    throw new AdminError(`${abs} is not owned by the expected user`);
  if (st.size > maxBytes) throw new AdminError(`${abs} is too large`);
  const fd = fs.openSync(real, fs.constants.O_RDONLY | noFollow());
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Tests run unprivileged: their system lists the uid that owns every fixture file. */
function isTestOwner(sys, uid) {
  return Array.isArray(sys.ownerAliases) && sys.ownerAliases.includes(uid);
}

// ----------------------------------------------------------------------------------------------- service

/**
 * NoNewPrivileges for the runner unit (UAT 1.10.0 bug 6). Since 1.10.0 nothing the runner starts needs to gain privileges:
 * no sudo, and rootless Docker's setuid newuidmap runs in the runner's systemd USER service, not under this unit. The one
 * open point is bubblewrap (the agents' sandbox, `aom devops install`) on a host that restricts unprivileged user
 * namespaces (Ubuntu 24.04+), where bwrap gets its namespace through an AppArmor profile transition. So it is probed the
 * way the unit runs it: as the runner user, with no_new_privs set. `yes` when that works; `no` (as before) only where it
 * fails, with the reason printed.
 */
function noNewPrivilegesWorks(sys, u) {
  const r = sys.run(
    'setpriv',
    [
      '--reuid',
      String(u.uid),
      '--regid',
      String(u.gid),
      '--clear-groups',
      '--no-new-privs',
      '--',
      'bwrap',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--unshare-user',
      '--unshare-net',
      'true',
    ],
    { timeoutMs: 30000 },
  );
  return r.code === 0;
}

function unitText(u, runnerRoot, caFile = null, L = DEFAULT_LAYOUT, noNewPrivileges = false) {
  checkSafeAbs(runnerRoot, '--runner-root');
  checkSafeAbs(u.home, 'the runner HOME');
  if (caFile) checkSafeAbs(caFile, 'the CA file');
  return [
    '# Written by guildwise-admin (R20, R18-P). The runner runs as its own unprivileged user.',
    '[Unit]',
    `Description=Guildwise runner${L.instance ? ` ${L.instance}` : ''} (user ${u.name})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${u.name}`,
    `WorkingDirectory=${u.home}`,
    `Environment="HOME=${u.home}"`,
    `Environment="PATH=${u.home}/.local/bin:/usr/local/bin:/usr/bin:/bin"`,
    // a private CA in addition to the system ones; TLS verification stays on
    ...(caFile ? [`Environment="NODE_EXTRA_CA_CERTS=${caFile}"`] : []),
    `ExecStart="${runnerRoot}/current/aom-runner" start`,
    'Restart=always',
    'RestartSec=10',
    // the start-up refusal exits 78: no restart loop
    'RestartPreventExitStatus=78',
    // yes unless bubblewrap fails under it on this host (noNewPrivilegesWorks)
    `NoNewPrivileges=${noNewPrivileges ? 'yes' : 'no'}`,
    'ProtectSystem=full',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function plistText(u, runnerRoot, caFile = null, L = DEFAULT_LAYOUT) {
  checkSafeAbs(runnerRoot, '--runner-root');
  checkSafeAbs(u.home, 'the runner HOME');
  if (caFile) checkSafeAbs(caFile, 'the CA file');
  const s = (v) => `<string>${v}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${s(L.launchdLabel)}`,
    `  <key>UserName</key>${s(u.name)}`,
    '  <key>ProgramArguments</key>',
    `  <array>${s(`${runnerRoot}/current/aom-runner`)}${s('start')}</array>`,
    `  <key>WorkingDirectory</key>${s(u.home)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>HOME</key>${s(u.home)}`,
    `    <key>PATH</key>${s(`${u.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`)}`,
    ...(caFile ? [`    <key>NODE_EXTRA_CA_CERTS</key>${s(caFile)}`] : []),
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    // launchd has no "do not restart on exit 78": restart after a crash only, so the start-up refusal cannot loop
    '  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>StandardOutPath</key>${s(`${u.home}/Library/Logs/${L.logName}`)}`,
    `  <key>StandardErrorPath</key>${s(`${u.home}/Library/Logs/${L.logName}`)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function defaultRunnerRoot(u) {
  return path.posix.join(u.home, '.local/share/guildwise/runner');
}

/**
 * `--ca-file <pem>`: copies the certificate(s) to a root-owned RUNNER_CA_FILE (a snapshot: the runner cannot change what
 * its service trusts). Without the option a copy installed before is kept. Returns the path for the service, or null.
 */
function installRunnerCa(sys, caFile, L = DEFAULT_LAYOUT) {
  if (caFile) {
    checkSafeAbs(caFile, '--ca-file');
    const pem = readOwnedFile(sys, caFile, undefined, MAX_CA_FILE);
    if (pem === null) throw new AdminError(`--ca-file ${caFile} does not exist`);
    if (!pem.includes('-----BEGIN CERTIFICATE-----'))
      throw new AdminError(`--ca-file ${caFile} holds no PEM certificate`);
    if (/PRIVATE KEY/.test(pem))
      throw new AdminError(`--ca-file ${caFile} holds a private key: give the certificate only`);
    writeRootFile(sys, L.caFile, pem, 0o644);
    note(sys, `Wrote ${L.caFile} (the runner service trusts this certificate authority as well).`);
    return L.caFile;
  }
  return fs.existsSync(P(sys, L.caFile)) ? L.caFile : null;
}

function serviceInstall(sys, opts = {}) {
  const L = opts.L || DEFAULT_LAYOUT;
  const u = requireUser(sys, opts.user || L.user, `run \`${adminHint(L, ['user', 'create'])}\` first`);
  // an instance's service runs only as that instance's user (never the other instance's, never a person)
  if (L.instance && u.name !== L.user)
    throw new AdminError(`the service of instance ${L.instance} runs only as ${L.user}`);
  const runnerRoot = opts.runnerRoot || defaultRunnerRoot(u);
  checkSafeAbs(runnerRoot, '--runner-root');
  if (L.instance) checkInsideHome(u, runnerRoot, '--runner-root');
  const ca = installRunnerCa(sys, opts.caFile, L);
  if (sys.platform === 'darwin') {
    writeRootFile(sys, L.launchdPlist, plistText(u, runnerRoot, ca, L), 0o644);
    ensureOwnedDir(sys, path.posix.join(u.home, 'Library'), u, 0o700);
    ensureOwnedDir(sys, path.posix.join(u.home, 'Library/Logs'), u, 0o700);
    note(sys, `Wrote ${L.launchdPlist} (LaunchDaemon, UserName ${u.name}).`);
    if (opts.start) {
      mustRun(sys, 'launchctl', ['bootstrap', 'system', L.launchdPlist], { allowFail: true });
      mustRun(sys, 'launchctl', ['enable', `system/${L.launchdLabel}`]);
      mustRun(sys, 'launchctl', ['kickstart', '-k', `system/${L.launchdLabel}`]);
    }
    return;
  }
  const nnp = noNewPrivilegesWorks(sys, u);
  writeRootFile(sys, L.systemdUnit, unitText(u, runnerRoot, ca, L, nnp), 0o644);
  note(sys, `Wrote ${L.systemdUnit} (system unit, User=${u.name}).`);
  note(
    sys,
    nnp
      ? 'NoNewPrivileges=yes: nothing the runner starts can gain privileges.'
      : `NoNewPrivileges=no: bubblewrap could not start as ${u.name} with no_new_privs on this host (an AppArmor user-namespace rule?), and the agents' sandbox needs it.`,
  );
  mustRun(sys, 'systemctl', ['daemon-reload']);
  mustRun(sys, 'systemctl', opts.start ? ['enable', '--now', L.service] : ['enable', L.service]);
}

function serviceRemove(sys, opts = {}) {
  const L = opts.L || DEFAULT_LAYOUT;
  if (sys.platform === 'darwin') {
    mustRun(sys, 'launchctl', ['bootout', `system/${L.launchdLabel}`], { allowFail: true });
    if (removeFile(sys, L.launchdPlist)) note(sys, `Removed ${L.launchdPlist}.`);
    return;
  }
  mustRun(sys, 'systemctl', ['disable', '--now', L.service], { allowFail: true });
  if (removeFile(sys, L.systemdUnit)) note(sys, `Removed ${L.systemdUnit}.`);
  mustRun(sys, 'systemctl', ['daemon-reload']);
}

/** `abs` lies inside the user's HOME (an instance's runner root and data never reach another account). */
function checkInsideHome(u, abs, what) {
  const rel = path.posix.relative(u.home, abs);
  if (rel === '' || rel.startsWith('..') || path.posix.isAbsolute(rel))
    throw new AdminError(`${what} must be inside ${u.home} (the home of ${u.name}): ${abs}`);
  return abs;
}

// ----------------------------------------------------------------------------------------------- runner data

function runnerDataRoot(u, dataDir) {
  if (!dataDir) return path.posix.join(u.home, '.aom-runner');
  const abs = path.posix.isAbsolute(dataDir) ? dataDir : path.posix.join(u.home, dataDir);
  const rel = path.posix.relative(u.home, abs);
  if (rel.startsWith('..')) throw new AdminError(`--data-dir must be inside ${u.home}`);
  return abs;
}

const PAIRING_DIR_RE = /^(\.|pairings\/[a-z0-9][a-z0-9-]{0,63})$/;

/** The data directory of every pairing (`pairings.json`, else the data root itself). */
function pairingDirs(sys, u, dataRoot) {
  const text = readOwnedFile(sys, path.posix.join(dataRoot, 'pairings.json'), u.uid);
  if (!text) return [dataRoot];
  let index;
  try {
    index = JSON.parse(text);
  } catch {
    throw new AdminError(`${dataRoot}/pairings.json is not valid JSON`);
  }
  const dirs = [];
  for (const e of Array.isArray(index.pairings) ? index.pairings : []) {
    if (!e || typeof e.dir !== 'string' || !PAIRING_DIR_RE.test(e.dir)) continue;
    dirs.push(e.dir === '.' ? dataRoot : path.posix.join(dataRoot, e.dir));
  }
  return dirs.length > 0 ? [...new Set(dirs)] : [dataRoot];
}

// ----------------------------------------------------------------------------------------------- docker

/** `stat` of a system path (tests may give their own, since a fixture cannot be owned by another group). */
function statOf(sys, abs) {
  try {
    return (sys.stat || fs.statSync)(P(sys, abs));
  } catch {
    return null;
  }
}

/** The real path of a system path inside the system root, as an absolute system path; null when missing. */
function realOf(sys, abs) {
  try {
    const real = fs.realpathSync(P(sys, abs));
    if (sys.root === '/') return real;
    const rel = path.relative(fs.realpathSync(sys.root), real);
    return rel.startsWith('..') ? null : `/${rel.split(path.sep).join('/')}`;
  } catch {
    return null;
  }
}

/** Group name of a gid (`getent group <gid>`), or the number as text. */
function groupName(sys, gid) {
  const r = sys.run('getent', ['group', String(gid)]);
  const name = r.code === 0 ? r.stdout.trim().split(':')[0] : '';
  return name || String(gid);
}

/** Every Docker socket on the machine: the default ones and `/run/<x>/docker.sock`, by real path, with owner and group. */
function dockerSockets(sys) {
  const cands = [...DOCKER_SOCKETS];
  try {
    for (const d of fs.readdirSync(P(sys, '/run'), { withFileTypes: true }))
      if (d.isDirectory() && d.name !== 'user') cands.push(`/run/${d.name}/docker.sock`);
  } catch {
    // no /run
  }
  const seen = new Map();
  for (const c of cands) {
    const real = realOf(sys, c);
    if (!real || seen.has(real)) continue;
    const st = statOf(sys, real);
    if (st) seen.set(real, { path: c, real, uid: st.uid, gid: st.gid });
  }
  return [...seen.values()];
}

/**
 * The docker CLI root may run: the pinned binary in this runner's root-owned folder, else /usr/bin/docker; each must
 * resolve to a regular file owned by root and not writable by group or others (S1).
 */
function trustedDockerCli(sys, L) {
  for (const c of [`${L.dockerDir}/docker`, '/usr/bin/docker']) {
    try {
      const st = fs.statSync(fs.realpathSync(P(sys, c)));
      if (st.isFile() && st.uid === (sys.rootUid ?? 0) && !(st.mode & 0o022)) return c;
    } catch {
      // not there
    }
  }
  return null;
}

/** The groups that own a Docker socket, plus `docker`: membership of any of them reaches another daemon. */
function dockerSocketGroups(sys) {
  return [...new Set(['docker', ...dockerSockets(sys).map((s) => groupName(sys, s.gid))])];
}

function parseSubids(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^([^:#\s]+):(\d+):(\d+)\s*$/.exec(line.trim());
    if (m) out.push({ name: m[1], start: Number(m[2]), count: Number(m[3]) });
  }
  return out;
}

/** The next free range: aligned to SUBID_COUNT, at or above SUBID_FLOOR and after every existing entry of both files. */
function nextSubidStart(entries) {
  const end = entries.reduce((m, e) => Math.max(m, e.start + e.count), SUBID_FLOOR);
  return Math.ceil(end / SUBID_COUNT) * SUBID_COUNT;
}

function readSystemFile(sys, abs) {
  try {
    return fs.readFileSync(P(sys, abs), 'utf8');
  } catch {
    return '';
  }
}

/** A subuid/subgid range for the user (skipped when it has one). */
function ensureSubids(sys, u) {
  const uids = parseSubids(readSystemFile(sys, '/etc/subuid'));
  const gids = parseSubids(readSystemFile(sys, '/etc/subgid'));
  if (uids.some((e) => e.name === u.name) && gids.some((e) => e.name === u.name)) {
    note(sys, `${u.name} already has a subordinate id range.`);
    return null;
  }
  const start = nextSubidStart([...uids, ...gids]);
  const range = `${start}-${start + SUBID_COUNT - 1}`;
  mustRun(sys, 'usermod', ['--add-subuids', range, '--add-subgids', range, u.name]);
  note(
    sys,
    `Gave ${u.name} the subordinate ids ${range} (its rootless Docker maps container users into them).`,
  );
  return range;
}

function apparmorText(L) {
  return [
    '# Written by guildwise-admin (deps-without-sudo): only the root-owned rootlesskit of this runner may create',
    '# user namespaces (Ubuntu 24.04+ restricts them); a copy the runner makes gets no grant.',
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile ${path.posix.basename(L.apparmorProfile)} "${L.dockerDir}/rootlesskit" flags=(unconfined) {`,
    '  userns,',
    '',
    `  include if exists <local/${path.posix.basename(L.apparmorProfile)}>`,
    '}',
    '',
  ].join('\n');
}

/**
 * F2: the profile only where unprivileged user namespaces are restricted (`apparmor_restrict_unprivileged_userns` = 1,
 * AppArmor 4); on an AppArmor 3 host (Debian 12) `abi <abi/4.0>` and `userns,` do not parse, and nothing needs them.
 */
function ensureAppArmor(sys, L) {
  const flag = readSystemFile(sys, '/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim();
  if (flag !== '1') {
    note(sys, 'Unprivileged user namespaces are not restricted here: no AppArmor profile needed.');
    return false;
  }
  writeRootFile(sys, L.apparmorProfile, apparmorText(L), 0o644);
  mustRun(sys, 'apparmor_parser', ['-r', L.apparmorProfile]);
  note(sys, `Wrote and loaded ${L.apparmorProfile} (user namespaces for ${L.dockerDir}/rootlesskit only).`);
  return true;
}

function macAclEntries(user, socket) {
  const m = DESKTOP_SOCKET_RE.exec(socket);
  const home = `/Users/${m[1]}`;
  return [
    [`${user} allow search`, home],
    [`${user} allow search`, `${home}/.docker`],
    [`${user} allow list,search,add_file,read,write,append,file_inherit`, `${home}/.docker/run`],
    [`${user} allow read,write,append`, socket],
  ];
}

/**
 * Writes the root-recorded acceptance of a shared rootless daemon into the runner's policy.json (owner decision
 * 2026-11-21: "The uat runner will use the rootless docker already installed"). Root writes it at install, after the
 * typed acceptance; the start-up check then only warns for exactly that socket (and only while the daemon is rootless).
 */
function recordSharedDocker(sys, u, socket, group) {
  const file = path.posix.join(u.home, POLICY_REL);
  assertNoSymlinkBelow(sys, u.home, file);
  let policy = {};
  const text = readOwnedFile(sys, file, u.uid);
  if (text) {
    try {
      policy = JSON.parse(text);
    } catch {
      throw new AdminError(`${file} is not valid JSON: fix or remove it, then run this again`);
    }
  }
  policy.docker = 'shared';
  policy.dockerHost = `unix://${socket}`;
  policy.sharedDocker = { socket, group, acceptedAt: sys.now().toISOString() };
  ensureOwnedDir(sys, path.posix.join(u.home, '.config'), u, 0o700);
  ensureOwnedDir(sys, path.posix.dirname(file), u, 0o700);
  writeUserFile(sys, u, file, `${JSON.stringify(policy, null, 2)}\n`, 0o600);
  note(sys, `Recorded the accepted shared Docker daemon ${socket} in ${file}.`);
}

/**
 * The runner's Docker (DESIGN deps-without-sudo §3):
 *   rootless  its own rootless daemon: out of every group that owns a Docker socket, a subuid range, the AppArmor
 *             profile where needed, linger (the daemon is Docker's systemd user service). The binaries are root-owned
 *             in L.dockerDir; `setup_runner_docker` then runs as the runner.
 *   host      the installed daemon (root-equivalent; --accept-root-equivalent): the group of the real
 *             /var/run/docker.sock (never gid 0). macOS: ACLs on the logged-in user's Docker Desktop socket.
 *   shared    a rootless daemon of another user (`--docker-socket`; --accept-shared-daemon): its socket's group, and
 *             the acceptance recorded in policy.json.
 *   none      undoes the above (the subuid range stays).
 * F1: when the runner is the installing person (current-user mode), groups are never changed for rootless or none.
 */
function dockerSet(sys, mode, opts = {}) {
  if (!['rootless', 'host', 'shared', 'none'].includes(mode))
    throw new AdminError('docker mode must be rootless, host, shared or none');
  const L = opts.L || DEFAULT_LAYOUT;
  const u = requireUser(sys, opts.user || L.user);
  if (L.instance && u.name !== L.user)
    throw new AdminError(`the Docker set-up of instance ${L.instance} is only for ${L.user}`);
  const dedicated = u.name === L.user;
  const mac = sys.platform === 'darwin';
  const leaveSocketGroups = () => {
    if (!dedicated) return;
    const mine = groupsOf(sys, u.name);
    for (const g of dockerSocketGroups(sys))
      if (mine.includes(g)) {
        removeFromGroup(sys, u.name, g);
        note(sys, `Removed ${u.name} from the group ${g} (it reaches another Docker daemon).`);
      }
  };

  if (mode === 'rootless') {
    if (mac)
      throw new AdminError(
        'macOS has no rootless Docker: use Docker Desktop with `docker host --desktop-socket <path>`, or none',
      );
    leaveSocketGroups();
    if (!dedicated)
      note(
        sys,
        `${u.name} is the person installing: their groups are left alone (the start-up check judges them).`,
      );
    ensureSubids(sys, u);
    ensureAppArmor(sys, L);
    mustRun(sys, 'loginctl', ['enable-linger', u.name]);
    note(
      sys,
      `${u.name} gets its own rootless Docker (run \`setup_runner_docker\` as ${u.name}; binaries in ${L.dockerDir}).`,
    );
    return { mode };
  }

  if (mode === 'host') {
    if (!opts.acceptRootEquivalent)
      throw new AdminError(
        'the installed Docker daemon makes the runner root-equivalent: add --accept-root-equivalent if you accept that (rootless is the safer choice)',
      );
    if (mac) {
      const socket = String(opts.desktopSocket || '');
      if (!DESKTOP_SOCKET_RE.test(socket))
        throw new AdminError(
          'docker host on macOS needs --desktop-socket /Users/<user>/.docker/run/docker.sock',
        );
      for (const [acl, target] of macAclEntries(u.name, socket)) mustRun(sys, 'chmod', ['+a', acl, target]);
      note(
        sys,
        `${u.name} may use the Docker Desktop socket ${socket} (root-equivalent inside Docker Desktop; containers can read and write the folders it shares). Not yet tested on hardware.`,
      );
      return { mode, socket };
    }
    const real = realOf(sys, '/var/run/docker.sock') || realOf(sys, '/run/docker.sock');
    const st = real && statOf(sys, real);
    if (!st)
      throw new AdminError('no Docker socket at /var/run/docker.sock: is Docker installed and running?');
    if (st.gid === 0)
      throw new AdminError(
        `${real} belongs to group root: adding ${u.name} to it would make it root, refused`,
      );
    const group = groupName(sys, st.gid);
    if (!groupsOf(sys, u.name).includes(group)) addToGroup(sys, u.name, group);
    note(sys, `${u.name} is in the group ${group} of ${real}: the runner is root-equivalent (accepted).`);
    return { mode, socket: real, group };
  }

  if (mode === 'shared') {
    if (mac) throw new AdminError('a shared rootless daemon is a Linux set-up; on macOS use docker host');
    if (!opts.acceptSharedDaemon)
      throw new AdminError(
        'a shared Docker daemon lets the runner control every container on it: add --accept-shared-daemon if you accept that',
      );
    const given = String(opts.dockerSocket || '');
    if (!SHARED_SOCKET_RE.test(given))
      throw new AdminError('docker shared needs --docker-socket /run/<name>/docker.sock');
    // S1: everything is judged on the canonical path: a link to the default socket (or anywhere else) is refused
    const real = realOf(sys, given);
    const st = real && statOf(sys, real);
    if (!st) throw new AdminError(`${given} does not exist`);
    if (!SHARED_SOCKET_RE.test(real) || DOCKER_SOCKETS.includes(real))
      throw new AdminError(`${given} resolves to ${real}, which is not a shared daemon's socket: refused`);
    if (st.gid === 0) throw new AdminError(`${real} belongs to group root: refused`);
    if (st.uid === u.uid) throw new AdminError(`${real} is ${u.name}'s own socket: use docker rootless`);
    const group = groupName(sys, st.gid);
    if (group === 'docker')
      throw new AdminError(`${real} belongs to the docker group (root-equivalent): use docker host, refused`);
    // S1: as root, ask the daemon itself (through a root-owned docker CLI, never PATH) whether it runs rootless,
    // before any group changes; a refusal leaves the groups as they were
    const cli = trustedDockerCli(sys, L);
    if (!cli)
      throw new AdminError(
        `no root-owned docker CLI to ask ${real} with (${L.dockerDir}/docker or /usr/bin/docker): re-run the installer`,
      );
    const info = sys.run(cli, ['-H', `unix://${real}`, 'info', '--format', '{{json .SecurityOptions}}']);
    if (info.code !== 0 || !/name=rootless/.test(String(info.stdout)))
      throw new AdminError(
        `the daemon at ${real} does not run rootless: refused (use docker host for a root daemon)`,
      );
    if (!groupsOf(sys, u.name).includes(group)) addToGroup(sys, u.name, group);
    recordSharedDocker(sys, u, real, group);
    note(
      sys,
      `${u.name} is in the group ${group} of ${real}: it can control every container on that daemon (accepted). Runners that share a daemon can each control the other's containers; this typed acceptance records that you chose it.`,
    );
    return { mode, socket: real, group };
  }

  // none
  if (mac) {
    const socket = String(opts.desktopSocket || '');
    if (DESKTOP_SOCKET_RE.test(socket))
      for (const [acl, target] of macAclEntries(u.name, socket))
        mustRun(sys, 'chmod', ['-a', acl, target], { allowFail: true });
    note(sys, 'The runner has no Docker access.');
    return { mode };
  }
  leaveSocketGroups();
  if (removeFile(sys, L.apparmorProfile)) {
    mustRun(sys, 'apparmor_parser', ['-R', L.apparmorProfile], { allowFail: true });
    note(sys, `Removed ${L.apparmorProfile}.`);
  }
  if (dedicated) mustRun(sys, 'loginctl', ['disable-linger', u.name], { allowFail: true });
  note(sys, 'The runner has no Docker access.');
  return { mode };
}

// ----------------------------------------------------------------------------------------------- cleanup-legacy

/**
 * What 1.10.0 removed, cleaned up on every install (idempotent): the sudoers files, a password the dedicated user had
 * for sudo (locked), the deploy-compose helper and its approvals, and the sealed sudo password in every pairing, which
 * is deleted and never opened. Apps narrow mode started are left running, with how to stop them.
 */
function cleanupLegacy(sys, opts = {}) {
  const L = opts.L || DEFAULT_LAYOUT;
  for (const f of [L.sudoersSudo, L.sudoersDocker])
    if (removeFile(sys, f)) note(sys, `Removed ${f} (sudo was removed in 1.10.0).`);
  for (const d of [L.deployCompose, L.appsConfDir]) {
    const real = P(sys, d);
    const st = fs.lstatSync(real, { throwIfNoEntry: false });
    if (!st) continue;
    if (sys.dryRun) note(sys, `would remove ${d}`);
    else fs.rmSync(real, { recursive: true, force: true });
    note(sys, `Removed ${d} (narrow mode was removed in 1.10.0).`);
  }
  const u = lookupUser(sys, opts.user || L.user);
  if (u && u.name === L.user) {
    if (sys.platform === 'darwin')
      mustRun(sys, 'dscl', ['.', '-create', `/Users/${u.name}`, 'Password', '*']);
    else mustRun(sys, 'usermod', ['-L', u.name], { allowFail: true });
  }
  if (u) {
    const dataRoot = runnerDataRoot(u, opts.dataDir);
    if (fs.existsSync(P(sys, dataRoot)))
      for (const dir of pairingDirs(sys, u, dataRoot)) {
        const f = path.posix.join(dir, 'secrets/sudo.enc');
        // never opened: refuse a link the runner planted, then unlink
        assertNoSymlinkBelow(sys, u.home, f);
        const st = fs.lstatSync(P(sys, f), { throwIfNoEntry: false });
        if (!st) continue;
        if (sys.dryRun) note(sys, `would remove ${f}`);
        else fs.unlinkSync(P(sys, f));
        note(sys, `Removed the sealed sudo password file ${f} (sudo was removed in 1.10.0).`);
      }
  }
  if (fs.existsSync(P(sys, L.appsStateDir)))
    note(
      sys,
      `Apps approved for narrow mode are left as they are in ${L.appsStateDir}; stop them with \`docker compose -p <project> down\` as root when you no longer need them.`,
    );
}

// ----------------------------------------------------------------------------------------------- readers (fetch route)

/** `git --version` text -> [major, minor, patch]. */
function parseGitVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function versionAtLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (min[i] || 0)) return true;
    if ((v[i] || 0) < (min[i] || 0)) return false;
  }
  return true;
}

/** [rv7-13] The fetch route needs git >= 2.45.1 (the CVE-2024-32004 class of local-clone issues). */
const MIN_FETCH_GIT = [2, 45, 1];

function groupGid(sys, group) {
  if (sys.platform === 'darwin') {
    const r = sys.run('dscl', ['.', '-read', `/Groups/${group}`, 'PrimaryGroupID']);
    const m = /PrimaryGroupID:\s*(\d+)/.exec(r.stdout || '');
    return r.code === 0 && m ? Number(m[1]) : null;
  }
  const r = sys.run('getent', ['group', group]);
  if (r.code !== 0) return null;
  const f = r.stdout.trim().split(':');
  return f.length >= 3 ? Number(f[2]) : null;
}

/**
 * Walks `abs` (inside the runner's HOME) without following symlinks and makes every entry the runner owns
 * group-readable (and directories group-searchable) for `gid`; never group-writable, never setgid. Entries owned by
 * anyone else are left alone.
 */
function shareReadOnly(sys, u, abs, gid, counts = { changed: 0, skipped: 0 }) {
  const real = P(sys, abs);
  const st = fs.lstatSync(real, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) return counts;
  if (st.uid !== u.uid && !isTestOwner(sys, st.uid)) {
    counts.skipped++;
    return counts;
  }
  const fd = fs.openSync(
    real,
    fs.constants.O_RDONLY | noFollow() | (st.isDirectory() ? fs.constants.O_DIRECTORY || 0 : 0),
  );
  try {
    const cur = fs.fstatSync(fd);
    if (cur.ino !== st.ino) return counts;
    // owner bits kept; group read (+search on dirs, +x where the owner has x); no group/other write; no setuid/setgid/sticky
    let mode = cur.mode & 0o700;
    mode |= 0o040;
    if (cur.isDirectory() || cur.mode & 0o100) mode |= 0o010;
    sys.fchown(fd, u.uid, gid);
    fs.fchmodSync(fd, mode);
    counts.changed++;
  } finally {
    fs.closeSync(fd);
  }
  if (st.isDirectory())
    for (const name of fs.readdirSync(real)) shareReadOnly(sys, u, path.posix.join(abs, name), gid, counts);
  return counts;
}

/** Git repositories (folders with `.git`) directly under the clones folder: the exact `safe.directory` entries. */
function reposUnder(sys, abs) {
  const out = [];
  const real = P(sys, abs);
  for (const name of fs.existsSync(real) ? fs.readdirSync(real) : []) {
    const p = path.posix.join(abs, name);
    const st = fs.lstatSync(P(sys, p));
    if (st.isDirectory() && fs.existsSync(P(sys, path.posix.join(p, '.git')))) out.push(p);
  }
  return out.sort();
}

function readersAdd(sys, human, opts = {}) {
  const L = opts.L || DEFAULT_LAYOUT;
  const READERS_GROUP = L.readersGroup;
  checkUserName(human);
  if (human === L.user) throw new AdminError('the runner user does not need read access to itself');
  // a runner user never reads another runner's clones (two instances stay apart)
  if (human === RUNNER_USER || human.startsWith(`${RUNNER_USER}-`))
    throw new AdminError(`${human} is a runner user: runners never read each other's clones`);
  const h = requireUser(sys, human);
  const u = requireUser(sys, opts.user || L.user);
  const srcRoot = path.posix.join(u.home, 'src');
  const clones = opts.path ? checkSafeAbs(opts.path, '--path') : srcRoot;
  const rel = path.posix.relative(srcRoot, clones);
  if (rel.startsWith('..') || path.posix.isAbsolute(rel))
    throw new AdminError(
      `only the runner's own clones (${srcRoot} or below) can be shared; ${clones} is not`,
    );
  assertNoSymlinkBelow(sys, u.home, clones);
  const gv = parseGitVersion(mustRun(sys, 'git', ['--version'], { readOnly: true, allowFail: true }).stdout);
  if (!gv || !versionAtLeast(gv, MIN_FETCH_GIT))
    throw new AdminError(
      `fetching from the runner's clones needs git 2.45.1 or newer (found ${gv ? gv.join('.') : 'none'}); use the default route instead: the runner pushes branches to the remote`,
    );
  let gid = groupGid(sys, READERS_GROUP);
  if (gid === null) {
    if (sys.platform === 'darwin')
      mustRun(sys, 'dseditgroup', ['-o', 'create', '-r', 'Guildwise readers', READERS_GROUP]);
    else mustRun(sys, 'groupadd', ['--system', READERS_GROUP]);
    gid = sys.dryRun ? -1 : groupGid(sys, READERS_GROUP);
    if (gid === null) throw new AdminError(`could not create the ${READERS_GROUP} group`);
  }
  if (!groupsOf(sys, h.name).includes(READERS_GROUP)) addToGroup(sys, h.name, READERS_GROUP);
  if (sys.dryRun)
    note(sys, `would make ${u.home} searchable and ${clones} readable (not writable) for ${READERS_GROUP}`);
  else {
    // HOME: owner full, group search only (no listing, no write)
    const fd = fs.openSync(
      P(sys, u.home),
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollow(),
    );
    try {
      sys.fchown(fd, u.uid, gid);
      fs.fchmodSync(fd, 0o710);
    } finally {
      fs.closeSync(fd);
    }
    const c = shareReadOnly(sys, u, clones, gid);
    note(
      sys,
      `${clones}: ${c.changed} entries readable by ${READERS_GROUP} (never writable), ${c.skipped} not owned by ${u.name} left alone.`,
    );
  }
  note(
    sys,
    `${h.name} can fetch from the runner's clones after logging in again. Add each repository you fetch from, exactly (never '*'):`,
  );
  // folder names are the runner's: only plain ones become paste-ready lines (no `;`, spaces, quotes, newlines, escapes)
  for (const repo of reposUnder(sys, clones)) {
    if (SAFE_ABS_RE.test(repo) && !repo.includes('..'))
      note(sys, `  git config --global --add safe.directory ${repo}`);
    else note(sys, `  not listed (unusual characters in the folder name): ${JSON.stringify(repo)}`);
  }
  note(sys, `  then: git fetch ${clones}/<repo> <branch>   (fetching runs no hooks)`);
}

function readersRemove(sys, human, opts = {}) {
  const L = opts.L || DEFAULT_LAYOUT;
  const h = requireUser(sys, checkUserName(human));
  if (groupsOf(sys, h.name).includes(L.readersGroup)) removeFromGroup(sys, h.name, L.readersGroup);
  const u = lookupUser(sys, opts.user || L.user);
  note(sys, `${h.name} no longer reads the runner's clones${u ? ` in ${u.home}/src` : ''}.`);
}

// ----------------------------------------------------------------------------------------------- migrate-user

function compareVersions(a, b) {
  const pa = String(a)
    .split(/[.-]/)
    .map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b)
    .split(/[.-]/)
    .map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

/** The version the old install's `current` link points at (`<root>/<version>/aom-runner`), or null. */
function installedRunnerVersion(sys, home) {
  const cur = P(sys, path.posix.join(home, '.local/share/guildwise/runner/current'));
  try {
    const target = fs.readlinkSync(cur);
    const parts = target.split('/').filter(Boolean);
    const v = parts[parts.length - 2];
    return v && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Why the old runner may not be migrated now (a shift or deploy running, or the runner itself), or null. */
function busyReason(sys, from, dirs) {
  for (const dir of dirs) {
    const status = readOwnedFile(sys, path.posix.join(dir, 'status.json'), from.uid);
    if (status) {
      let s = {};
      try {
        s = JSON.parse(status);
      } catch {
        // unreadable status: rely on the other checks
      }
      if (Number.isInteger(s.pid) && sys.pidAlive(s.pid))
        return `the runner of ${from.name} is still running (pid ${s.pid}): stop it first (\`systemctl --user stop aom-runner\` or quit the tray)`;
      if (typeof s.activeShifts === 'number' && s.activeShifts > 0)
        return `${s.activeShifts} shift(s) are running`;
    }
    const active = P(sys, path.posix.join(dir, 'active-shifts'));
    if (fs.existsSync(active) && fs.readdirSync(active).length > 0)
      return 'a shift was running when the runner stopped: start the runner, let it finish, then stop it again';
    const deploys = P(sys, path.posix.join(dir, 'deploys'));
    for (const run of fs.existsSync(deploys) ? fs.readdirSync(deploys) : []) {
      const d = path.join(deploys, run);
      if (fs.existsSync(path.join(d, 'started.json')) && !fs.existsSync(path.join(d, 'result.json')))
        return `deploy ${run} is running`;
    }
  }
  return null;
}

const SECRET_NAMES = new Set(['config.json', 'pairings.json', 'policy.json']);

/** Files that hold secrets (anything under a `secrets/` folder, the configs with the runner token) get 0600 / 0700. */
function isSecretPath(rel) {
  const parts = rel.split('/');
  return parts.includes('secrets') || SECRET_NAMES.has(parts[parts.length - 1]);
}

/**
 * Copies `src` (owned by `from`) to `dst` (owned by `to`) without ever following a symlink: symlinks are recreated as
 * symlinks, entries not owned by `from` and special files are skipped, setuid/setgid and group/other write are dropped,
 * secrets end at 0600 (dirs 0700).
 */
function copyTree(sys, from, to, src, dst, opts, stats, rel = '') {
  const st = fs.lstatSync(P(sys, src), { throwIfNoEntry: false });
  if (!st) return;
  if (opts.skip?.(rel)) return;
  if (st.uid !== from.uid && !isTestOwner(sys, st.uid)) {
    stats.skipped.push(`${src} (not owned by ${from.name})`);
    return;
  }
  const secret = isSecretPath(rel) || opts.allSecret;
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(P(sys, src));
    fs.symlinkSync(target, P(sys, dst));
    sys.chown(P(sys, dst), to.uid, to.gid);
    stats.links++;
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(P(sys, dst), { mode: 0o700 });
    // mode and owner are set on the opened directory, never by path (a symlink swapped in after mkdir is refused)
    const dirFd = fs.openSync(
      P(sys, dst),
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollow(),
    );
    try {
      fs.fchmodSync(dirFd, 0o700);
    } finally {
      fs.closeSync(dirFd);
    }
    for (const name of fs.readdirSync(P(sys, src)))
      copyTree(
        sys,
        from,
        to,
        path.posix.join(src, name),
        path.posix.join(dst, name),
        opts,
        stats,
        rel ? `${rel}/${name}` : name,
      );
    const mode = secret || rel === '' ? 0o700 : st.mode & 0o755;
    const fd = fs.openSync(P(sys, dst), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollow());
    try {
      fs.fchmodSync(fd, mode);
      sys.fchown(fd, to.uid, to.gid);
    } finally {
      fs.closeSync(fd);
    }
    stats.dirs++;
    return;
  }
  if (!st.isFile()) {
    stats.skipped.push(`${src} (not a regular file)`);
    return;
  }
  if (st.size > MAX_COPY_FILE) {
    stats.skipped.push(`${src} (larger than ${MAX_COPY_FILE} bytes)`);
    return;
  }
  const mode = secret ? 0o600 : st.mode & 0o755;
  const inFd = fs.openSync(P(sys, src), fs.constants.O_RDONLY | noFollow());
  try {
    // the file opened must be the one checked (no swap between lstat and open)
    const cur = fs.fstatSync(inFd);
    if (!cur.isFile() || cur.ino !== st.ino || cur.dev !== st.dev) {
      stats.skipped.push(`${src} (changed while copying)`);
      return;
    }
    const outFd = fs.openSync(
      P(sys, dst),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(),
      mode,
    );
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = fs.readSync(inFd, buf, 0, buf.length, null);
        if (n <= 0) break;
        fs.writeSync(outFd, buf, 0, n);
      }
      fs.fchmodSync(outFd, mode);
      sys.fchown(outFd, to.uid, to.gid);
    } finally {
      fs.closeSync(outFd);
    }
  } finally {
    fs.closeSync(inFd);
  }
  stats.files++;
  if (secret) stats.secrets++;
}

/** Replaces the old HOME prefix in every string of a JSON value (repo roots, login folders, ...). */
function rewriteHome(value, oldHome, newHome) {
  if (typeof value === 'string') {
    if (value === oldHome) return newHome;
    if (value.startsWith(`${oldHome}/`)) return newHome + value.slice(oldHome.length);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteHome(v, oldHome, newHome));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteHome(v, oldHome, newHome);
    return out;
  }
  return value;
}

function loginsToRedo(sys, to) {
  const as = `sudo -u ${to.name} -H`;
  const lines =
    sys.platform === 'darwin'
      ? [
          `${as} claude setup-token   (then pipe the token into \`${as} guildwise-runner auth oauth-token\`)`,
          `${as} gh auth login --insecure-storage`,
        ]
      : [`${as} claude   (sign in, then /exit)`, `${as} gh auth login`];
  return [
    ...lines,
    `git credentials or SSH keys for your remotes, as ${to.name} (never copied)`,
    `cloud CLIs the runner used (aws, gcloud, az, ...), as ${to.name} (never copied)`,
  ];
}

/**
 * [rv6-5] Moves a 1.10.0 current-user install to the dedicated user: refuses while a shift or deploy runs and refuses
 * state from a runner below the floor; copies the data dir, its own clones and the policy (secrets 0600, owned by the
 * new user), and prints the logins to redo. `--finish`, after the first good start as the new user, deletes the old
 * user's copies of the token, the sealed sudo password, the runner's Claude and git credentials and policy.json.
 */
function migrateUser(sys, opts = {}) {
  if (opts.finish) return migrateFinish(sys, opts);
  const L = opts.L || DEFAULT_LAYOUT;
  const MIGRATE_MARKER = L.migrateMarker;
  const fromName = opts.from || sys.env.SUDO_USER;
  if (!fromName) throw new AdminError('name the user whose runner to move: --from <user>');
  const from = requireUser(sys, fromName);
  const to = requireUser(sys, opts.to || L.user, `run \`${adminHint(L, ['user', 'create'])}\` first`);
  if (from.uid === 0) throw new AdminError('refusing to migrate root');
  if (from.uid === to.uid) throw new AdminError('the runner already runs as that user');
  // never from or into another runner's account: each instance keeps its own token, policy and clones
  if (L.instance && to.name !== L.user)
    throw new AdminError(`instance ${L.instance} migrates only into ${L.user}`);
  if (from.name === RUNNER_USER || from.name.startsWith(`${RUNNER_USER}-`))
    throw new AdminError(`${from.name} is a runner user: one runner's data is never moved into another`);
  if (fs.existsSync(P(sys, MIGRATE_MARKER)))
    throw new AdminError(`a migration is waiting for --finish (${MIGRATE_MARKER}); finish it first`);
  const oldData = runnerDataRoot(from, opts.dataDir);
  const oldPolicy = path.posix.join(from.home, '.config/aom-runner/policy.json');
  if (!fs.existsSync(P(sys, oldData))) throw new AdminError(`no runner data at ${oldData}`);
  // R21: nothing is ever carried over from a runner below the floor; only 1.10.0 runners write policy.json
  const policyText = readOwnedFile(sys, oldPolicy, from.uid);
  let policy;
  try {
    policy = policyText ? JSON.parse(policyText) : null;
  } catch {
    policy = null;
  }
  const version = installedRunnerVersion(sys, from.home);
  if (policy?.version !== 1 || (version && compareVersions(version, RUNNER_FLOOR) < 0))
    throw new AdminError(
      `the runner state of ${from.name} was written by a runner below ${RUNNER_FLOOR}${version ? ` (installed: ${version})` : ''}: nothing is carried over. Install the runner fresh as ${to.name} instead.`,
    );
  const dirs = pairingDirs(sys, from, oldData);
  const busy = busyReason(sys, from, dirs);
  if (busy) throw new AdminError(`not now: ${busy}.`);
  const newData = path.posix.join(to.home, path.posix.relative(from.home, oldData));
  const newPolicy = path.posix.join(to.home, '.config/aom-runner/policy.json');
  for (const p of [newData, newPolicy])
    if (fs.existsSync(P(sys, p)))
      throw new AdminError(`${p} already exists: refusing to overwrite the runner user's data`);

  // own clones only [rv6-3]: repo roots under <old HOME>/guildwise-runner/src; the person's own folders (their .env
  // files) are never copied, and neither is anything a tampered config lists (~/.ssh)
  const ownClones = path.posix.join(from.home, 'guildwise-runner/src');
  // the dedicated user's clones live in ~/src (setup's clonesDir)
  const newClones = path.posix.join(to.home, 'src');
  const cloneDst = (c) => path.posix.join(newClones, path.posix.relative(ownClones, c));
  const clones = new Set();
  const notCopied = new Set();
  for (const dir of dirs) {
    const text = readOwnedFile(sys, path.posix.join(dir, 'config.json'), from.uid);
    if (!text) continue;
    let cfg = {};
    try {
      cfg = JSON.parse(text);
    } catch {
      continue;
    }
    for (const r of Array.isArray(cfg.repoRoots) ? cfg.repoRoots : []) {
      const rel = path.posix.relative(ownClones, String(r));
      if (!rel.startsWith('..') && !path.posix.isAbsolute(rel) && SAFE_ABS_RE.test(String(r)))
        clones.add(String(r));
      else notCopied.add(String(r));
    }
  }
  const plan = [
    `${oldData} -> ${newData}`,
    `${oldPolicy} -> ${newPolicy}`,
    ...[...clones].map((c) => `${c} -> ${cloneDst(c)}`),
  ];
  if (sys.dryRun) {
    for (const l of plan) note(sys, `would copy ${l}`);
    return { plan };
  }
  const stats = { files: 0, dirs: 0, links: 0, secrets: 0, skipped: [] };
  assertNoSymlinkBelow(sys, to.home, newData);
  ensureParents(sys, to, newData);
  copyTree(
    sys,
    from,
    to,
    oldData,
    newData,
    // never the status (the good-start check reads the new one), and never the sealed sudo password: in current-user
    // mode it is the person's own password, which would let the runner user become the person (and root)
    { skip: (rel) => /(^|\/)status\.json$/.test(rel) || /(^|\/)secrets\/sudo\.enc$/.test(rel) },
    stats,
  );
  for (const c of clones) {
    const dst = cloneDst(c);
    if (fs.existsSync(P(sys, dst)) && fs.readdirSync(P(sys, dst)).length > 0) {
      stats.skipped.push(`${c} (${dst} exists)`);
      continue;
    }
    assertNoSymlinkBelow(sys, to.home, dst);
    ensureParents(sys, to, dst);
    if (fs.existsSync(P(sys, dst))) fs.rmdirSync(P(sys, dst));
    copyTree(sys, from, to, c, dst, {}, stats);
  }
  // configs point at the old HOME: point them at the new one
  for (const dir of pairingDirs(sys, to, newData)) {
    for (const f of ['config.json']) {
      const p = path.posix.join(dir, f);
      const text = fs.existsSync(P(sys, p)) ? fs.readFileSync(P(sys, p), 'utf8') : null;
      if (!text) continue;
      try {
        writeUserFile(
          sys,
          to,
          p,
          `${JSON.stringify(rewriteHome(rewriteHome(JSON.parse(text), ownClones, newClones), from.home, to.home), null, 2)}\n`,
          0o600,
        );
      } catch {
        stats.skipped.push(`${p} (could not rewrite paths)`);
      }
    }
  }
  ensureParents(sys, to, newPolicy);
  const nextPolicy = {
    ...policy,
    devops: { ...(policy.devops || {}), sudo: false },
    acceptRootEquivalent: false,
    runnerUser: { mode: 'dedicated', name: to.name },
  };
  writeUserFile(sys, to, newPolicy, `${JSON.stringify(nextPolicy, null, 2)}\n`, 0o600);
  stats.files++;
  stats.secrets++;
  const marker = {
    from: from.name,
    to: to.name,
    startedAt: sys.now().toISOString(),
    oldDataDirs: dirs,
    oldPolicy,
    newData,
  };
  writeRootFile(sys, MIGRATE_MARKER, `${JSON.stringify(marker, null, 2)}\n`, 0o600);
  note(
    sys,
    `Copied ${stats.files} files (${stats.secrets} secret files at 0600), ${stats.dirs} folders and ${stats.links} links to ${to.name}.`,
  );
  for (const s of stats.skipped) note(sys, `  skipped: ${s}`);
  for (const r of notCopied)
    note(
      sys,
      `  not copied (not one of the runner's own clones in ${ownClones}): ${r} -- clone it fresh as ${to.name}`,
    );
  note(
    sys,
    `Sudo is off for ${to.name} (your sealed sudo password was not copied): \`${adminHint(L, ['sudo', 'on'])}\` if you want it, then run \`sudo -u ${to.name} -H guildwise-runner setup\`.`,
  );
  disableOldService(sys, from);
  if (Array.isArray(policy.signingKeys) && policy.signingKeys.length > 0)
    note(
      sys,
      '  release signing key files are never moved: add them again as the runner user (`guildwise-runner signing add-key`)',
    );
  note(sys, `Redo these logins as ${to.name}:`);
  for (const l of loginsToRedo(sys, to)) note(sys, `  ${l}`);
  note(
    sys,
    `Then start the runner as ${to.name}, and after its first good start run: ${adminHint(L, ['migrate-user', '--finish'])}`,
  );
  return { stats, marker };
}

/** The old current-user service: the systemd user unit or the LaunchAgent of the 1.10.0 installer. */
function oldServiceEnabled(sys, from) {
  const candidates =
    sys.platform === 'darwin'
      ? [path.posix.join(from.home, 'Library/LaunchAgents/com.guildwisehq.runner.plist')]
      : [path.posix.join(from.home, '.config/systemd/user/default.target.wants/aom-runner.service')];
  return candidates.find((c) => fs.lstatSync(P(sys, c), { throwIfNoEntry: false })) || null;
}

function oldServiceHint(sys, from) {
  return sys.platform === 'darwin'
    ? `As ${from.name}: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.guildwisehq.runner.plist && mv ~/Library/LaunchAgents/com.guildwisehq.runner.plist ~/com.guildwisehq.runner.plist.disabled`
    : `As ${from.name}: systemctl --user disable --now aom-runner`;
}

/** Stops and disables the old user's runner service, so it does not start again with the same token. */
function disableOldService(sys, from) {
  const r =
    sys.platform === 'darwin'
      ? mustRun(sys, 'launchctl', ['bootout', `gui/${from.uid}/com.guildwisehq.runner`], { allowFail: true })
      : mustRun(sys, 'systemctl', ['--user', '-M', `${from.name}@`, 'disable', '--now', 'aom-runner'], {
          allowFail: true,
        });
  const still = oldServiceEnabled(sys, from);
  if (r.code === 0 && !still) note(sys, `Stopped and disabled ${from.name}'s old runner service.`);
  else
    note(
      sys,
      `Disable ${from.name}'s old runner service now (it would start again at the next login). ${oldServiceHint(sys, from)}`,
    );
}

function ensureParents(sys, u, abs) {
  const rel = path.posix.relative(u.home, path.posix.dirname(abs));
  let cur = u.home;
  for (const part of rel.split('/').filter(Boolean)) {
    cur = path.posix.join(cur, part);
    if (!fs.existsSync(P(sys, cur))) ensureOwnedDir(sys, cur, u, 0o700);
  }
}

function migrateFinish(sys, opts = {}) {
  const L = opts.L || DEFAULT_LAYOUT;
  const MIGRATE_MARKER = L.migrateMarker;
  const text = fs.existsSync(P(sys, MIGRATE_MARKER)) ? readOwnedFile(sys, MIGRATE_MARKER, 0) : null;
  if (!text) throw new AdminError('no migration is waiting to be finished');
  const m = JSON.parse(text);
  const from = requireUser(sys, m.from);
  const to = requireUser(sys, m.to);
  if (L.instance && to.name !== L.user)
    throw new AdminError(`the waiting migration is into ${to.name}, not instance ${L.instance}`);
  const startedAt = Date.parse(m.startedAt);
  let good = false;
  for (const dir of pairingDirs(sys, to, m.newData)) {
    let s;
    try {
      s = JSON.parse(readOwnedFile(sys, path.posix.join(dir, 'status.json'), to.uid) || 'null');
    } catch {
      s = null;
    }
    if (s && s.connected === true && Date.parse(s.updatedAt) > startedAt) good = true;
  }
  if (!good)
    throw new AdminError(
      `the runner has not started well as ${to.name} yet (no connected status since ${m.startedAt}); start it, check the workstation page, then run --finish again`,
    );
  const enabled = oldServiceEnabled(sys, from);
  if (enabled)
    throw new AdminError(
      `${from.name}'s old runner service is still enabled (${enabled}): it would start again with the same token. ${oldServiceHint(sys, from)}, then run --finish again`,
    );
  const removed = [];
  // removed with the old user's own rights (runuser / sudo -u), so a path swapped for a symlink cannot make root delete
  // anything that user could not delete anyway
  const rm = (abs) => {
    const rel = path.posix.relative(from.home, abs);
    if (rel.startsWith('..') || path.posix.isAbsolute(rel) || !SAFE_ABS_RE.test(abs)) return;
    assertNoSymlinkBelow(sys, from.home, abs);
    const st = fs.lstatSync(P(sys, abs), { throwIfNoEntry: false });
    if (!st) return;
    const args = ['rm', '-rf', '--', P(sys, abs)];
    if (sys.platform === 'darwin') mustRun(sys, 'sudo', ['-u', from.name, '--', '/bin/rm', ...args.slice(1)]);
    else mustRun(sys, 'runuser', ['-u', from.name, '--', ...args]);
    removed.push(abs);
  };
  for (const dir of m.oldDataDirs || []) {
    // config.json holds the runner token; secrets/ the sealed sudo password, the runner key, Claude and git credentials
    rm(path.posix.join(dir, 'config.json'));
    rm(path.posix.join(dir, 'secrets'));
  }
  rm(m.oldPolicy);
  if (!sys.dryRun) fs.rmSync(P(sys, MIGRATE_MARKER), { force: true });
  note(sys, `Removed ${from.name}'s copies of the runner's secrets:`);
  for (const r of removed) note(sys, `  ${r}`);
  note(
    sys,
    `Your own logins in ${from.home} (~/.claude, ~/.config/gh) were not touched; log out of them if only the runner used them.`,
  );
  return { removed };
}

// ----------------------------------------------------------------------------------------------- verify

/**
 * [rv6-1] The admin tools (and the rootless Docker binaries) and every parent up to / are root-owned and not writable by
 * group or others; no sudoers rule names the runner; root's PATH (and sudo's secure_path) never reaches into the
 * runner's HOME.
 */
function verifyInstall(sys, opts = {}) {
  const problems = [];
  const rootUid = opts.rootUid ?? sys.rootUid ?? 0;
  // `tree`: the root-owned folder being walked. A root-owned link inside it that stays inside it is part of the tree (the
  // Node tarball's bin/npm, bin/npx and bin/corepack): a link's own mode is always 777 and means nothing, its target is
  // walked and checked on its own. A link that leaves the tree, dangles, or is a parent of the tools folder is a problem.
  const checkNode = (abs, mustExist, tree = null) => {
    const st = fs.lstatSync(P(sys, abs), { throwIfNoEntry: false });
    if (!st) {
      if (mustExist) problems.push(`${abs} is missing`);
      return null;
    }
    if (st.isSymbolicLink()) {
      if (st.uid !== rootUid) problems.push(`${abs} is not owned by root`);
      if (!tree) problems.push(`${abs} is a symlink`);
      else if (!linkStaysInside(sys, abs, tree))
        problems.push(`${abs} is a symlink that leads out of ${tree}`);
      return st;
    }
    if (st.uid !== rootUid) problems.push(`${abs} is not owned by root`);
    if (st.mode & 0o022)
      problems.push(`${abs} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    return st;
  };
  const L = opts.L || DEFAULT_LAYOUT;
  let cur = L.toolsDir;
  const parents = [];
  while (cur !== '/') {
    parents.unshift(cur);
    cur = path.posix.dirname(cur);
  }
  parents.unshift('/');
  for (const p of parents) checkNode(p, true);
  const walk = (abs, tree) => {
    const st = checkNode(abs, true, abs === tree ? null : tree);
    if (st?.isDirectory()) for (const n of fs.readdirSync(P(sys, abs))) walk(path.posix.join(abs, n), tree);
  };
  for (const f of ['guildwise-admin', 'node']) {
    const top = path.posix.join(L.toolsDir, f);
    walk(top, top);
  }
  if (fs.existsSync(P(sys, L.dockerDir))) walk(L.dockerDir, L.dockerDir);
  const u = lookupUser(sys, opts.user || L.user);
  // 1.10.0 has no sudoers rule for a runner: anything left is reported (cleanup-legacy removes ours)
  const runnerName = u ? u.name : L.user;
  try {
    for (const n of fs.readdirSync(P(sys, '/etc/sudoers.d')))
      if (n === runnerName || n.startsWith(`${runnerName}_`) || n.startsWith(`${runnerName}-`))
        problems.push(
          `/etc/sudoers.d/${n} gives the runner sudo (run \`${adminHint(L, ['cleanup-legacy'])}\`)`,
        );
  } catch {
    // no drop-in folder
  }
  if (u) {
    const pathVars = [sys.env.PATH || '', ...securePaths(sys)];
    for (const v of pathVars)
      for (const entry of v.split(':').filter(Boolean))
        if (entry === u.home || entry.startsWith(`${u.home}/`))
          problems.push(`root's PATH includes the runner's HOME (${entry})`);
  }
  for (const p of problems) sys.err(`problem: ${p}`);
  if (problems.length === 0)
    note(sys, "The root-owned tools, the sudoers drop-ins and root's PATH are as they should be.");
  return problems;
}

/**
 * Does the link at `abs` stay inside `tree` the way the kernel resolves it, at EVERY hop (REVIEW B1)? Each hop's target may
 * use `..` only as leading segments, is resolved from the link's physical folder, must land inside the tree's real path,
 * and may pass through no directory link on the way (only its last component may be a link: the next hop). An absolute
 * target must name a path inside `tree` with no `..`. A hop that leaves the tree, even to come back later, a dangling
 * chain, or a loop is refused.
 */
function linkStaysInside(sys, abs, tree) {
  const posix = path.posix;
  let baseReal;
  let cur;
  try {
    baseReal = fs.realpathSync.native(P(sys, tree));
    cur = posix.join(fs.realpathSync.native(posix.dirname(P(sys, abs))), posix.basename(abs));
  } catch {
    return false;
  }
  const inside = (p) => p === baseReal || p.startsWith(`${baseReal}/`);
  if (!inside(cur)) return false;
  for (let hop = 0; hop < 40; hop++) {
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return false;
    }
    if (!st.isSymbolicLink()) return true;
    const target = fs.readlinkSync(cur);
    const seg = target.split('/').filter((x) => x !== '' && x !== '.');
    let next;
    if (posix.isAbsolute(target)) {
      if (seg.includes('..')) return false;
      const t = `/${seg.join('/')}`;
      if (t !== tree && !t.startsWith(`${tree}/`)) return false;
      next = posix.join(baseReal, posix.relative(tree, t));
    } else {
      const firstReal = seg.findIndex((x) => x !== '..');
      if (firstReal !== -1 && seg.slice(firstReal).includes('..')) return false;
      // the folder of `cur` is physical (checked below for every hop), so leading `..` resolve exactly as the kernel does
      next = posix.join(posix.dirname(cur), ...seg);
    }
    if (!inside(next)) return false;
    const parts = posix.relative(baseReal, next).split('/').filter(Boolean);
    let p = baseReal;
    for (let k = 0; k < parts.length - 1; k++) {
      p = posix.join(p, parts[k]);
      try {
        if (fs.lstatSync(p).isSymbolicLink()) return false;
      } catch {
        return false;
      }
    }
    cur = next;
  }
  return false;
}

function securePaths(sys) {
  const out = [];
  const dropIn = P(sys, '/etc/sudoers.d');
  const files = ['/etc/sudoers'];
  try {
    for (const n of fs.readdirSync(dropIn))
      if (!n.includes('.') && !n.endsWith('~')) files.push(`/etc/sudoers.d/${n}`);
  } catch {
    // no drop-in folder
  }
  for (const f of files) {
    try {
      const text = fs.readFileSync(P(sys, f), 'utf8');
      for (const m of text.matchAll(/^\s*Defaults\s+secure_path\s*=\s*"?([^"\n]+)"?/gm)) out.push(m[1]);
    } catch {
      // not readable: nothing to check
    }
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- apply (installer flags)

function envFlag(env, name) {
  const v = env[`GUILDWISE_${name}`];
  return v === undefined || v === '' ? undefined : v;
}

/**
 * The installer's non-interactive form (R20 "Non-interactive"): the same flags as `guildwise-runner setup`, root half
 * only. Always cleans up what 1.10.0 removed first. `--yes` alone gives the safest values: a dedicated user, no Docker.
 */
async function apply(sys, o) {
  const env = sys.env || {};
  const runnerUser = o['runner-user'] || envFlag(env, 'RUNNER_USER') || (o.yes ? 'dedicated' : undefined);
  const docker = o.docker || envFlag(env, 'DOCKER') || 'none';
  const accept = o['accept-root-equivalent'] || envFlag(env, 'ACCEPT_ROOT_EQUIVALENT') === '1';
  const acceptShared = o['accept-shared-daemon'] || envFlag(env, 'ACCEPT_SHARED_DAEMON') === '1';
  if (!['dedicated', 'current'].includes(runnerUser || ''))
    throw new AdminError('--runner-user dedicated|current is required (or --yes for the dedicated user)');
  if (!['rootless', 'host', 'shared', 'none'].includes(docker))
    throw new AdminError('--docker must be rootless, host, shared or none');
  if (docker === 'host' && !accept) throw new AdminError('--docker host needs --accept-root-equivalent');
  if (docker === 'shared' && !acceptShared)
    throw new AdminError('--docker shared needs --accept-shared-daemon');
  const L = o.L || DEFAULT_LAYOUT;
  if (L.instance && runnerUser !== 'dedicated')
    throw new AdminError('--instance needs the dedicated runner user (--runner-user dedicated, or --yes)');
  let user = L.user;
  if (runnerUser === 'dedicated') {
    userCreate(sys, { L });
    serviceInstall(sys, { L, runnerRoot: o['runner-root'], caFile: o['ca-file'], start: o.start });
  } else {
    user = o.user || sys.env.SUDO_USER;
    if (!user) throw new AdminError('with --runner-user current, name the user: --user <name>');
    note(
      sys,
      `Keeping the current user ${user}: the runner refuses to start while that user is root-equivalent, unless accepted.`,
    );
  }
  cleanupLegacy(sys, { L, user, dataDir: o['data-dir'] });
  dockerSet(sys, docker, {
    L,
    user,
    acceptRootEquivalent: accept,
    acceptSharedDaemon: acceptShared,
    desktopSocket: o['desktop-socket'],
    dockerSocket: o['docker-socket'],
  });
}

// ----------------------------------------------------------------------------------------------- main

const USAGE = `usage: sudo ${SELF_PATH} <command> [options]
  user create
  service install [--runner-root <dir>] [--ca-file <pem>] [--start] | service remove
  docker rootless|none [--user <name>]
  docker host --accept-root-equivalent [--desktop-socket /Users/<u>/.docker/run/docker.sock (macOS)]
  docker shared --docker-socket <path> --accept-shared-daemon
  cleanup-legacy [--data-dir <dir>]
  readers add|remove <user> [--path <clones folder>]
  migrate-user [--from <user>] [--to <user>] [--data-dir <dir>] | migrate-user --finish
  apply --yes | --runner-user dedicated|current [--docker rootless|host|shared|none] [--accept-root-equivalent]
        [--accept-shared-daemon --docker-socket <path>] [--desktop-socket <path>] [--runner-root <dir>]
        [--ca-file <pem>] [--start]
  verify
every command: --dry-run (print what would change; changes nothing)
every command: --instance <name> for a named runner (user, service, CA, Docker of guildwise-runner-<name>)`;

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  instance: { type: 'string' },
  yes: { type: 'boolean' },
  user: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'data-dir': { type: 'string' },
  'runner-root': { type: 'string' },
  'ca-file': { type: 'string' },
  start: { type: 'boolean' },
  path: { type: 'string' },
  finish: { type: 'boolean' },
  'accept-root-equivalent': { type: 'boolean' },
  'runner-user': { type: 'string' },
  docker: { type: 'string' },
  'accept-shared-daemon': { type: 'boolean' },
  'docker-socket': { type: 'string' },
  'desktop-socket': { type: 'string' },
  // accepted for one-to-one installer flags; handled by the installer and `guildwise-runner setup`
  'devops-orgs': { type: 'string' },
  deploy: { type: 'string' },
  'deploy-pin-commit': { type: 'boolean' },
  'allow-unsigned-from': { type: 'string', multiple: true },
  legacy: { type: 'string' },
  'wsl-distro': { type: 'string' },
  help: { type: 'boolean' },
};

async function main(argv, sys = realSystem()) {
  try {
    let parsed;
    try {
      parsed = util.parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    } catch (e) {
      checkInterpreter(sys, instanceLayout(toolsInstance(sys.execPath)));
      throw e;
    }
    const { values: o, positionals: pos } = parsed;
    // Only the flag, or the instance's own tools folder, names an instance (no variable: without either nothing changes
    // from before). An instance is managed only by its own copy of the tools: the top-level guildwise-admin refuses
    // --instance, and an instance's copy refuses another instance.
    const own = toolsInstance(sys.execPath);
    const L = instanceLayout(o.instance ?? own);
    checkInterpreter(sys, L);
    if (o.help || pos.length === 0) {
      sys.out(USAGE);
      return pos.length === 0 && !o.help ? 64 : 0;
    }
    sys.dryRun = Boolean(o['dry-run']);
    checkPlatform(sys);
    checkRoot(sys);
    const [cmd, sub, arg] = pos;
    if (cmd === 'user' && sub === 'create') userCreate(sys, { L, name: o.user });
    else if (cmd === 'service' && sub === 'install')
      serviceInstall(sys, {
        L,
        user: o.user,
        runnerRoot: o['runner-root'],
        caFile: o['ca-file'],
        start: o.start,
      });
    else if (cmd === 'service' && sub === 'remove') serviceRemove(sys, { L });
    else if (cmd === 'docker' && sub)
      dockerSet(sys, sub, {
        L,
        user: o.user,
        acceptRootEquivalent: o['accept-root-equivalent'],
        acceptSharedDaemon: o['accept-shared-daemon'],
        desktopSocket: o['desktop-socket'],
        dockerSocket: o['docker-socket'],
      });
    else if (cmd === 'cleanup-legacy') cleanupLegacy(sys, { L, user: o.user, dataDir: o['data-dir'] });
    else if (cmd === 'readers' && sub === 'add' && arg)
      readersAdd(sys, arg, { L, user: o.user, path: o.path });
    else if (cmd === 'readers' && sub === 'remove' && arg) readersRemove(sys, arg, { L, user: o.user });
    else if (cmd === 'migrate-user')
      migrateUser(sys, { L, from: o.from, to: o.to, dataDir: o['data-dir'], finish: o.finish });
    else if (cmd === 'apply') await apply(sys, { ...o, L });
    else if (cmd === 'verify') return verifyInstall(sys, { L, user: o.user }).length === 0 ? 0 : 1;
    else {
      sys.err(USAGE);
      return 64;
    }
    return 0;
  } catch (e) {
    if (e instanceof AdminError) {
      sys.err(`guildwise-admin: ${e.message}`);
      return e.exitCode;
    }
    if (e && e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      sys.err(`guildwise-admin: ${e.message}`);
      return 64;
    }
    throw e;
  }
}

module.exports = {
  ADMIN_DIR,
  NODE_PATH,
  SELF_PATH,
  RUNNER_USER,
  READERS_GROUP,
  RUNNER_FLOOR,
  SUDOERS_SUDO,
  SUDOERS_DOCKER,
  MIGRATE_MARKER,
  SYSTEMD_UNIT,
  LAUNCHD_PLIST,
  RUNNER_CA_FILE,
  MIN_FETCH_GIT,
  INSTANCE_RE,
  RESERVED_INSTANCES,
  AdminError,
  instanceLayout,
  toolsInstance,
  main,
  realSystem,
  unitText,
  plistText,
  parseSubids,
  nextSubidStart,
  apparmorText,
  parseGitVersion,
  versionAtLeast,
  rewriteHome,
  isSecretPath,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`guildwise-admin: ${e?.message ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
