#!/usr/local/lib/guildwise/node/bin/node
'use strict';
/*
 * deploy-compose: the root-owned Docker helper of the narrow Docker mode (DESIGN R20 step 4, [rv6-2], [rv7-8], [rv7-9]).
 *
 * Installed by the installer (never by runner self-update) as /usr/local/lib/guildwise/deploy-compose, root:root 0755,
 * and named by the only NOPASSWD sudoers rule:
 *   guildwise-runner ALL=(root) NOPASSWD: /usr/local/lib/guildwise/deploy-compose
 *
 *   deploy-compose <app> up|pull|down    deploy the approved compose app
 *   deploy-compose <app> resolve         print the checked, pinned config and whether it matches the approval
 *
 * Steps (each one has a test per known escape in apps/runner/test/deploy-compose.test.ts):
 *   1. read the root-owned /etc/guildwise-runner/apps/<app>.conf (source folder, approved hash, reader uid/gid);
 *   2. freeze the source folder into /var/lib/guildwise/apps/<app>/<snapshot>/ (root-owned). The tree is read by a child
 *      process running as the uid/gid fixed at approval (never derived from the path), so a symlink or a swap race can
 *      never make root read a file that user could not read anyway; symlinks, hard links, devices, FIFOs, sockets and
 *      oversized trees are refused; an existing snapshot is reused only if it still hashes to the same tree;
 *   3. pre-scan the raw compose files (and every local file they include or extend) and refuse a non-local include or
 *      extends source, an env_file outside the folder, a top-level name and Docker/Compose settings in .env files,
 *      all before `docker compose config` runs; then resolve with a clean env;
 *   4. validate the resolved config against an allowlist (any other key or value is refused);
 *   5. pin: sha256 of the canonical resolved JSON with the snapshot path replaced by $APP; it must equal the approval;
 *   6. resolve the written file once more and require the same pin (Compose interpolates it again), then run
 *      `docker compose -p guildwise-<app>` on it, with the clean env and root's own registry auth.
 *
 * Self-contained on purpose: it requires nothing but Node built-ins (never the runner tree) and refuses to run under
 * any interpreter but /usr/local/lib/guildwise/node/bin/node. guildwise-admin's approve-app may require() this file
 * (it is CommonJS, so it loads from an extensionless path) and call prepare() to get the same freeze, checks and pin.
 *
 * Exit codes: 0 ok, 1 docker failed, 2 usage, 3 held (the config differs from the approved one), 4 refused (an escape
 * or a key outside the allowlist), 5 environment (not root, wrong interpreter, unsafe ownership or permissions).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DEFAULTS = Object.freeze({
  nodeBin: '/usr/local/lib/guildwise/node/bin/node',
  confDir: '/etc/guildwise-runner/apps',
  stateDir: '/var/lib/guildwise/apps',
  dockerCandidates: ['/usr/bin/docker', '/usr/local/bin/docker'],
  path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  adminCommand: 'sudo /usr/local/lib/guildwise/guildwise-admin',
});

const LIMITS = Object.freeze({
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 50_000,
  maxDepth: 48,
  maxPathLength: 1024,
  maxHeaderBytes: 4096,
  maxYamlBytes: 1024 * 1024,
  maxYamlNodes: 100_000,
  maxYamlDepth: 64,
  maxComposeFiles: 64,
  maxConfigBytes: 32 * 1024 * 1024,
  keepSnapshots: 3,
  staleLockMs: 2 * 60 * 60 * 1000,
});

const EXIT = Object.freeze({ OK: 0, DOCKER: 1, USAGE: 2, HELD: 3, REFUSED: 4, ENV: 5 });
const ACTIONS = new Set(['up', 'pull', 'down', 'resolve']);
const APP_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const BASE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OVERRIDE_FILES = [
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
];
// .env keys that would steer Docker or Compose itself rather than interpolate a value.
const DOTENV_REFUSED_PREFIXES = ['COMPOSE_', 'DOCKER_', 'BUILDX_', 'BUILDKIT_'];
const PLACEHOLDER = '$APP';

class DeployError extends Error {
  constructor(message, exitCode, problems) {
    super(message);
    this.name = 'DeployError';
    this.exitCode = exitCode;
    this.problems = problems || [message];
  }
}
const refused = (msg, problems) => new DeployError(msg, EXIT.REFUSED, problems);
const envError = (msg) => new DeployError(msg, EXIT.ENV);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrim = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Checks on the environment and on root-owned files                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

function checkAppName(app) {
  if (typeof app !== 'string' || !APP_RE.test(app)) {
    throw new DeployError(
      `invalid app name ${JSON.stringify(app)}: use a-z, 0-9 and -, at most 48`,
      EXIT.USAGE,
    );
  }
}

/** The file or directory must be owned by root, not a symlink and not writable by group or others. */
function checkRootOwned(p, rootUid, kind) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    throw envError(`${p} does not exist`);
  }
  if (st.isSymbolicLink()) throw envError(`${p} is a symlink`);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw envError(`${p} is not a ${kind}`);
  if (st.uid !== rootUid) throw envError(`${p} is not owned by root`);
  if (st.mode & 0o022) throw envError(`${p} is writable by group or others`);
  return st;
}

function preflight(opts, proc = process) {
  if (proc.execPath !== opts.nodeBin) {
    throw envError(`refusing to run under ${proc.execPath}: deploy-compose runs only under ${opts.nodeBin}`);
  }
  // Node reads NODE_OPTIONS, NODE_COMPILE_CACHE and friends before this check runs: sudo's env_reset is the real
  // control. Refusing them here at least makes a sudoers file without env_reset loud.
  const nodeVars = Object.keys(proc.env).filter((k) => /^(NODE_|UV_)/i.test(k));
  if (proc.execArgv.length > 0 || nodeVars.length > 0) {
    throw envError(`refusing to run with Node options (${[...proc.execArgv, ...nodeVars].join(', ')})`);
  }
  if (typeof proc.getuid !== 'function' || proc.getuid() !== 0 || proc.geteuid() !== 0) {
    throw envError('deploy-compose must run as root (through its sudoers rule)');
  }
}

function findDocker(opts) {
  if (opts.docker) return opts.docker;
  for (const candidate of opts.dockerCandidates || DEFAULTS.dockerCandidates) {
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const st = fs.statSync(real);
    if (!st.isFile() || st.uid !== opts.rootUid || st.mode & 0o022) {
      throw envError(`${candidate} (${real}) must be a root-owned file not writable by group or others`);
    }
    return real;
  }
  throw envError('docker was not found in /usr/bin or /usr/local/bin');
}

/** The approval record written by `guildwise-admin approve-app`: `source=<abs folder>` and `hash=<sha256>` lines. */
function parseAppConf(text) {
  const conf = { source: '', hash: '', owner: null, group: null };
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) throw envError(`app config: unreadable line ${JSON.stringify(t.slice(0, 80))}`);
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    if (key === 'source' || key === 'hash') conf[key] = value;
    if (key === 'owner' || key === 'group') {
      if (!/^\d{1,10}$/.test(value)) throw envError(`app config: ${key} must be a numeric id`);
      conf[key] = Number(value);
    }
  }
  if (conf.owner === 0) throw envError('app config: owner must not be root');
  if (conf.group === 0) throw envError('app config: group must not be root');
  if (!conf.source || !path.isAbsolute(conf.source) || path.normalize(conf.source) !== conf.source) {
    throw envError('app config: source must be an absolute, normalized path');
  }
  if (conf.hash && !HASH_RE.test(conf.hash))
    throw envError('app config: hash must be 64 lowercase hex characters');
  return conf;
}

/**
 * `owner`/`group` are the uid/gid the freeze reader runs as, fixed at approval (the folder owner the human approved).
 * deploy-compose never derives them from the path at run time [B1].
 */
function formatAppConf({ source, hash, owner, group }) {
  if (!Number.isSafeInteger(owner) || owner <= 0)
    throw envError('formatAppConf: owner must be a non-root uid');
  if (!Number.isSafeInteger(group) || group <= 0)
    throw envError('formatAppConf: group must be a non-root gid');
  return `# written by guildwise-admin approve-app\nsource=${source}\nhash=${hash}\nowner=${owner}\ngroup=${group}\n`;
}

