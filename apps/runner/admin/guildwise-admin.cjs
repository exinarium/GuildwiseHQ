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
 *   guildwise-admin sudo on|off                     sealed sudo for the dedicated user (password only the runner knows)
 *   guildwise-admin docker none|narrow|group        how deploys reach Docker (narrow = the deploy-compose helper only)
 *   guildwise-admin approve-app <app> --source <d>  approve a compose app for deploy-compose (frozen, validated, pinned)
 *   guildwise-admin readers add|remove <user>       read-only `git fetch` access to the runner's own clones
 *   guildwise-admin migrate-user [--finish]         move a 1.10.0 current-user install to the dedicated user
 *   guildwise-admin apply <flags>                   the installer's non-interactive form of the above
 *   guildwise-admin verify                          check the root-owned install, the sudoers files and root's PATH
 *
 * Every command takes --dry-run (print what would change, change nothing; also allowed without root).
 * Secrets (the generated sudo password) are never printed, logged or put on a command line.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const readline = require('node:readline');
const util = require('node:util');

const ADMIN_DIR = '/usr/local/lib/guildwise';
const NODE_DIR = `${ADMIN_DIR}/node`;
const NODE_PATH = `${NODE_DIR}/bin/node`;
const SELF_PATH = `${ADMIN_DIR}/guildwise-admin`;
const DEPLOY_COMPOSE = `${ADMIN_DIR}/deploy-compose`;
const RUNNER_USER = 'guildwise-runner';
const READERS_GROUP = 'guildwise-readers';
/** MIN_TRUSTED_RUNNER (apps/runner/src/update/floor.ts): state written by an older runner is never carried over (R21).
 * Raised by hand with the floor, never with RUNNER_VERSION; a test keeps the two equal (this file may not import it). */
const RUNNER_FLOOR = '1.10.0';
const SUDOERS_SUDO = '/etc/sudoers.d/guildwise-runner';
const SUDOERS_DOCKER = '/etc/sudoers.d/guildwise-runner-docker';
const APPS_CONF_DIR = '/etc/guildwise-runner/apps';
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
/** The same limit as deploy-compose's checkAppName (W10): a-z, 0-9, -, at most 48. */
const APP_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
/** Paths that end up inside unit files, plists and sudoers lines: no quotes, spaces, newlines or `%`. */
const SAFE_ABS_RE = /^\/[A-Za-z0-9._/-]{0,500}$/;
const MAX_COPY_FILE = 512 * 1024 * 1024;
const PLATFORMS = ['linux', 'darwin'];

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
function checkInterpreter(sys) {
  if (sys.execPath !== NODE_PATH)
    throw new AdminError(
      `guildwise-admin runs only under the bundled Node at ${NODE_PATH} (this is ${sys.execPath}). Run it as \`sudo ${SELF_PATH} ...\`.`,
      2,
    );
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
  const name = checkUserName(opts.name || RUNNER_USER);
  // it removes the account from admin groups: only ever the dedicated user, never a person's account
  if (name !== RUNNER_USER) throw new AdminError(`user create is only for the dedicated ${RUNNER_USER} user`);
  let u = lookupUser(sys, name);
  if (u) note(sys, `User ${name} exists (uid ${u.uid}, home ${u.home}).`);
  else if (sys.platform === 'darwin') {
    const uid = freeMacUid(sys);
    const rec = `/Users/${name}`;
    mustRun(sys, 'dscl', ['.', '-create', rec]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'UserShell', '/usr/bin/false']);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'RealName', 'Guildwise runner']);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'UniqueID', String(uid)]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'PrimaryGroupID', String(MAC_STAFF_GID)]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'NFSHomeDirectory', MAC_HOME]);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'IsHidden', '1']);
    mustRun(sys, 'dscl', ['.', '-create', rec, 'Password', '*']);
    u = { name, uid, gid: MAC_STAFF_GID, home: MAC_HOME };
    note(sys, `Created the hidden standard user ${name} (uid ${uid}, home ${MAC_HOME}).`);
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

// ----------------------------------------------------------------------------------------------- sudoers