function readAppConf(app, opts) {
  checkAppName(app);
  checkRootOwned(path.dirname(opts.confDir), opts.rootUid, 'dir');
  checkRootOwned(opts.confDir, opts.rootUid, 'dir');
  const file = path.join(opts.confDir, `${app}.conf`);
  try {
    fs.lstatSync(file);
  } catch {
    throw envError(`${app} is not an approved app: run ${opts.adminCommand} approve-app ${app}`);
  }
  checkRootOwned(file, opts.rootUid, 'file');
  return parseAppConf(fs.readFileSync(file, 'utf8'));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Freeze: an unprivileged reader streams the tree, root writes and checks it                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/*
 * Stream format (reader stdout): a JSON header line per entry, followed for files by exactly `s` bytes.
 *   {"t":"d","p":"rel"}   directory      {"t":"f","p":"rel","s":123,"x":true}   regular file (x: executable)
 *   {"t":"x","p":"rel","why":"..."}       refused entry                         {"t":"end"}
 * The reader is untrusted (it runs as the source owner): root re-checks every path, size and count.
 */
async function runReader(src, out) {
  const write = (buf) =>
    new Promise((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  const header = (obj) => write(Buffer.from(`${JSON.stringify(obj)}\n`));
  let entries = 0;
  let total = 0;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

  async function walk(rel, depth) {
    if (depth > LIMITS.maxDepth) return { p: rel, why: 'the folder is nested too deep' };
    const dir = rel ? path.join(src, rel) : src;
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      if (!rel && name === '.git') continue;
      const r = rel ? `${rel}/${name}` : name;
      if (++entries > LIMITS.maxEntries) return { p: r, why: `more than ${LIMITS.maxEntries} entries` };
      const abs = path.join(src, r);
      const l = fs.lstatSync(abs);
      if (l.isSymbolicLink()) return { p: r, why: 'symlinks are not allowed' };
      if (l.isDirectory()) {
        await header({ t: 'd', p: r });
        const bad = await walk(r, depth + 1);
        if (bad) return bad;
        continue;
      }
      if (!l.isFile()) return { p: r, why: 'devices, FIFOs and sockets are not allowed' };
      if (l.nlink > 1) return { p: r, why: 'hard links are not allowed' };
      const fd = fs.openSync(abs, flags);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.ino !== l.ino || st.dev !== l.dev || st.nlink > 1) {
          return { p: r, why: 'the file changed while it was read' };
        }
        if (st.size > LIMITS.maxFileBytes) return { p: r, why: `larger than ${LIMITS.maxFileBytes} bytes` };
        total += st.size;
        if (total > LIMITS.maxTotalBytes)
          return { p: r, why: `the folder is larger than ${LIMITS.maxTotalBytes} bytes` };
        await header({ t: 'f', p: r, s: st.size, x: (st.mode & 0o111) !== 0 });
        let left = st.size;
        while (left > 0) {
          const chunk = Buffer.allocUnsafe(Math.min(left, 1024 * 1024));
          const n = fs.readSync(fd, chunk, 0, chunk.length, null);
          if (n === 0) return { p: r, why: 'the file changed while it was read' };
          await write(chunk.subarray(0, n));
          left -= n;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    return null;
  }

  try {
    const st = fs.lstatSync(src);
    if (!st.isDirectory()) {
      await header({ t: 'x', p: '.', why: 'the source is not a directory' });
      return 1;
    }
    const bad = await walk('', 0);
    if (bad) {
      await header({ t: 'x', ...bad });
      return 1;
    }
    await header({ t: 'end' });
    return 0;
  } catch (err) {
    await header({ t: 'x', p: '.', why: `cannot read the source folder (${err.code || err.message})` }).catch(
      () => {},
    );
    return 1;
  }
}

function checkRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > LIMITS.maxPathLength || p.includes('\0')) return false;
  const parts = p.split('/');
  if (parts.length > LIMITS.maxDepth + 1) return false;
  return parts.every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Consumes the reader stream into `dest` (a fresh root-owned directory). Returns the sha256 of the stream. */
async function receiveTree(stream, dest) {
  const hash = crypto.createHash('sha256');
  const dirs = new Set(['']);
  let buf = Buffer.alloc(0);
  let file = null; // { fd, left }
  let entries = 0;
  let total = 0;
  let ended = false;

  const onHeader = (line) => {
    let h;
    try {
      h = JSON.parse(line);
    } catch {
      throw refused('freeze: the reader sent an unreadable record');
    }
    if (!isObj(h)) throw refused('freeze: the reader sent an unreadable record');
    if (h.t === 'end') {
      ended = true;
      return;
    }
    if (h.t === 'x') throw refused(`freeze: ${String(h.p)}: ${String(h.why)}`);
    if (ended) throw refused('freeze: data after the end record');
    if (!checkRelPath(h.p))
      throw refused(`freeze: refused path ${JSON.stringify(String(h.p)).slice(0, 200)}`);
    const parent = h.p.includes('/') ? h.p.slice(0, h.p.lastIndexOf('/')) : '';
    if (!dirs.has(parent)) throw refused(`freeze: ${h.p}: parent directory was not sent first`);
    if (++entries > LIMITS.maxEntries) throw refused(`freeze: more than ${LIMITS.maxEntries} entries`);
    const target = path.join(dest, h.p);
    if (h.t === 'd') {
      fs.mkdirSync(target, { mode: 0o755 });
      fs.chmodSync(target, 0o755);
      dirs.add(h.p);
      hash.update(`d\0${h.p}\n`);
      return;
    }
    if (h.t !== 'f' || !Number.isSafeInteger(h.s) || h.s < 0 || h.s > LIMITS.maxFileBytes) {
      throw refused(`freeze: ${h.p}: refused entry`);
    }
    total += h.s;
    if (total > LIMITS.maxTotalBytes)
      throw refused(`freeze: the folder is larger than ${LIMITS.maxTotalBytes} bytes`);
    const mode = h.x === true ? 0o755 : 0o644;
    const fd = fs.openSync(target, 'wx', mode);
    fs.fchmodSync(fd, mode);
    hash.update(`f\0${h.p}\0${mode.toString(8)}\0${h.s}\n`);
    file = { fd, left: h.s };
    if (h.s === 0) {
      fs.closeSync(fd);
      file = null;
    }
  };

  const drain = () => {
    for (;;) {
      if (file) {
        if (buf.length === 0) return;
        const n = Math.min(file.left, buf.length);
        const part = buf.subarray(0, n);
        fs.writeSync(file.fd, part);
        hash.update(part);
        file.left -= n;
        buf = buf.subarray(n);
        if (file.left === 0) {
          fs.closeSync(file.fd);
          file = null;
        }
        continue;
      }
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > LIMITS.maxHeaderBytes) throw refused('freeze: the reader sent an oversized record');
        return;
      }
      if (nl > LIMITS.maxHeaderBytes) throw refused('freeze: the reader sent an oversized record');
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      onHeader(line);
    }
  };

  try {
    for await (const chunk of stream) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      drain();
    }
  } finally {
    if (file) fs.closeSync(file.fd);
  }
  if (!ended || file || buf.length) throw refused('freeze: the reader stopped before the end of the tree');
  return hash.digest('hex');
}