/** Validates a sudoers text with `visudo -cf` before it is moved into /etc/sudoers.d (mode 0440). */
function installSudoers(sys, abs, content) {
  if (sys.dryRun) {
    note(sys, `would write ${abs} (0440, checked with visudo -cf):\n${content.trimEnd()}`);
    return;
  }
  const real = P(sys, abs);
  fs.mkdirSync(path.dirname(real), { recursive: true, mode: 0o755 });
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.check`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { mode: 0o440, flag: 'wx' });
  const r = sys.run('visudo', ['-cf', tmp]);
  if (r.code !== 0) {
    fs.rmSync(tmp, { force: true });
    throw new AdminError(
      `visudo rejected ${abs}: ${String(r.stderr || r.stdout)
        .trim()
        .slice(0, 300)}`,
    );
  }
  fs.chmodSync(tmp, 0o440);
  sys.chown(tmp, 0, 0);
  fs.renameSync(tmp, real);
  note(sys, `Wrote ${abs} (checked with visudo).`);
}

function sudoersForSudo(user) {
  checkUserName(user);
  return [
    '# Written by guildwise-admin (R20): the runner user may use sudo with its own password, which only the',
    "# runner's sealed vault knows. Every privileged DevOps step still needs a local approval on this machine.",
    `${user} ALL=(ALL) ALL`,
    '',
  ].join('\n');
}

function sudoersForDocker(user) {
  checkUserName(user);
  return [
    '# Written by guildwise-admin (R20): the only passwordless rule. deploy-compose runs approved, frozen compose',
    '# apps and nothing else; no wildcards. Its environment is pinned whatever the local sudo defaults say: Node',
    '# reads NODE_OPTIONS before any check in the script could run.',
    `Defaults!${DEPLOY_COMPOSE} env_reset, !env_keep, !setenv`,
    `${user} ALL=(root) NOPASSWD: ${DEPLOY_COMPOSE}`,
    '',
  ].join('\n');
}

// ----------------------------------------------------------------------------------------------- service

function unitText(u, runnerRoot) {
  checkSafeAbs(runnerRoot, '--runner-root');
  checkSafeAbs(u.home, 'the runner HOME');
  return [
    '# Written by guildwise-admin (R20, R18-P). The runner runs as its own unprivileged user.',
    '[Unit]',
    'Description=Guildwise runner (user guildwise-runner)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${u.name}`,
    `WorkingDirectory=${u.home}`,
    `Environment="HOME=${u.home}"`,
    `Environment="PATH=${u.home}/.local/bin:/usr/local/bin:/usr/bin:/bin"`,
    `ExecStart="${runnerRoot}/current/aom-runner" start`,
    'Restart=always',
    'RestartSec=10',
    // the start-up refusal exits 78: no restart loop
    'RestartPreventExitStatus=78',
    // the sealed sudo flow must still work
    'NoNewPrivileges=no',
    'ProtectSystem=full',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function plistText(u, runnerRoot) {
  checkSafeAbs(runnerRoot, '--runner-root');
  checkSafeAbs(u.home, 'the runner HOME');
  const s = (v) => `<string>${v}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${s(LAUNCHD_LABEL)}`,
    `  <key>UserName</key>${s(u.name)}`,
    '  <key>ProgramArguments</key>',
    `  <array>${s(`${runnerRoot}/current/aom-runner`)}${s('start')}</array>`,
    `  <key>WorkingDirectory</key>${s(u.home)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>HOME</key>${s(u.home)}`,
    `    <key>PATH</key>${s(`${u.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`)}`,
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    // launchd has no "do not restart on exit 78": restart after a crash only, so the start-up refusal cannot loop
    '  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>StandardOutPath</key>${s(`${u.home}/Library/Logs/guildwise-runner.log`)}`,
    `  <key>StandardErrorPath</key>${s(`${u.home}/Library/Logs/guildwise-runner.log`)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function defaultRunnerRoot(u) {
  return path.posix.join(u.home, '.local/share/guildwise/runner');
}

function serviceInstall(sys, opts = {}) {
  const u = requireUser(sys, opts.user || RUNNER_USER, 'run `guildwise-admin user create` first');
  const runnerRoot = opts.runnerRoot || defaultRunnerRoot(u);
  if (sys.platform === 'darwin') {
    writeRootFile(sys, LAUNCHD_PLIST, plistText(u, runnerRoot), 0o644);
    ensureOwnedDir(sys, path.posix.join(u.home, 'Library'), u, 0o700);
    ensureOwnedDir(sys, path.posix.join(u.home, 'Library/Logs'), u, 0o700);
    note(sys, `Wrote ${LAUNCHD_PLIST} (LaunchDaemon, UserName ${u.name}).`);
    if (opts.start) {
      mustRun(sys, 'launchctl', ['bootstrap', 'system', LAUNCHD_PLIST], { allowFail: true });
      mustRun(sys, 'launchctl', ['enable', `system/${LAUNCHD_LABEL}`]);
      mustRun(sys, 'launchctl', ['kickstart', '-k', `system/${LAUNCHD_LABEL}`]);
    }
    return;
  }
  writeRootFile(sys, SYSTEMD_UNIT, unitText(u, runnerRoot), 0o644);
  note(sys, `Wrote ${SYSTEMD_UNIT} (system unit, User=${u.name}).`);
  mustRun(sys, 'systemctl', ['daemon-reload']);
  mustRun(
    sys,
    'systemctl',
    opts.start ? ['enable', '--now', 'guildwise-runner'] : ['enable', 'guildwise-runner'],
  );
}

function serviceRemove(sys) {
  if (sys.platform === 'darwin') {
    mustRun(sys, 'launchctl', ['bootout', `system/${LAUNCHD_LABEL}`], { allowFail: true });
    if (removeFile(sys, LAUNCHD_PLIST)) note(sys, `Removed ${LAUNCHD_PLIST}.`);
    return;
  }
  mustRun(sys, 'systemctl', ['disable', '--now', 'guildwise-runner'], { allowFail: true });
  if (removeFile(sys, SYSTEMD_UNIT)) note(sys, `Removed ${SYSTEMD_UNIT}.`);
  mustRun(sys, 'systemctl', ['daemon-reload']);
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

// ----------------------------------------------------------------------------------------------- sudo

/**
 * Seals `password` for every pairing of the runner: RSA-OAEP (SHA-256) with the public half of the pairing's
 * `secrets/runner-key.pem`, written to `secrets/sudo.enc` (0600, owned by the runner) -- the same format `SudoVault`
 * reads. Returns the number of pairings sealed.
 */
function sealSudoPassword(sys, u, dataRoot, password) {
  let sealed = 0;
  for (const dir of pairingDirs(sys, u, dataRoot)) {
    const keyFile = path.posix.join(dir, 'secrets/runner-key.pem');
    const pem = readOwnedFile(sys, keyFile, u.uid, 64 * 1024);
    if (!pem) continue;
    const pub = crypto.createPublicKey(crypto.createPrivateKey(pem));
    const ct = crypto
      .publicEncrypt(
        { key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(password),
      )
      .toString('base64');
    writeUserFile(sys, u, path.posix.join(dir, 'secrets/sudo.enc'), `${ct}\n`, 0o600);
    sealed++;
  }
  return sealed;
}

function runnerKeysPresent(sys, u, dataRoot) {
  return pairingDirs(sys, u, dataRoot).some((d) =>
    fs.existsSync(P(sys, path.posix.join(d, 'secrets/runner-key.pem'))),
  );
}

/**
 * R20 step 3 / R18-P: `sudo on` gives the dedicated user a random password (chpasswd, on stdin), writes
 * `<user> ALL=(ALL) ALL` (password required, checked with visudo) and seals the password into the runner's vault.
 * The password is never printed. With the current user, `guildwise-runner setup` seals the user's own password.
 */
function sudoOn(sys, opts = {}) {
  const u = requireUser(sys, opts.user || RUNNER_USER, 'run `guildwise-admin user create` first');
  if (u.name !== RUNNER_USER && !opts.allowOtherUser)
    throw new AdminError(
      `sudo on is for the dedicated ${RUNNER_USER} user; with the current user, \`guildwise-runner setup --sudo on\` seals your own sudo password`,
    );
  const dataRoot = runnerDataRoot(u, opts.dataDir);
  if (!sys.dryRun && !runnerKeysPresent(sys, u, dataRoot))
    throw new AdminError(
      `no runner key under ${dataRoot}: pair the runner and run \`guildwise-runner setup\` as ${u.name} first (it creates the key the password is sealed with)`,
    );
  note(
    sys,
    'With sudo on, the runner can become root whenever your local policy allows a DevOps step; every such step still needs your local yes.',
  );
  const password = crypto.randomBytes(24).toString('base64url');
  if (sys.platform === 'darwin') {
    // dscl reads the command from stdin, so the password is never an argument (visible in ps)
    mustRun(sys, 'dscl', ['.'], { input: `passwd /Users/${u.name} ${password}\n` });
  } else {
    mustRun(sys, 'chpasswd', [], { input: `${u.name}:${password}\n` });
  }
  installSudoers(sys, SUDOERS_SUDO, sudoersForSudo(u.name));
  const n = sys.dryRun ? 0 : sealSudoPassword(sys, u, dataRoot, password);
  if (!sys.dryRun)
    note(sys, `Sealed the new sudo password for ${n} pairing(s) of ${u.name}; it is not shown anywhere.`);
  return { sealed: n };
}

function sudoOff(sys, opts = {}) {
  // it locks the account's password: only ever the dedicated user
  if ((opts.user || RUNNER_USER) !== RUNNER_USER)
    throw new AdminError(`sudo off is only for the dedicated ${RUNNER_USER} user`);
  const u = requireUser(sys, RUNNER_USER);
  if (removeFile(sys, SUDOERS_SUDO)) note(sys, `Removed ${SUDOERS_SUDO}.`);
  if (sys.platform === 'darwin') {
    mustRun(sys, 'dscl', ['.', '-create', `/Users/${u.name}`, 'Password', '*']);
  } else {
    mustRun(sys, 'usermod', ['-L', u.name]);
  }
  const dataRoot = runnerDataRoot(u, opts.dataDir);
  for (const dir of fs.existsSync(P(sys, dataRoot)) ? pairingDirs(sys, u, dataRoot) : []) {
    const f = path.posix.join(dir, 'secrets/sudo.enc');
    assertNoSymlinkBelow(sys, u.home, f);
    if (removeFile(sys, f)) note(sys, `Removed the sealed sudo password ${f}.`);
  }
  note(sys, `Sudo is off for ${u.name} (password locked).`);
}

// ----------------------------------------------------------------------------------------------- docker

/**
 * R20 step 4. `narrow`: only `<user> ALL=(root) NOPASSWD: deploy-compose`, and the user leaves the docker group.
 * `group`: the docker group (root-equivalent; needs --accept-root-equivalent). `none`: neither.
 */
function dockerMode(sys, mode, opts = {}) {
  if (!['none', 'narrow', 'group'].includes(mode))
    throw new AdminError('docker mode must be none, narrow or group');
  const u = requireUser(sys, opts.user || RUNNER_USER);
  const inGroup = () => groupsOf(sys, u.name).includes('docker');
  if (mode === 'group') {
    if (!opts.acceptRootEquivalent)
      throw new AdminError(
        'the docker group makes the runner root-equivalent: add --accept-root-equivalent if you accept that (narrow is the safer choice)',
      );
    if (sys.platform === 'darwin')
      throw new AdminError('macOS has no docker group: use --docker narrow, or none');
    if (removeFile(sys, SUDOERS_DOCKER)) note(sys, `Removed ${SUDOERS_DOCKER}.`);
    if (!inGroup()) addToGroup(sys, u.name, 'docker');
    note(sys, `${u.name} is in the docker group: the runner is root-equivalent (accepted).`);
    return;
  }
  if (sys.platform !== 'darwin' && inGroup()) {
    removeFromGroup(sys, u.name, 'docker');
    note(sys, `Removed ${u.name} from the docker group.`);
  }
  if (mode === 'narrow') {
    installSudoers(sys, SUDOERS_DOCKER, sudoersForDocker(u.name));
    note(
      sys,
      `Deploys reach Docker only through ${DEPLOY_COMPOSE}, for apps you approve with \`approve-app\`.`,
    );
  } else {
    if (removeFile(sys, SUDOERS_DOCKER)) note(sys, `Removed ${SUDOERS_DOCKER}.`);
    note(sys, 'Deploys have no Docker access.');
  }
}

// ----------------------------------------------------------------------------------------------- approve-app

function parseAppConf(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** A root-owned 0755 directory (created when missing; a symlink or a writable-by-others one is refused). */
function ensureRootDir(sys, abs) {
  if (sys.dryRun) return;
  const real = P(sys, abs);
  if (!fs.existsSync(real)) {
    fs.mkdirSync(real, { recursive: true, mode: 0o755 });
    fs.chmodSync(real, 0o755);
    sys.chown(real, 0, 0);
  }
  const st = fs.lstatSync(real);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new AdminError(`${abs} must be a real directory`);
  if (st.uid !== (sys.rootUid ?? 0) || st.mode & 0o022)
    throw new AdminError(`${abs} must be owned by root and not writable by group or others`);
}

/**
 * Loads the installed deploy-compose helper (W10) after checking that it and its folder are root-owned, not symlinks
 * and not writable by group or others, so root never runs code the runner user could have changed.
 */
function loadDeployCompose(sys) {
  const rootUid = sys.rootUid ?? 0;
  for (const abs of [ADMIN_DIR, DEPLOY_COMPOSE]) {
    const st = fs.lstatSync(P(sys, abs), { throwIfNoEntry: false });
    if (!st) throw new AdminError(`${abs} is missing: re-run the installer`);
    if (st.isSymbolicLink() || st.uid !== rootUid || st.mode & 0o022)
      throw new AdminError(`${abs} must be owned by root, not a symlink and not writable by group or others`);
  }
  const helper = (sys.requireHelper || require)(P(sys, DEPLOY_COMPOSE));
  if (!helper || typeof helper.prepare !== 'function' || typeof helper.formatAppConf !== 'function')
    throw new AdminError(`${DEPLOY_COMPOSE} is too old (no prepare()): re-run the installer`);
  return helper;
}

/**
 * R20 step 4 approval. The installed deploy-compose helper's own `prepare()` freezes, pre-scans, resolves, validates
 * (its allowlist, [rv7-8], [rv7-9]) and pins the folder, so the approval hash is exactly the one deploy-compose checks
 * at every run. After a local yes this writes `/etc/guildwise-runner/apps/<app>.conf` (root 0644) in the helper's own
 * format (`formatAppConf`).
 */
async function approveApp(sys, app, opts = {}) {
  if (!APP_RE.test(String(app || '')))
    throw new AdminError(`not a valid app name: ${JSON.stringify(app)} (a-z, 0-9, -, at most 48)`);
  const source = checkSafeAbs(opts.source, '--source');
  const u = requireUser(sys, opts.user || RUNNER_USER);
  const rel = path.posix.relative(u.home, source);
  if (rel.startsWith('..') || rel === '')
    throw new AdminError(`--source must be one of ${u.name}'s own clones (inside ${u.home}): ${source}`);
  const st = fs.lstatSync(P(sys, source), { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new AdminError(`${source} is not a directory (symlinks are refused)`);
  assertNoSymlinkBelow(sys, u.home, source);
  const helper = loadDeployCompose(sys);
  for (const d of ['/etc/guildwise-runner', APPS_CONF_DIR, STATE_DIR]) ensureRootDir(sys, d);
  const confPath = `${APPS_CONF_DIR}/${app}.conf`;
  const rootHome = lookupUser(sys, 'root')?.home || (sys.platform === 'darwin' ? '/var/root' : '/root');
  let res;
  try {
    res = await helper.prepare(app, P(sys, source), {
      rootUid: sys.rootUid ?? 0,
      dropPrivileges: true,
      homeDir: rootHome,
      readerCommand: [sys.execPath, P(sys, DEPLOY_COMPOSE)],
      ...(sys.root === '/' ? {} : { confDir: P(sys, APPS_CONF_DIR), stateDir: P(sys, `${STATE_DIR}/apps`) }),
    });
  } catch (e) {
    throw new AdminError(`${app} was not approved: ${String(e?.message ?? e).slice(0, 1500)}`);
  }
  if (!res || typeof res.hash !== 'string' || !/^[0-9a-f]{64}$/.test(res.hash))
    throw new AdminError('deploy-compose did not return a sha256 hash');
  const before = fs.existsSync(P(sys, confPath))
    ? parseAppConf(fs.readFileSync(P(sys, confPath), 'utf8'))
    : {};
  note(sys, `Resolved config of ${app} (from the frozen copy of ${source}):`);
  note(sys, JSON.stringify(res.pinned ?? {}, null, 2));
  note(
    sys,
    `Hash ${res.hash}${before.hash ? (before.hash === res.hash ? ' (unchanged)' : ` (was ${before.hash})`) : ' (new app)'}`,
  );
  if (!opts.yes) {
    const a = String(await sys.ask(`Approve ${app} with this config? [y/N] `))
      .trim()
      .toLowerCase();
    if (a !== 'y' && a !== 'yes') {
      note(sys, `${app} not approved; nothing changed.`);
      return { approved: false, hash: res.hash };
    }
  }
  writeRootFile(sys, confPath, helper.formatAppConf({ source, hash: res.hash }), 0o644);
  note(sys, `Approved ${app}: ${confPath}.`);
  return { approved: true, hash: res.hash };
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
  checkUserName(human);
  if (human === RUNNER_USER) throw new AdminError('the runner user does not need read access to itself');
  const h = requireUser(sys, human);
  const u = requireUser(sys, opts.user || RUNNER_USER);
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
  const h = requireUser(sys, checkUserName(human));
  if (groupsOf(sys, h.name).includes(READERS_GROUP)) removeFromGroup(sys, h.name, READERS_GROUP);
  const u = lookupUser(sys, opts.user || RUNNER_USER);
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
  const fromName = opts.from || sys.env.SUDO_USER;
  if (!fromName) throw new AdminError('name the user whose runner to move: --from <user>');
  const from = requireUser(sys, fromName);
  const to = requireUser(sys, opts.to || RUNNER_USER, 'run `guildwise-admin user create` first');
  if (from.uid === 0) throw new AdminError('refusing to migrate root');
  if (from.uid === to.uid) throw new AdminError('the runner already runs as that user');
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
    `Sudo is off for ${to.name} (your sealed sudo password was not copied): \`sudo ${SELF_PATH} sudo on\` if you want it, then run \`sudo -u ${to.name} -H guildwise-runner setup\`.`,
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
    `Then start the runner as ${to.name}, and after its first good start run: sudo ${SELF_PATH} migrate-user --finish`,
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

function migrateFinish(sys) {
  const text = fs.existsSync(P(sys, MIGRATE_MARKER)) ? readOwnedFile(sys, MIGRATE_MARKER, 0) : null;
  if (!text) throw new AdminError('no migration is waiting to be finished');
  const m = JSON.parse(text);
  const from = requireUser(sys, m.from);
  const to = requireUser(sys, m.to);
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
 * [rv6-1] The admin tools and every parent up to / are root-owned and not writable by group or others; the sudoers
 * files are root 0440 and pass visudo; root's PATH (and sudo's secure_path) never reaches into the runner's HOME.
 */
function verifyInstall(sys, opts = {}) {
  const problems = [];
  const rootUid = opts.rootUid ?? sys.rootUid ?? 0;
  const checkNode = (abs, mustExist) => {
    const st = fs.lstatSync(P(sys, abs), { throwIfNoEntry: false });
    if (!st) {
      if (mustExist) problems.push(`${abs} is missing`);
      return null;
    }
    if (st.isSymbolicLink()) problems.push(`${abs} is a symlink`);
    if (st.uid !== rootUid) problems.push(`${abs} is not owned by root`);
    if (st.mode & 0o022)
      problems.push(`${abs} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    return st;
  };
  let cur = ADMIN_DIR;
  const parents = [];
  while (cur !== '/') {
    parents.unshift(cur);
    cur = path.posix.dirname(cur);
  }
  parents.unshift('/');
  for (const p of parents) checkNode(p, true);
  const walk = (abs) => {
    const st = checkNode(abs, true);
    if (st?.isDirectory()) for (const n of fs.readdirSync(P(sys, abs))) walk(path.posix.join(abs, n));
  };
  for (const f of ['guildwise-admin', 'deploy-compose', 'node']) walk(path.posix.join(ADMIN_DIR, f));
  for (const f of [SUDOERS_SUDO, SUDOERS_DOCKER]) {
    const st = checkNode(f, false);
    if (!st) continue;
    if ((st.mode & 0o777) !== 0o440) problems.push(`${f} must be mode 0440`);
    const r = sys.run('visudo', ['-cf', P(sys, f)]);
    if (r.code !== 0) problems.push(`${f} does not pass visudo -cf`);
  }
  const u = lookupUser(sys, opts.user || RUNNER_USER);
  if (u) {
    const pathVars = [sys.env.PATH || '', ...securePaths(sys)];
    for (const v of pathVars)
      for (const entry of v.split(':').filter(Boolean))
        if (entry === u.home || entry.startsWith(`${u.home}/`))
          problems.push(`root's PATH includes the runner's HOME (${entry})`);
  }
  for (const p of problems) sys.err(`problem: ${p}`);
  if (problems.length === 0)
    note(sys, "The root-owned tools, the sudoers files and root's PATH are as they should be.");
  return problems;
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
 * only. `--yes` alone gives the safest values: a dedicated user, sudo off, no Docker.
 */
async function apply(sys, o) {
  const env = sys.env || {};
  const runnerUser = o['runner-user'] || envFlag(env, 'RUNNER_USER') || (o.yes ? 'dedicated' : undefined);
  const sudo = o.sudo || envFlag(env, 'SUDO') || 'off';
  const docker = o.docker || envFlag(env, 'DOCKER') || 'none';
  const accept = o['accept-root-equivalent'] || envFlag(env, 'ACCEPT_ROOT_EQUIVALENT') === '1';
  const apps = [
    ...(o['approve-app'] || []),
    ...String(envFlag(env, 'APPROVE_APP') || '')
      .split(',')
      .filter(Boolean),
  ];
  if (!['dedicated', 'current'].includes(runnerUser || ''))
    throw new AdminError('--runner-user dedicated|current is required (or --yes for the dedicated user)');
  if (!['on', 'off'].includes(sudo)) throw new AdminError('--sudo must be on or off');
  if (!['none', 'narrow', 'group'].includes(docker))
    throw new AdminError('--docker must be none, narrow or group');
  if (docker === 'group' && !accept) throw new AdminError('--docker group needs --accept-root-equivalent');
  if (apps.length > 0 && docker !== 'narrow') throw new AdminError('--approve-app needs --docker narrow');
  let user = RUNNER_USER;
  if (runnerUser === 'dedicated') {
    userCreate(sys);
    serviceInstall(sys, { runnerRoot: o['runner-root'], start: o.start });
  } else {
    user = o.user || sys.env.SUDO_USER;
    if (!user) throw new AdminError('with --runner-user current, name the user: --user <name>');
    note(
      sys,
      `Keeping the current user ${user}: the runner refuses to start while that user is root-equivalent, unless accepted.`,
    );
  }
  if (runnerUser === 'dedicated') {
    if (sudo === 'on') {
      // on a fresh install the runner key appears only after pairing and setup as the runner user: defer, keep going
      const u = lookupUser(sys, RUNNER_USER);
      if (!sys.dryRun && u && !runnerKeysPresent(sys, u, runnerDataRoot(u, o['data-dir'])))
        note(
          sys,
          `Sudo needs the runner key, which exists after pairing: once \`sudo -u ${RUNNER_USER} -H guildwise-runner setup\` has run, run \`sudo ${SELF_PATH} sudo on\`.`,
        );
      else sudoOn(sys, { dataDir: o['data-dir'] });
    } else if (lookupUser(sys, RUNNER_USER)) sudoOff(sys, { dataDir: o['data-dir'] });
  } else if (sudo === 'on') {
    note(
      sys,
      `Sudo for ${user}: \`guildwise-runner setup --sudo on --sudo-password-stdin\` seals your own password.`,
    );
  }
  dockerMode(sys, docker, { user, acceptRootEquivalent: accept });
  for (const spec of apps) {
    const i = spec.indexOf('=');
    if (i <= 0) throw new AdminError(`--approve-app takes <app>=<folder>, got ${JSON.stringify(spec)}`);
    const r = await approveApp(sys, spec.slice(0, i), { source: spec.slice(i + 1), user, yes: true });
    if (!r.approved) throw new AdminError(`${spec.slice(0, i)} was not approved`);
  }
}

// ----------------------------------------------------------------------------------------------- main

const USAGE = `usage: sudo ${SELF_PATH} <command> [options]
  user create
  service install [--runner-root <dir>] [--start] | service remove
  sudo on|off [--data-dir <dir>]
  docker none|narrow|group [--user <name>] [--accept-root-equivalent]
  approve-app <app> --source <folder> [--yes]
  readers add|remove <user> [--path <clones folder>]
  migrate-user [--from <user>] [--to <user>] [--data-dir <dir>] | migrate-user --finish
  apply --yes | --runner-user dedicated|current [--sudo on|off] [--docker none|narrow|group]
        [--accept-root-equivalent] [--approve-app <app>=<folder>]... [--runner-root <dir>] [--start]
  verify
every command: --dry-run (print what would change; changes nothing)`;

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  user: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'data-dir': { type: 'string' },
  'runner-root': { type: 'string' },
  start: { type: 'boolean' },
  source: { type: 'string' },
  path: { type: 'string' },
  finish: { type: 'boolean' },
  'accept-root-equivalent': { type: 'boolean' },
  'runner-user': { type: 'string' },
  sudo: { type: 'string' },
  docker: { type: 'string' },
  'approve-app': { type: 'string', multiple: true },
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
    checkInterpreter(sys);
    const { values: o, positionals: pos } = util.parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
    if (o.help || pos.length === 0) {
      sys.out(USAGE);
      return pos.length === 0 && !o.help ? 64 : 0;
    }
    sys.dryRun = Boolean(o['dry-run']);
    checkPlatform(sys);
    checkRoot(sys);
    const [cmd, sub, arg] = pos;
    if (cmd === 'user' && sub === 'create') userCreate(sys, { name: o.user });
    else if (cmd === 'service' && sub === 'install')
      serviceInstall(sys, { user: o.user, runnerRoot: o['runner-root'], start: o.start });
    else if (cmd === 'service' && sub === 'remove') serviceRemove(sys);
    else if (cmd === 'sudo' && sub === 'on') sudoOn(sys, { user: o.user, dataDir: o['data-dir'] });
    else if (cmd === 'sudo' && sub === 'off') sudoOff(sys, { user: o.user, dataDir: o['data-dir'] });
    else if (cmd === 'docker' && sub)
      dockerMode(sys, sub, { user: o.user, acceptRootEquivalent: o['accept-root-equivalent'] });
    else if (cmd === 'approve-app' && sub) {
      const r = await approveApp(sys, sub, { source: o.source, user: o.user, yes: o.yes });
      return r.approved ? 0 : 1;
    } else if (cmd === 'readers' && sub === 'add' && arg)
      readersAdd(sys, arg, { user: o.user, path: o.path });
    else if (cmd === 'readers' && sub === 'remove' && arg) readersRemove(sys, arg, { user: o.user });
    else if (cmd === 'migrate-user')
      migrateUser(sys, { from: o.from, to: o.to, dataDir: o['data-dir'], finish: o.finish });
    else if (cmd === 'apply') await apply(sys, o);
    else if (cmd === 'verify') return verifyInstall(sys, { user: o.user }).length === 0 ? 0 : 1;
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
  DEPLOY_COMPOSE,
  RUNNER_USER,
  READERS_GROUP,
  RUNNER_FLOOR,
  SUDOERS_SUDO,
  SUDOERS_DOCKER,
  APPS_CONF_DIR,
  MIGRATE_MARKER,
  SYSTEMD_UNIT,
  LAUNCHD_PLIST,
  MIN_FETCH_GIT,
  AdminError,
  main,
  realSystem,
  sudoersForSudo,
  sudoersForDocker,
  unitText,
  plistText,
  parseAppConf,
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