function ensureAppDir(app, opts) {
  fs.mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
  checkRootOwned(path.dirname(opts.stateDir), opts.rootUid, 'dir');
  checkRootOwned(opts.stateDir, opts.rootUid, 'dir');
  const appDir = path.join(fs.realpathSync(opts.stateDir), app);
  try {
    fs.mkdirSync(appDir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  checkRootOwned(appDir, opts.rootUid, 'dir');
  return appDir;
}

/**
 * The tree hash of an existing snapshot, computed exactly like receiveTree; null when it holds anything a freeze
 * never writes (symlinks, hard links, special files, other modes or owners).
 */
function hashTree(root, rootUid) {
  const hash = crypto.createHash('sha256');
  const rootSt = fs.lstatSync(root);
  if (!rootSt.isDirectory() || rootSt.uid !== rootUid || (rootSt.mode & 0o7777) !== 0o755) return null;
  const walk = (rel) => {
    for (const name of fs.readdirSync(rel ? path.join(root, rel) : root).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const abs = path.join(root, r);
      const l = fs.lstatSync(abs);
      if (l.uid !== rootUid) return false;
      const mode = l.mode & 0o7777;
      if (l.isDirectory()) {
        if (mode !== 0o755) return false;
        hash.update(`d\0${r}\n`);
        if (!walk(r)) return false;
        continue;
      }
      if (!l.isFile() || l.nlink !== 1 || (mode !== 0o644 && mode !== 0o755)) return false;
      hash.update(`f\0${r}\0${mode.toString(8)}\0${l.size}\n`);
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const buf = Buffer.allocUnsafe(1024 * 1024);
        let left = l.size;
        while (left > 0) {
          const n = fs.readSync(fd, buf, 0, Math.min(left, buf.length), null);
          if (n === 0) return false;
          hash.update(buf.subarray(0, n));
          left -= n;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    return true;
  };
  return walk('') ? hash.digest('hex') : null;
}

async function freeze(sourceDir, appDir, opts) {
  let st;
  try {
    st = fs.lstatSync(sourceDir);
  } catch {
    throw refused(`the source folder ${sourceDir} does not exist`);
  }
  if (st.isSymbolicLink() || !st.isDirectory())
    throw refused(`the source folder ${sourceDir} is not a directory`);
  const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: opts.path }, cwd: '/' };
  if (opts.dropPrivileges) {
    // [B1] The reader's identity is the one fixed at approval, never the owner of whatever the path resolves to now
    // (a parent of the path can be swapped for a symlink to another user's folder).
    const { readerUid, readerGid } = opts;
    if (
      !Number.isSafeInteger(readerUid) ||
      readerUid <= 0 ||
      !Number.isSafeInteger(readerGid) ||
      readerGid <= 0
    ) {
      throw envError(
        `the reader uid/gid of this app are not set: run ${opts.adminCommand || DEFAULTS.adminCommand} approve-app again`,
      );
    }
    if (st.uid !== readerUid) {
      throw refused(`the source folder is owned by uid ${st.uid}, not the approved uid ${readerUid}`);
    }
    // libuv drops the supplementary groups (setgroups) when uid/gid are set.
    spawnOpts.uid = readerUid;
    spawnOpts.gid = readerGid;
  }
  const tmp = fs.mkdtempSync(path.join(appDir, '.freeze-'));
  fs.chmodSync(tmp, 0o755);
  const [cmd, ...args] = opts.readerCommand;
  const child = (opts.spawn || spawn)(cmd, [...args, '--reader', sourceDir], spawnOpts);
  let stderr = '';
  child.on('error', (e) => {
    stderr += `cannot start the reader: ${e.message}`;
  });
  child.stderr.on('data', (d) => {
    if (stderr.length < 4096) stderr += d.toString();
  });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  try {
    const treeHash = await receiveTree(child.stdout, tmp);
    const code = await exited;
    if (code !== 0) throw refused(`freeze: the reader failed (${code}) ${stderr.trim()}`.trim());
    const dir = path.join(appDir, treeHash);
    // Content-addressed: an existing snapshot of the same tree stays (running containers may bind-mount it), but only
    // after it is re-hashed and still matches; a changed one is replaced [B2].
    if (fs.existsSync(dir) && hashTree(dir, opts.rootUid) === treeHash)
      fs.rmSync(tmp, { recursive: true, force: true });
    else {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    }
    const now = new Date();
    fs.utimesSync(dir, now, now);
    return { dir, hash: treeHash };
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err instanceof DeployError ? err : refused(`freeze: ${err.code || err.message}`);
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A conservative YAML reader for the pre-scan                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/*
 * Reads the block and flow YAML that compose files use: mappings, sequences, plain/quoted/block scalars, comments,
 * anchors, aliases and merge keys. Anything else (tags, complex keys, directives, several documents, duplicate keys,
 * tab indentation) is refused rather than guessed, so it can never read a file differently from Compose without
 * saying so. It records the span of every key and scalar; the pre-scan then requires every occurrence of the words
 * `include` and `extends` in the raw text to sit inside one of them (so a comment cannot hide one).
 */
function parseYaml(input, label) {
  const fail = (msg, off) => {
    let where = '';
    if (off !== undefined) {
      const line = input.slice(0, off).split('\n').length;
      where = ` (line ${line})`;
    }
    return refused(`pre-scan: ${label}: ${msg}${where}; simplify the YAML`);
  };
  if (input.length > LIMITS.maxYamlBytes) throw fail('the file is too large');
  const src = input.replace(/\r\n?/g, (m) => `${' '.repeat(m.length - 1)}\n`);
  if (src.charCodeAt(0) === 0xfeff) throw fail('byte-order marks are not supported');
  const lines = [];
  {
    let start = 0;
    for (const raw of src.split('\n')) {
      lines.push({ start, raw });
      start += raw.length + 1;
    }
  }
  const spans = [];
  const anchors = new Map();
  let nodes = 0;
  let li = 0;
  let vcol = -1;
  let docStarted = false;

  const count = () => {
    if (++nodes > LIMITS.maxYamlNodes) throw fail('too many nodes');
  };
  const lineOf = (off) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].start <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const leading = (raw) => {
    let i = 0;
    while (i < raw.length && raw[i] === ' ') i++;
    return i;
  };
  const isBlankRest = (s) => s.trim() === '' || /^\s*#/.test(s);
  const isSeqStart = (rest) => rest === '-' || rest.startsWith('- ');

  // Moves to the next line with content (or EOF). Refuses directives, a second document and tab indentation.
  const skipBlank = () => {
    if (vcol >= 0) return;
    while (li < lines.length) {
      const raw = lines[li].raw;
      const ws = /^[ \t]*/.exec(raw)[0];
      const rest = raw.slice(ws.length);
      if (rest === '' || rest.startsWith('#')) {
        li++;
        continue;
      }
      if (ws.includes('\t')) throw fail('tab indentation', lines[li].start);
      if (ws === '' && rest.startsWith('%')) throw fail('directives are not supported', lines[li].start);
      if (ws === '' && /^(---|\.\.\.)(\s|$)/.test(rest)) {
        if (!docStarted && nodes === 0 && rest.startsWith('---') && isBlankRest(rest.slice(3))) {
          docStarted = true;
          li++;
          continue;
        }
        throw fail('several documents in one file are not supported', lines[li].start);
      }
      return;
    }
  };
  const peek = () => {
    const L = lines[li];
    const col = vcol >= 0 ? vcol : leading(L.raw);
    return { col, rest: L.raw.slice(col), start: L.start + col };
  };
  const nextLine = () => {
    li++;
    vcol = -1;
  };
  // Continue parsing on the same line at column `col`, or on the next line when only a comment is left.
  const moveTo = (col) => {
    const raw = lines[li].raw;
    let c = col;
    while (c < raw.length && raw[c] === ' ') c++;
    if (isBlankRest(raw.slice(c))) nextLine();
    else vcol = c;
  };
  const expectLineEnd = (off) => {
    const L = lineOf(off);
    const rest = src.slice(off, lines[L].start + lines[L].raw.length);
    if (!isBlankRest(rest)) throw fail('unexpected text after a value', off);
    li = L + 1;
    vcol = -1;
  };

  const ESC = {
    0: '\0',
    a: '\x07',
    b: '\b',
    t: '\t',
    '\t': '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    e: '\x1b',
  };
  Object.assign(ESC, { ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' });
  // Reads a quoted scalar starting at `off`; returns { value, end }.
  const readQuoted = (off, singleLine) => {
    const q = src[off];
    let i = off + 1;
    let out = '';
    for (;;) {
      if (i >= src.length) throw fail('unterminated quoted string', off);
      const c = src[i];
      if (c === '\n') {
        if (singleLine) throw fail('a quoted key must fit on one line', off);
        out = out.replace(/[ \t]+$/, '');
        let j = i + 1;
        let breaks = 0;
        for (;;) {
          while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
          if (src[j] === '\n') {
            breaks++;
            j++;
            continue;
          }
          break;
        }
        out += breaks ? '\n'.repeat(breaks) : ' ';
        i = j;
        continue;
      }
      if (q === "'") {
        if (c === "'") {
          if (src[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          break;
        }
        out += c;
        i++;
        continue;
      }
      if (c === '"') break;
      if (c === '\\') {
        const e = src[i + 1];
        if (e === '\n') {
          i += 2;
          while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
        const hexLen = { x: 2, u: 4, U: 8 }[e];
        if (hexLen) {
          const hex = src.slice(i + 2, i + 2 + hexLen);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== hexLen) throw fail('bad escape', i);
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 2 + hexLen;
          continue;
        }
        if (e === undefined || !(e in ESC)) throw fail('unknown escape', i);
        out += ESC[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    spans.push([off, i + 1]);
    return { value: out, end: i + 1 };
  };

  // A mapping key at the start of `rest` (absolute offset `abs`): { key, valueCol } or null.
  const matchKey = (rest, abs, col) => {
    const c0 = rest[0];
    if (c0 === '"' || c0 === "'") {
      const { value, end } = readQuoted(abs, true);
      const after = src.slice(end, lines[lineOf(abs)].start + lines[lineOf(abs)].raw.length);
      const m = /^ *:(?= |$)/.exec(after);
      if (!m) {
        spans.pop();
        return null;
      }
      return { key: value, valueCol: col + (end - abs) + m[0].length };
    }
    if ('[]{}?!&*|>%@`#,'.includes(c0) || isSeqStart(rest)) return null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '#' && i > 0 && rest[i - 1] === ' ') return null;
      if (rest[i] === ':' && (i + 1 === rest.length || rest[i + 1] === ' ')) {
        const key = rest.slice(0, i).trimEnd();
        if (!key) return null;
        spans.push([abs, abs + key.length]);
        return { key, valueCol: col + i + 1 };
      }
    }
    return null;
  };

  const plainValue = (s) => (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s) ? null : s);

  const parseFlow = (off, depth) => {
    let i = off;
    const ws = () => {
      for (;;) {
        while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
        if (src[i] === '#' && (i === 0 || /[ \t\n]/.test(src[i - 1]))) {
          while (i < src.length && src[i] !== '\n') i++;
          continue;
        }
        return;
      }
    };
    const node = (d) => {
      if (d > LIMITS.maxYamlDepth) throw fail('nested too deep', i);
      count();
      ws();
      const c = src[i];
      if (c === undefined) throw fail('unterminated flow collection', off);
      if (c === '!') throw fail('tags are not supported', i);
      if (c === '?') throw fail('complex keys are not supported', i);
      if (c === '&') {
        const m = /^&([^\s,[\]{}]+)/.exec(src.slice(i));
        if (!m) throw fail('bad anchor', i);
        i += m[0].length;
        const v = node(d);
        anchors.set(m[1], v);
        return v;
      }
      if (c === '*') {
        const m = /^\*([^\s,[\]{}]+)/.exec(src.slice(i));
        if (!m || !anchors.has(m[1])) throw fail('unknown alias', i);
        i += m[0].length;
        return anchors.get(m[1]);
      }
      if (c === '[') {
        i++;
        const arr = [];
        for (;;) {
          ws();
          if (src[i] === ']') {
            i++;
            return arr;
          }
          arr.push(node(d + 1));
          ws();
          if (src[i] === ':') throw fail('key/value pairs inside a flow sequence are not supported', i);
          if (src[i] === ',') i++;
          else if (src[i] !== ']') throw fail('expected , or ]', i);
        }
      }
      if (c === '{') {
        i++;
        const obj = Object.create(null);
        const merges = [];
        for (;;) {
          ws();
          if (src[i] === '}') {
            i++;
            return applyMerges(obj, merges, i);
          }
          const k = node(d + 1);
          if (k !== null && typeof k !== 'string')
            throw fail('flow collections as keys are not supported', i);
          const key = k === null ? '' : k;
          ws();
          let v = null;
          if (src[i] === ':') {
            i++;
            ws();
            v = src[i] === ',' || src[i] === '}' ? null : node(d + 1);
          }
          if (key === '<<') merges.push(v);
          else {
            if (key in obj) throw fail(`duplicate key ${JSON.stringify(key)}`, i);
            obj[key] = v;
          }
          ws();
          if (src[i] === ',') i++;
          else if (src[i] !== '}') throw fail('expected , or }', i);
        }
      }
      if (c === '"' || c === "'") {
        const { value, end } = readQuoted(i, false);
        i = end;
        return value;
      }
      if (
        c === ',' ||
        c === ']' ||
        c === '}' ||
        c === '|' ||
        c === '>' ||
        c === '@' ||
        c === '`' ||
        c === '%'
      ) {
        throw fail(`unexpected ${c}`, i);
      }
      const start = i;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\n' || ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}') break;
        if (ch === ':' && /[\s,[\]{}]/.test(src[i + 1] || ' ')) break;
        if (ch === '#' && /[ \t]/.test(src[i - 1])) break;
        i++;
      }
      const text = src.slice(start, i).trim();
      spans.push([start, i]);
      return plainValue(text);
    };
    const v = node(depth);
    return { value: v, end: i };
  };

  const applyMerges = (obj, merges, off) => {
    for (const m of merges) {
      const list = Array.isArray(m) ? m : [m];
      for (const src2 of list) {
        if (!isObj(src2)) throw fail('a merge key needs a mapping', off);
        for (const k of Object.keys(src2)) if (!(k in obj)) obj[k] = src2[k];
      }
    }
    return obj;
  };

  // A value starting on the current line at the current column (after `key:` or `- `, or a bare document value).
  const parseInline = (parentIndent, depth) => {
    count();
    const p = peek();
    const { rest } = p;
    const { start } = p;
    if (rest[0] === '!') throw fail('tags are not supported', start);
    if (rest[0] === '&') {
      const m = /^&([^\s,[\]{}]+)/.exec(rest);
      if (!m) throw fail('bad anchor', start);
      moveTo(p.col + m[0].length);
      let v;
      if (vcol < 0) v = parseNode(parentIndent, true, depth + 1);
      else v = parseInline(parentIndent, depth + 1);
      anchors.set(m[1], v);
      return v;
    }
    if (rest[0] === '*') {
      const m = /^\*([^\s,[\]{}]+)/.exec(rest);
      if (!m || !anchors.has(m[1])) throw fail('unknown alias', start);
      expectLineEnd(start + m[0].length);
      return anchors.get(m[1]);
    }
    if (rest[0] === '[' || rest[0] === '{') {
      const { value, end } = parseFlow(start, depth + 1);
      expectLineEnd(end);
      return value;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const { value, end } = readQuoted(start, false);
      expectLineEnd(end);
      return value;
    }
    if (rest[0] === '|' || rest[0] === '>') {
      if (!/^[|>]([1-9][+-]?|[+-][1-9]?)?\s*(#.*)?$/.test(rest)) throw fail('bad block scalar header', start);
      nextLine();
      const body = [];
      let contentIndent = -1;
      let first = -1;
      let last = -1;
      while (li < lines.length) {
        const raw = lines[li].raw;
        if (raw.trim() === '') {
          body.push('');
          li++;
          continue;
        }
        const ind = leading(raw);
        if (contentIndent < 0) {
          if (ind <= parentIndent) break;
          contentIndent = ind;
        }
        if (ind < contentIndent) break;
        if (first < 0) first = lines[li].start;
        last = lines[li].start + raw.length;
        body.push(raw.slice(contentIndent));
        li++;
      }
      if (first >= 0) spans.push([first, last]);
      return body.join('\n').replace(/\n+$/, '\n');
    }
    if (rest[0] === '%' || rest[0] === '@' || rest[0] === '`')
      throw fail(`a value cannot start with ${rest[0]}`, start);
    // plain scalar, possibly folded over more-indented lines
    let end = rest.search(/ #/);
    if (end < 0) end = rest.length;
    let text = rest.slice(0, end).trim();
    let spanEnd = start + rest.slice(0, end).trimEnd().length;
    if (/: |:$/.test(text)) throw fail('a mapping cannot start on the same line as another key', start);
    nextLine();
    while (li < lines.length) {
      const raw = lines[li].raw;
      if (raw.trim() === '' || raw.trim().startsWith('#')) break;
      const ind = leading(raw);
      if (ind <= parentIndent) break;
      let r = raw.slice(ind);
      const h = r.search(/ #/);
      if (h >= 0) r = r.slice(0, h);
      r = r.trimEnd();
      if (/: |:$/.test(r) || isSeqStart(r)) throw fail('ambiguous multi-line value', lines[li].start);
      text += ` ${r}`;
      spanEnd = lines[li].start + ind + r.length;
      li++;
    }
    spans.push([start, spanEnd]);
    return plainValue(text);
  };

  const parseSeq = (indent, depth) => {
    const arr = [];
    for (;;) {
      skipBlank();
      if (li >= lines.length) break;
      const p = peek();
      if (p.col < indent || !isSeqStart(p.rest)) break;
      if (p.col > indent) throw fail('bad indentation', p.start);
      count();
      moveTo(p.col + 1);
      arr.push(parseNode(indent, false, depth + 1));
    }
    return arr;
  };

  const parseMap = (indent, depth) => {
    const obj = Object.create(null);
    const merges = [];
    for (;;) {
      skipBlank();
      if (li >= lines.length) break;
      const p = peek();
      if (p.col < indent) break;
      if (p.col > indent) throw fail('bad indentation', p.start);
      if (isSeqStart(p.rest)) break;
      const k = matchKey(p.rest, p.start, p.col);
      if (!k) throw fail('expected a "key: value" line', p.start);
      count();
      moveTo(k.valueCol);
      let v;
      if (vcol < 0) v = parseNode(indent, true, depth + 1);
      else v = parseInline(indent, depth + 1);
      if (k.key === '<<') merges.push(v);
      else {
        if (k.key in obj) throw fail(`duplicate key ${JSON.stringify(k.key)}`, p.start);
        obj[k.key] = v;
      }
    }
    return applyMerges(obj, merges, lines[Math.min(li, lines.length - 1)].start);
  };

  // A node on the current position whose indentation must be above parentIndent (or a sequence at the same
  // indentation as its parent mapping key, which YAML allows).
  function parseNode(parentIndent, allowSeqAtParent, depth) {
    if (depth > LIMITS.maxYamlDepth) throw fail('nested too deep');
    skipBlank();
    if (li >= lines.length) return null;
    const p = peek();
    const seq = isSeqStart(p.rest);
    if (p.col <= parentIndent && !(allowSeqAtParent && seq && p.col === parentIndent)) return null;
    if (seq) return parseSeq(p.col, depth);
    if (p.rest[0] === '?') throw fail('complex keys are not supported', p.start);
    const save = spans.length;
    const k = matchKey(p.rest, p.start, p.col);
    spans.length = save;
    if (k) return parseMap(p.col, depth);
    return parseInline(parentIndent, depth);
  }

  const value = parseNode(-1, false, 0);
  skipBlank();
  if (li < lines.length) throw fail('unexpected content', lines[li].start);
  spans.sort((a, b) => a[0] - b[0]);
  return { value, spans, text: src };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pre-scan of the raw files (before `docker compose config` runs)                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A path Compose may only treat as a local file inside the folder. Returns a reason or null. */
function unsafeRelPath(p) {
  if (typeof p !== 'string' || p === '') return 'not a path';
  if (p.length > 512 || [...p].some((ch) => ch.charCodeAt(0) < 0x20)) return 'not a path';
  if (p.includes('$')) return 'variables are not allowed in this path';
  if (p.startsWith('/') || p.startsWith('~') || p.startsWith('\\')) return 'absolute paths are not allowed';
  if (/[:@#]/.test(p)) return 'remote sources (URLs, git, oci) are not allowed';
  const parts = p.split(/[\\/]/);
  if (parts.includes('..')) return '".." is not allowed';
  if (parts.length > 1 && /^[^.]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(parts[0]) && !/^\./.test(parts[0])) {
    // github.com/org/repo and friends are read as git remotes by Compose
    if (/^(github\.com|gitlab\.com|bitbucket\.org)$/i.test(parts[0])) return 'remote sources are not allowed';
  }
  return null;
}

function composeFiles(root) {
  const pick = (names) => names.filter((n) => fs.existsSync(path.join(root, n)));
  const base = pick(BASE_FILES);
  const over = pick(OVERRIDE_FILES);
  if (base.length === 0) throw refused(`no compose file (${BASE_FILES.join(', ')}) in the folder`);
  if (base.length > 1) throw refused(`several compose files (${base.join(', ')}): keep one`);
  if (over.length > 1) throw refused(`several override files (${over.join(', ')}): keep one`);
  return [...base, ...over].map((n) => path.join(root, n));
}

function checkDotenvFile(file, root, problems) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/.exec(line);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (DOTENV_REFUSED_PREFIXES.some((pre) => key.startsWith(pre))) {
      problems.push(`${rel}: ${m[1]} would change how Docker or Compose itself runs; remove it`);
    }
  }
}

function walkFrozen(root, fn) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) stack.push(r);
      else fn(r, ent);
    }
  }
}

/**
 * Refuses non-local include/extends sources, env_file paths outside the folder, a top-level name and Docker/Compose
 * keys in .env files. Reads the compose files and every local file they include or extend, recursively.
 */
function prescan(root, files) {
  const problems = [];
  const seen = new Set();
  const envFiles = new Set();
  const queue = files.map((f) => ({ file: f, from: null }));

  while (queue.length) {
    const { file, from } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > LIMITS.maxComposeFiles) throw refused('pre-scan: too many included files');
    const rel = path.relative(root, file);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      problems.push(`${from}: ${rel} does not exist in the folder`);
      continue;
    }
    if (!st.isFile()) {
      problems.push(`${from}: ${rel} is not a file`);
      continue;
    }
    const { value: doc, spans, text } = parseYaml(fs.readFileSync(file, 'utf8'), rel);

    // Every occurrence of the two words must be a key or scalar the reader understood (not a comment, not hidden).
    const word = /include|extends/g;
    for (let m = word.exec(text); m; m = word.exec(text)) {
      const at = m.index;
      if (!spans.some(([a, b]) => a <= at && at < b)) {
        problems.push(
          `${rel}: "${m[0]}" outside a key or value (line ${text.slice(0, at).split('\n').length})`,
        );
      }
    }
    if (doc === null) continue;
    if (!isObj(doc)) {
      problems.push(`${rel}: the top level must be a mapping`);
      continue;
    }
    if ('name' in doc)
      problems.push(`${rel}: a top-level "name" is not allowed (the project is guildwise-<app>)`);

    const dir = path.dirname(file);
    const local = (where, p, kind) => {
      const why = unsafeRelPath(p);
      if (why) {
        problems.push(`${rel}: ${where}: ${JSON.stringify(String(p)).slice(0, 200)}: ${why}`);
        return;
      }
      if (kind === 'file') queue.push({ file: path.join(dir, p), from: rel });
      if (kind === 'env') envFiles.add(path.join(dir, p));
    };
    const strings = (v) => (Array.isArray(v) ? v : [v]);

    const visited = new Set();
    const visit = (node) => {
      if (node === null || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const v of node) visit(v);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'include') {
          for (const item of strings(v)) {
            if (typeof item === 'string') local('include', item, 'file');
            else if (isObj(item)) {
              for (const ik of Object.keys(item)) {
                if (!['path', 'env_file', 'project_directory'].includes(ik)) {
                  problems.push(`${rel}: include: "${ik}" is not allowed`);
                }
              }
              for (const p of strings(item.path)) local('include.path', p, 'file');
              if (item.env_file !== undefined)
                for (const p of strings(item.env_file)) local('include.env_file', p, 'env');
              if (item.project_directory !== undefined)
                local('include.project_directory', item.project_directory, 'dir');
            } else problems.push(`${rel}: include: unreadable entry`);
          }
        } else if (k === 'extends') {
          if (typeof v === 'string') {
            if (v.includes('$')) problems.push(`${rel}: extends: variables are not allowed`);
          } else if (isObj(v)) {
            for (const ek of Object.keys(v)) {
              if (ek !== 'service' && ek !== 'file') problems.push(`${rel}: extends: "${ek}" is not allowed`);
            }
            if (typeof v.service !== 'string' || v.service.includes('$')) {
              problems.push(`${rel}: extends.service must be a plain name`);
            }
            if (v.file !== undefined) local('extends.file', v.file, 'file');
          } else problems.push(`${rel}: extends: unreadable value`);
        } else if (k === 'env_file') {
          for (const item of strings(v)) {
            const p = isObj(item) ? item.path : item;
            local('env_file', p, 'none');
          }
        }
        visit(v);
      }
    };
    visit(doc);
  }

  walkFrozen(root, (rel) => {
    if (path.basename(rel) === '.env') envFiles.add(path.join(root, rel));
  });
  for (const f of envFiles) {
    if (fs.existsSync(f) && fs.lstatSync(f).isFile()) checkDotenvFile(f, root, problems);
  }
  if (problems.length)
    throw refused(`pre-scan refused the compose files:\n  - ${problems.join('\n  - ')}`, problems);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Allowlist of the resolved config                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

function isInside(p, root) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  const n = path.normalize(p);
  return n === root || n.startsWith(`${root}/`);
}

/** The repository part of an image reference, without the tag, digest, Docker Hub host or library/ prefix. */
function imageRepo(image) {
  let repo = image.split('@')[0].replace(/:[^/:]*$/, '');
  repo = repo
    .replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '')
    .replace(/^library\//, '');
  return repo;
}

function validateResolved(cfg, { root, project }) {
  const problems = [];
  const bad = (where, msg) => problems.push(`${where}: ${msg}`);
  const onlyKeys = (where, obj, allowed) => {
    if (!isObj(obj)) {
      bad(where, 'must be a mapping');
      return false;
    }
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${where}.${k}`, 'not allowed');
    return true;
  };
  const prims = (where, v) => {
    if (isPrim(v)) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (!isPrim(v[i])) bad(`${where}[${i}]`, 'must be a value');
    } else if (isObj(v))
      for (const [k, x] of Object.entries(v)) if (!isPrim(x)) bad(`${where}.${k}`, 'must be a value');
  };
  const labels = (where, v) => {
    if (v === undefined) return;
    const keys = Array.isArray(v) ? v.map((x) => String(x).split('=')[0]) : isObj(v) ? Object.keys(v) : null;
    if (!keys) return bad(where, 'must be a mapping or a list');
    prims(where, v);
    for (const k of keys)
      if (k.startsWith('com.docker.compose.')) bad(`${where}.${k}`, 'reserved Compose label');
  };

  if (
    !onlyKeys(
      'config',
      cfg,
      ['name', 'services', 'networks', 'volumes'].concat(
        Object.keys(cfg || {}).filter((k) => k.startsWith('x-')),
      ),
    )
  ) {
    return problems;
  }
  if (cfg.name !== project) bad('name', `must be ${project}`);

  const networks = isObj(cfg.networks) ? cfg.networks : {};
  if (cfg.networks !== undefined && !isObj(cfg.networks)) bad('networks', 'must be a mapping');
  for (const [k, n] of Object.entries(networks)) {
    const w = `networks.${k}`;
    if (!onlyKeys(w, n, ['name', 'ipam', 'driver', 'internal', 'labels', 'attachable', 'enable_ipv6']))
      continue;
    if (n.external !== undefined) bad(`${w}.external`, 'external networks are not allowed');
    if (n.name !== undefined && n.name !== `${project}_${k}`)
      bad(`${w}.name`, 'renamed networks are not allowed');
    if (n.driver !== undefined && n.driver !== 'bridge') bad(`${w}.driver`, 'only the default bridge driver');
    if (n.ipam !== undefined && !(isObj(n.ipam) && Object.keys(n.ipam).length === 0))
      bad(`${w}.ipam`, 'not allowed');
    labels(`${w}.labels`, n.labels);
  }

  const volumes = isObj(cfg.volumes) ? cfg.volumes : {};
  if (cfg.volumes !== undefined && !isObj(cfg.volumes)) bad('volumes', 'must be a mapping');
  for (const [k, v] of Object.entries(volumes)) {
    const w = `volumes.${k}`;
    if (v === null) continue;
    if (!onlyKeys(w, v, ['name', 'driver', 'labels'])) continue;
    if (v.name !== undefined && v.name !== `${project}_${k}`)
      bad(`${w}.name`, 'renamed volumes are not allowed');
    if (v.driver !== undefined && v.driver !== 'local') bad(`${w}.driver`, 'only the default driver');
    labels(`${w}.labels`, v.labels);
  }

  if (!isObj(cfg.services) || Object.keys(cfg.services).length === 0) bad('services', 'at least one service');
  const services = isObj(cfg.services) ? cfg.services : {};
  const SERVICE_KEYS = [
    'image',
    'build',
    'command',
    'entrypoint',
    'environment',
    'env_file',
    'ports',
    'expose',
    'volumes',
    'networks',
    'depends_on',
    'restart',
    'healthcheck',
    'labels',
    'user',
    'working_dir',
    'deploy',
    'tmpfs',
    'logging',
    'stop_signal',
    'stop_grace_period',
  ];
  for (const [name, s] of Object.entries(services)) {
    const w = `services.${name}`;
    if (!onlyKeys(w, s, SERVICE_KEYS)) continue;

    if (s.image !== undefined && typeof s.image !== 'string') bad(`${w}.image`, 'must be a string');
    if (s.build !== undefined) {
      const b = s.build;
      const allowed = [
        'context',
        'dockerfile',
        'dockerfile_inline',
        'args',
        'target',
        'labels',
        'pull',
        'no_cache',
        'network',
        'additional_contexts',
      ];
      if (onlyKeys(`${w}.build`, b, allowed)) {
        if (!isInside(b.context, root)) bad(`${w}.build.context`, 'must be inside the app folder');
        if (b.dockerfile !== undefined) {
          const df =
            typeof b.dockerfile === 'string' && path.resolve(String(b.context || root), b.dockerfile);
          if (!df || !isInside(df, root)) bad(`${w}.build.dockerfile`, 'must be inside the app folder');
        }
        if (b.additional_contexts !== undefined) {
          const ac = isObj(b.additional_contexts) ? b.additional_contexts : null;
          if (!ac) bad(`${w}.build.additional_contexts`, 'must be a mapping');
          else {
            for (const [k, v] of Object.entries(ac)) {
              const target =
                typeof v === 'string' &&
                !/^[a-z][a-z0-9+.-]*:/i.test(v) &&
                path.resolve(String(b.context || root), v);
              if (!target || !isInside(target, root))
                bad(`${w}.build.additional_contexts.${k}`, 'must be inside the app folder');
            }
          }
        }
        if (b.network !== undefined && !['default', 'none'].includes(b.network))
          bad(`${w}.build.network`, 'only default or none');
        if (b.args !== undefined) prims(`${w}.build.args`, b.args);
        labels(`${w}.build.labels`, b.labels);
        for (const k of ['target', 'dockerfile_inline'])
          if (b[k] !== undefined && typeof b[k] !== 'string') bad(`${w}.build.${k}`, 'must be a string');
        for (const k of ['pull', 'no_cache'])
          if (b[k] !== undefined && typeof b[k] !== 'boolean')
            bad(`${w}.build.${k}`, 'must be true or false');
      }
    }
    // [S1] Image names. A built image is exactly `<project>-<service>` (Compose's own default) and a built service name
    // has no `-`: then the last `-` splits app and service, so app `foo` can never produce or pull an image of app
    // `foo-bar` (or of any other guildwise stack), and a build can never retag another stack's image (postgres:16).
    if (typeof s.image === 'string') {
      const repo = imageRepo(s.image);
      if (s.build !== undefined) {
        if (repo !== `${project}-${name}`)
          bad(`${w}.image`, `a built image must be named ${project}-${name}`);
      } else if (repo.startsWith('guildwise-')) {
        const own = Object.entries(services).some(
          ([n, o]) => isObj(o) && o.build !== undefined && repo === `${project}-${n}` && !n.includes('-'),
        );
        if (!own) bad(`${w}.image`, `only this project's own built images (${project}-<built service>)`);
      }
    }
    if (s.build !== undefined && !/^[a-z0-9_.]+$/.test(name)) {
      bad(w, 'a service that builds needs a name of a-z, 0-9, _ and . (no -, so image names cannot collide)');
    }
    for (const k of ['command', 'entrypoint']) {
      const v = s[k];
      if (
        v !== undefined &&
        v !== null &&
        typeof v !== 'string' &&
        !(Array.isArray(v) && v.every((x) => typeof x === 'string'))
      ) {
        bad(`${w}.${k}`, 'must be a string or a list of strings');
      }
    }
    if (s.environment !== undefined) prims(`${w}.environment`, s.environment);
    if (s.env_file !== undefined) {
      for (const item of Array.isArray(s.env_file) ? s.env_file : [s.env_file]) {
        const p = isObj(item) ? item.path : item;
        if (isObj(item)) onlyKeys(`${w}.env_file`, item, ['path', 'required', 'format']);
        if (!isInside(typeof p === 'string' ? path.resolve(root, p) : null, root))
          bad(`${w}.env_file`, 'must be inside the app folder');
      }
    }
    if (s.ports !== undefined) {
      if (!Array.isArray(s.ports)) bad(`${w}.ports`, 'must be a list');
      else {
        s.ports.forEach((p, i) => {
          if (isObj(p)) {
            if (
              onlyKeys(`${w}.ports[${i}]`, p, [
                'mode',
                'target',
                'published',
                'protocol',
                'host_ip',
                'name',
                'app_protocol',
              ])
            )
              prims(`${w}.ports[${i}]`, p);
          } else if (!isPrim(p)) bad(`${w}.ports[${i}]`, 'must be a port');
        });
      }
    }
    if (s.expose !== undefined) prims(`${w}.expose`, s.expose);
    if (s.volumes !== undefined) {
      if (!Array.isArray(s.volumes)) bad(`${w}.volumes`, 'must be a list');
      else {
        s.volumes.forEach((m, i) => {
          const vw = `${w}.volumes[${i}]`;
          if (
            !onlyKeys(vw, m, [
              'type',
              'source',
              'target',
              'read_only',
              'bind',
              'volume',
              'tmpfs',
              'consistency',
            ])
          )
            return;
          if (typeof m.target !== 'string') bad(vw, 'needs a target');
          if (m.type === 'bind') {
            if (!isInside(m.source, root))
              bad(
                `${vw}.source`,
                `bind mounts must stay inside the app folder (${String(m.source).slice(0, 200)})`,
              );
            // [B2] A writable bind would let a container change the snapshot that later binds (and reuses) read.
            if (m.read_only !== true) {
              bad(
                `${vw}.read_only`,
                'binds into the app folder must be read-only (use a named volume for data)',
              );
            }
            if (m.bind !== undefined) onlyKeys(`${vw}.bind`, m.bind, ['create_host_path']);
            if (m.volume !== undefined || m.tmpfs !== undefined) bad(vw, 'mixed mount options');
          } else if (m.type === 'volume') {
            if (m.source !== undefined && m.source !== '' && !(m.source in volumes)) {
              bad(`${vw}.source`, 'only volumes declared in this project');
            }
            if (m.volume !== undefined) onlyKeys(`${vw}.volume`, m.volume, ['nocopy']);
            if (m.bind !== undefined || m.tmpfs !== undefined) bad(vw, 'mixed mount options');
          } else if (m.type === 'tmpfs') {
            if (m.source !== undefined) bad(`${vw}.source`, 'not allowed for tmpfs');
            if (m.tmpfs !== undefined && onlyKeys(`${vw}.tmpfs`, m.tmpfs, ['size', 'mode']))
              prims(`${vw}.tmpfs`, m.tmpfs);
            if (m.bind !== undefined || m.volume !== undefined) bad(vw, 'mixed mount options');
          } else bad(`${vw}.type`, 'only bind, volume or tmpfs');
          for (const k of ['read_only'])
            if (m[k] !== undefined && typeof m[k] !== 'boolean') bad(`${vw}.${k}`, 'must be true or false');
          if (m.consistency !== undefined && typeof m.consistency !== 'string')
            bad(`${vw}.consistency`, 'must be a string');
        });
      }
    }
    if (s.networks !== undefined) {
      const entries = Array.isArray(s.networks)
        ? s.networks.map((n) => [n, null])
        : isObj(s.networks)
          ? Object.entries(s.networks)
          : null;
      if (!entries) bad(`${w}.networks`, 'must be a mapping');
      else {
        for (const [n, opt] of entries) {
          if (!(n in networks)) bad(`${w}.networks.${n}`, 'only networks declared in this project');
          if (
            opt !== null &&
            onlyKeys(`${w}.networks.${n}`, opt, ['aliases', 'ipv4_address', 'ipv6_address', 'priority'])
          ) {
            for (const [k, v] of Object.entries(opt)) prims(`${w}.networks.${n}.${k}`, v);
          }
        }
      }
    }
    if (s.depends_on !== undefined) {
      const entries = Array.isArray(s.depends_on)
        ? s.depends_on.map((n) => [n, null])
        : isObj(s.depends_on)
          ? Object.entries(s.depends_on)
          : null;
      if (!entries) bad(`${w}.depends_on`, 'must be a mapping');
      else {
        for (const [n, opt] of entries) {
          if (!(n in services)) bad(`${w}.depends_on.${n}`, 'unknown service');
          if (opt !== null && onlyKeys(`${w}.depends_on.${n}`, opt, ['condition', 'required', 'restart']))
            prims(`${w}.depends_on.${n}`, opt);
        }
      }
    }
    if (
      s.restart !== undefined &&
      !/^(no|always|unless-stopped|on-failure(:\d+)?)$/.test(String(s.restart))
    ) {
      bad(`${w}.restart`, 'unknown restart policy');
    }
    if (
      s.healthcheck !== undefined &&
      onlyKeys(`${w}.healthcheck`, s.healthcheck, [
        'test',
        'interval',
        'timeout',
        'retries',
        'start_period',
        'start_interval',
        'disable',
      ])
    ) {
      for (const [k, v] of Object.entries(s.healthcheck)) prims(`${w}.healthcheck.${k}`, v);
    }
    labels(`${w}.labels`, s.labels);
    for (const k of ['user', 'working_dir', 'stop_signal', 'stop_grace_period']) {
      if (s[k] !== undefined && !isPrim(s[k])) bad(`${w}.${k}`, 'must be a value');
    }
    if (s.deploy !== undefined && onlyKeys(`${w}.deploy`, s.deploy, ['resources', 'placement'])) {
      const d = s.deploy;
      if (d.placement !== undefined && !(isObj(d.placement) && Object.keys(d.placement).length === 0)) {
        bad(`${w}.deploy.placement`, 'not allowed');
      }
      if (
        d.resources !== undefined &&
        onlyKeys(`${w}.deploy.resources`, d.resources, ['limits', 'reservations'])
      ) {
        for (const part of ['limits', 'reservations']) {
          const r = d.resources[part];
          if (r !== undefined && onlyKeys(`${w}.deploy.resources.${part}`, r, ['cpus', 'memory', 'pids'])) {
            prims(`${w}.deploy.resources.${part}`, r);
          }
        }
      }
    }
    if (
      s.tmpfs !== undefined &&
      !(
        typeof s.tmpfs === 'string' ||
        (Array.isArray(s.tmpfs) && s.tmpfs.every((x) => typeof x === 'string'))
      )
    ) {
      bad(`${w}.tmpfs`, 'must be a path or a list of paths');
    }
    if (s.logging !== undefined && onlyKeys(`${w}.logging`, s.logging, ['driver', 'options'])) {
      if (s.logging.driver !== undefined && !['json-file', 'local'].includes(s.logging.driver)) {
        bad(`${w}.logging.driver`, 'only json-file or local');
      }
      if (s.logging.options !== undefined) {
        if (!isObj(s.logging.options)) bad(`${w}.logging.options`, 'must be a mapping');
        else prims(`${w}.logging.options`, s.logging.options);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pin                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Canonical JSON (sorted keys) of the resolved config with every occurrence of the snapshot path replaced by $APP. */
function pinResolved(resolved, root) {
  const sub = (s) => s.split(root).join(PLACEHOLDER);
  const norm = (v) => {
    if (typeof v === 'string') return sub(v);
    if (Array.isArray(v)) return v.map(norm);
    if (isObj(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[sub(k)] = norm(v[k]);
      return out;
    }
    return v;
  };
  const pinned = norm(resolved);
  const text = JSON.stringify(pinned);
  return { pinned, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Docker                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The only environment docker ever sees: never the caller's DOCKER_HOST, DOCKER_CONFIG or COMPOSE_*. */
function cleanEnv(opts) {
  return {
    PATH: opts.path,
    HOME: opts.homeDir,
    LANG: 'C',
    // defence in depth next to the pre-scan: Compose must never fetch an include as root
    COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false',
    COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false',
  };
}

function runDocker(opts, args, { cwd, capture, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.dockerPath, args, {
      cwd,
      env: cleanEnv(opts),
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'],
    });
    let out = [];
    let outLen = 0;
    let err = '';
    let tooBig = false;
    if (capture) {
      child.stdout.on('data', (d) => {
        outLen += d.length;
        if (outLen > LIMITS.maxConfigBytes) {
          tooBig = true;
          child.kill('SIGKILL');
        } else out.push(d);
      });
    }
    child.stderr.on('data', (d) => {
      if (err.length < 16384) err += d.toString();
      if (!capture) process.stderr.write(d);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new DeployError(`cannot run docker: ${e.message}`, EXIT.DOCKER));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tooBig) return reject(refused('docker compose config printed more than the size limit'));
      if (code !== 0) {
        return reject(
          new DeployError(
            `docker ${args.slice(-3).join(' ')} failed (${code}): ${err.trim().slice(0, 4000)}`,
            EXIT.DOCKER,
          ),
        );
      }
      const text = capture ? Buffer.concat(out).toString('utf8') : '';
      out = [];
      resolve(text);
    });
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pipeline                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

function withDefaults(opts) {
  const o = { ...DEFAULTS, ...opts };
  o.dockerPath = findDocker(o);
  return o;
}

/**
 * Freeze, pre-scan, resolve, validate and pin `sourceDir` for `app`, under the app's lock. Shared by `deploy` and
 * guildwise-admin's approve-app. With `dropPrivileges` the options must carry `readerUid` and `readerGid` (the folder
 * owner the human approves; write them into the conf with formatAppConf). Returns
 * { project, snapshotDir, snapshotHash, appDir, resolved, pinned, hash }.
 */
async function prepare(app, sourceDir, options) {
  checkAppName(app);
  const opts = options.dockerPath ? options : withDefaults(options);
  const appDir = ensureAppDir(app, opts);
  const unlock = lockApp(appDir, app);
  try {
    return await prepareLocked(app, sourceDir, opts, appDir);
  } finally {
    unlock();
  }
}

async function prepareLocked(app, sourceDir, opts, appDir) {
  const project = `guildwise-${app}`;
  const snap = await freeze(sourceDir, appDir, opts);
  if (typeof opts.afterFreeze === 'function') await opts.afterFreeze(snap);
  const files = composeFiles(snap.dir);
  prescan(snap.dir, files);
  const args = ['compose', '--project-directory', snap.dir, '-p', project];
  for (const f of files) args.push('-f', f);
  args.push('config', '--format', 'json');
  const text = await runDocker(opts, args, { cwd: snap.dir, capture: true, timeoutMs: 120_000 });
  let resolved;
  try {
    resolved = JSON.parse(text);
  } catch {
    throw refused('docker compose config did not print JSON');
  }
  const problems = validateResolved(resolved, { root: snap.dir, project });
  if (problems.length) {
    throw refused(`the compose config is outside the allowlist:\n  - ${problems.join('\n  - ')}`, problems);
  }
  const { pinned, hash } = pinResolved(resolved, snap.dir);
  return { project, snapshotDir: snap.dir, snapshotHash: snap.hash, appDir, resolved, pinned, hash };
}

function lockApp(appDir, app) {
  const lock = path.join(appDir, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => fs.rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age < LIMITS.staleLockMs)
        throw new DeployError(`another deploy-compose run for ${app} is in progress`, EXIT.DOCKER);
      fs.rmSync(lock, { force: true });
    }
  }
  throw new DeployError(`cannot lock ${app}`, EXIT.DOCKER);
}

function pruneSnapshots(appDir, keep) {
  const snaps = fs
    .readdirSync(appDir)
    .filter((n) => HASH_RE.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(appDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of snaps.slice(keep)) {
    fs.rmSync(path.join(appDir, n), { recursive: true, force: true });
    fs.rmSync(path.join(appDir, `${n}.resolved.json`), { force: true });
  }
}

/**
 * The whole run for `deploy-compose <app> <action>`. `options` overrides the root paths (tests only; the CLI always
 * uses DEFAULTS). Returns the prepared result (and for resolve, whether it matches the approval).
 */
async function deploy(app, action, options = {}) {
  checkAppName(app);
  if (!ACTIONS.has(action))
    throw new DeployError(`unknown action ${JSON.stringify(action)}: up, pull, down or resolve`, EXIT.USAGE);
  const conf = readAppConf(app, withDefaults(options));
  // [B1] the reader identity comes only from the root-owned approval, never from the caller or the path
  const opts = withDefaults({ ...options, readerUid: conf.owner, readerGid: conf.group });
  const appDir = ensureAppDir(app, opts);
  const unlock = lockApp(appDir, app);
  try {
    const p = await prepareLocked(app, conf.source, opts, appDir);
    const approved = conf.hash !== '' && p.hash === conf.hash;
    if (action === 'resolve') return { ...p, approvedHash: conf.hash, approved };
    if (!approved) {
      throw new DeployError(
        `the compose config of ${app} changed since it was approved (now ${p.hash.slice(0, 12)}, approved ${conf.hash.slice(0, 12) || 'none'}): ` +
          `run ${opts.adminCommand} approve-app ${app}`,
        EXIT.HELD,
      );
    }
    const resolvedFile = path.join(appDir, `${p.snapshotHash}.resolved.json`);
    fs.rmSync(resolvedFile, { force: true });
    fs.writeFileSync(resolvedFile, `${JSON.stringify(p.resolved, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // [B3] Compose interpolates the resolved file again when it runs it: what it will run must resolve to the same
    // checked, approved config, or nothing runs.
    const againText = await runDocker(
      opts,
      [
        'compose',
        '--project-directory',
        p.snapshotDir,
        '-p',
        p.project,
        '-f',
        resolvedFile,
        'config',
        '--format',
        'json',
      ],
      { cwd: p.snapshotDir, capture: true, timeoutMs: 120_000 },
    );
    let again;
    try {
      again = JSON.parse(againText);
    } catch {
      throw refused('the resolved file did not resolve to JSON');
    }
    const againProblems = validateResolved(again, { root: p.snapshotDir, project: p.project });
    if (againProblems.length || pinResolved(again, p.snapshotDir).hash !== p.hash) {
      throw refused(
        `the resolved file does not resolve to the approved config${againProblems.length ? `:\n  - ${againProblems.join('\n  - ')}` : ''}`,
        againProblems.length ? againProblems : undefined,
      );
    }
    const verb = { up: ['up', '-d', '--build'], pull: ['pull'], down: ['down'] }[action];
    const args = [
      'compose',
      '--project-directory',
      p.snapshotDir,
      '-p',
      p.project,
      '-f',
      resolvedFile,
      ...verb,
    ];
    await runDocker(opts, args, { cwd: p.snapshotDir, capture: false, timeoutMs: 60 * 60 * 1000 });
    pruneSnapshots(appDir, LIMITS.keepSnapshots);
    return { ...p, approvedHash: conf.hash, approved, resolvedFile };
  } finally {
    unlock();
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* CLI                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

async function main(argv) {
  if (argv[0] === '--reader') {
    // The unprivileged half of the freeze. Never as root: it would read root-only files for the caller.
    if (typeof process.getuid !== 'function' || process.getuid() === 0 || process.geteuid() === 0) {
      process.stderr.write('deploy-compose: the reader never runs as root\n');
      return EXIT.ENV;
    }
    return runReader(argv[1], process.stdout);
  }
  try {
    if (argv.length !== 2)
      throw new DeployError('usage: deploy-compose <app> up|pull|down|resolve', EXIT.USAGE);
    preflight(DEFAULTS);
    const [app, action] = argv;
    checkAppName(app);
    if (!ACTIONS.has(action))
      throw new DeployError('usage: deploy-compose <app> up|pull|down|resolve', EXIT.USAGE);
    const result = await deploy(app, action, {
      rootUid: 0,
      dropPrivileges: true,
      homeDir: os.userInfo().homedir,
      readerCommand: [process.execPath, __filename],
    });
    if (action === 'resolve') {
      const { project, hash, approvedHash, approved, pinned } = result;
      process.stdout.write(
        `${JSON.stringify({ app, project, hash, approvedHash, approved, config: pinned }, null, 2)}\n`,
      );
    }
    return EXIT.OK;
  } catch (err) {
    if (err instanceof DeployError) {
      process.stderr.write(`deploy-compose: ${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`deploy-compose: unexpected error: ${err?.message}\n`);
    return EXIT.DOCKER;
  }
}

module.exports = {
  DEFAULTS,
  LIMITS,
  EXIT,
  PLACEHOLDER,
  DeployError,
  checkAppName,
  parseAppConf,
  formatAppConf,
  readAppConf,
  runReader,
  receiveTree,
  freeze,
  parseYaml,
  unsafeRelPath,
  composeFiles,
  prescan,
  validateResolved,
  pinResolved,
  hashTree,
  preflight,
  cleanEnv,
  prepare,
  deploy,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT.DOCKER;
    },
  );
}
