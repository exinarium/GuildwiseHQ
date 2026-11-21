import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { type IpcRpcResponse, parseYamlLimited } from '@aom/shared';
import { allowScriptsHint } from '../policy/installs.ts';
import { maskedPaths, SERVICE_HOME, sandboxCommand } from '../runs/sandbox.ts';
import { startEgressProxy } from '../sandbox/egress-proxy.ts';
import { cacheEnv, ensureSharedCaches } from '../sandbox/sandbox.ts';
import { BREW_BIN_DIRS, type Executor, userBinDirs } from '../toolchain/exec.ts';

/**
 * A project package install for a card's worktree, run by the DevOps side of the runner (owner 2026-11-21: "Devops is
 * supposed to install dependencies"). With the credential scrub on, an agent's own Bash cannot write `package.json`, the
 * lockfiles or `node_modules/.bin` (Claude Code 2.1.330), so `aom devops install ...` asks for it: the runner, which is not
 * scrubbed, runs the package manager in that worktree under the local policy (R18-S): only the script-free modes, unless
 * the workstation owner allowed install scripts for the repository (`guildwise-runner repo allow-scripts <url>`).
 */

/** The IPC method of `aom devops install`. */
export const DEVOPS_INSTALL_RPC = 'devops.install';

export const DEPENDENCY_TOOLS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type DependencyTool = (typeof DEPENDENCY_TOOLS)[number];
export const DEPENDENCY_ACTIONS = ['install', 'add', 'remove'] as const;
export type DependencyAction = (typeof DEPENDENCY_ACTIONS)[number];

export interface DependencyChange {
  tool: DependencyTool;
  action: DependencyAction;
  packages: string[];
  dev?: boolean;
}

/** A registry package and an optional version range: no git, file, link or URL specs (they can bring code the plan cannot vet). */
const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9.^~<>=*|+ -]{1,60})?$/i;

/** What an agent's `aom devops install` sends; null and a reason when it is not one of the accepted forms. */
export function parseDependencyChange(
  p: Record<string, unknown>,
): { ok: true; change: DependencyChange } | { ok: false; reason: string } {
  const tool = p.tool;
  const action = p.action;
  if (typeof tool !== 'string' || !(DEPENDENCY_TOOLS as readonly string[]).includes(tool))
    return { ok: false, reason: `the package manager must be one of ${DEPENDENCY_TOOLS.join(', ')}` };
  if (typeof action !== 'string' || !(DEPENDENCY_ACTIONS as readonly string[]).includes(action))
    return { ok: false, reason: `the action must be one of ${DEPENDENCY_ACTIONS.join(', ')}` };
  const packages = Array.isArray(p.packages)
    ? p.packages.filter((x): x is string => typeof x === 'string')
    : [];
  if (action === 'install' && packages.length)
    return { ok: false, reason: '`install` takes no package names: use `add` to add a dependency' };
  if (action !== 'install' && !packages.length)
    return { ok: false, reason: `\`${action}\` needs package names` };
  if (packages.length > 20) return { ok: false, reason: 'at most 20 packages per request' };
  const bad = packages.find((x) => !PACKAGE_SPEC.test(x));
  if (bad)
    return {
      ok: false,
      reason: `"${bad.slice(0, 80)}" is not a registry package name (name or name@range); git, file and URL dependencies are not installed this way`,
    };
  return {
    ok: true,
    change: {
      tool: tool as DependencyTool,
      action: action as DependencyAction,
      packages,
      dev: p.dev === true,
    },
  };
}

const NO_PM_SWITCH: Record<string, string> = {
  COREPACK_ENABLE_STRICT: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
  npm_config_manage_package_manager_versions: 'false',
};

/** The command for a change in `dir`: script-free flags forced on unless the repository may run install scripts. */
export function planDependencyChange(
  c: DependencyChange,
  dir: string,
  repo: string,
  scriptsAllowed: boolean,
): { ok: true; cmd: string; args: string[]; env: Record<string, string> } | { ok: false; reason: string } {
  const dev = c.dev === true;
  const verb: Record<DependencyTool, Record<DependencyAction, string[]>> = {
    npm: { install: ['install'], add: ['install', ...(dev ? ['--save-dev'] : [])], remove: ['uninstall'] },
    pnpm: { install: ['install'], add: ['add', ...(dev ? ['--save-dev'] : [])], remove: ['remove'] },
    yarn: { install: ['install'], add: ['add', ...(dev ? ['--dev'] : [])], remove: ['remove'] },
    bun: { install: ['install'], add: ['add', ...(dev ? ['--dev'] : [])], remove: ['remove'] },
  };
  const args = [...verb[c.tool][c.action], ...c.packages];
  if (scriptsAllowed) return { ok: true, cmd: c.tool, args, env: {} };
  const berry = c.tool === 'yarn' && existsSync(join(dir, '.yarnrc.yml'));
  if (berry) {
    let plugins = false;
    try {
      plugins = /^\s*plugins\s*:/m.test(readFileSync(join(dir, '.yarnrc.yml'), 'utf8'));
    } catch {}
    if (plugins)
      return {
        ok: false,
        reason: `.yarnrc.yml loads Yarn plugins (repository code): ${allowScriptsHint(repo)}`,
      };
  }
  const flags: Record<DependencyTool, string[]> = {
    // `--git=git`: a project `.npmrc` `git=<path>` would run that program even with --ignore-scripts
    npm: ['--ignore-scripts', '--git=git'],
    pnpm: ['--ignore-scripts', '--ignore-pnpmfile', '--config.manage-package-manager-versions=false'],
    yarn: berry ? ['--mode=skip-build'] : ['--ignore-scripts'],
    bun: ['--ignore-scripts'],
  };
  return {
    ok: true,
    cmd: c.tool,
    args: [...args, ...flags[c.tool]],
    env: { ...NO_PM_SWITCH, ...(c.tool === 'yarn' ? { YARN_IGNORE_PATH: '1' } : {}) },
  };
}

const tail = (s: string, n = 1500) => (s.length > n ? `...${s.slice(-n)}` : s);

// ---------------------------------------------------------------- what the workspace may install (registry only)

/** The registries an install may reach without a local allowance (policy.json `installRegistries` adds hosts). */
export const DEFAULT_REGISTRY_HOSTS = ['registry.npmjs.org', 'registry.yarnpkg.com'] as const;

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', '.yarn']);

/** The files an install reads that decide what it fetches: copied to the stage, scanned there, installed from there. */
export const MANIFEST_FILES = new Set(['package.json', 'pnpm-workspace.yaml']);
export const LOCK_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
]);
export const CONFIG_FILES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml']);
const STAGED = new Set([...MANIFEST_FILES, ...LOCK_FILES, ...CONFIG_FILES, 'bun.lockb']);

/** A version a registry serves: a range or dist-tag, `npm:<name>@<range>`, or a workspace/catalog reference. */
export function isRegistrySpec(spec: string): boolean {
  const v = spec.trim();
  if (v === '' || v === '*' || v === 'latest') return true;
  if (/^(workspace|catalog):[\w.^~<>=*|+ -]*$/.test(v)) return true;
  if (v.startsWith('npm:')) return PACKAGE_SPEC.test(v.slice(4));
  return /^[\w.^~<>=*|+ -]{1,80}$/.test(v);
}

/** The relative paths of the staged files under `dir` (regular files only; symlinks and node_modules left out). */
export function stagedFiles(dir: string, max = 2000, maxDirs = 20000): string[] {
  const out: string[] = [];
  let dirs = 0;
  const walk = (rel: string, depth: number) => {
    if (out.length >= max || depth > 8 || ++dirs > maxDirs) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(r, depth + 1);
      else if (e.isFile() && STAGED.has(e.name)) out.push(r);
    }
  };
  walk('', 0);
  return out;
}

/** All string values of a (nested) object. */
const leaves = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : v && typeof v === 'object'
      ? Object.values(v as Record<string, unknown>).flatMap(leaves)
      : [];

const BAD_LOCK =
  /(git\+[a-z]+:|git:\/\/|git@[\w.-]+:|\b(github|gitlab|bitbucket):|\bfile:|\blink:\/|\bpatch:|codeload\.github\.com)/i;
/** Every scheme-and-authority-looking token, backslashes and userinfo included, so `new URL` decides what its host is. */
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,{}()[\]]+/gi;

/**
 * Whether a URL found in a lockfile or registry setting goes to an allowed registry, parsed exactly as Node does (WHATWG
 * `new URL`): https only, no userinfo, no backslash, the hostname in the allowed set. `https://evil.com\@registry.npmjs.org`
 * is evil.com to Node, so it is refused.
 */
export function registryUrlProblem(raw: string, hosts: ReadonlySet<string>): string | null {
  if (raw.includes('\\')) return 'a URL has a backslash';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'a URL does not parse';
  }
  if (u.protocol !== 'https:') return 'a URL is not https';
  if (u.username || u.password) return 'a URL carries a user or password';
  if (!hosts.has(u.hostname.toLowerCase())) return 'a URL goes to a host that is not an allowed registry';
  return null;
}

/** Proxy and TLS keys of the package managers' config files: they redirect or weaken the install's network. */
const NPMRC_NET =
  /^\s*(proxy|https-proxy|http-proxy|noproxy|no-proxy|strict-ssl|ca|cafile|cert|key|certfile|keyfile|local-address|maxsockets)\s*=/im;
const YARN1_NET = /^\s*"?(proxy|https-proxy|http-proxy|strict-ssl|ca|cafile)"?\s/im;
const YARNRC_YML_NET =
  /^\s*(httpProxy|httpsProxy|enableStrictSsl|caFilePath|httpsCaFilePath|httpsCertFilePath|httpsKeyFilePath|unsafeHttpWhitelist)\s*:/m;
const BUNFIG_NET = /^\s*(ca|cafile|proxy|https_proxy|http_proxy)\s*=/im;

/** The proxy and TLS keys a config file sets (names only, never values). */
export function networkConfigKeys(name: string, text: string): string[] {
  const re =
    name === '.npmrc'
      ? NPMRC_NET
      : name === '.yarnrc'
        ? YARN1_NET
        : name === '.yarnrc.yml'
          ? YARNRC_YML_NET
          : BUNFIG_NET;
  const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  return [...new Set([...text.matchAll(g)].map((m) => (m[1] as string).toLowerCase()))];
}

/**
 * Refuses an install over a workspace that names anything but registry packages: every package.json (dependencies,
 * overrides, resolutions, packageExtensions, pnpm.overrides, pnpm.packageExtensions, pnpm.patchedDependencies), every
 * pnpm-workspace.yaml (overrides, catalog, catalogs, packageExtensions, patchedDependencies), .yarnrc.yml packageExtensions,
 * the lockfiles (git, file, patch, absolute link entries, any URL not to an allowed registry) and the registry settings
 * (.npmrc, .yarnrc, .yarnrc.yml, bunfig.toml, pnpm-workspace.yaml). Bun's binary `bun.lockb` is refused (it cannot be read
 * reliably). Returns the reasons, empty when fine. `dir` is the stage the install runs from.
 */
export function scanWorkspace(
  dir: string,
  allowedHosts: readonly string[] = [],
  allowNetworkConfig = false,
): string[] {
  const hosts = new Set([...DEFAULT_REGISTRY_HOSTS, ...allowedHosts].map((h) => h.toLowerCase()));
  const problems: string[] = [];
  const specs = (where: string, v: unknown) => {
    for (const spec of leaves(v))
      if (!isRegistrySpec(spec) && !spec.startsWith('$'))
        problems.push(`${where} names something that is not a registry package`);
  };
  const urls = (where: string, text: string) => {
    for (const m of text.matchAll(URL_TOKEN)) {
      const p = registryUrlProblem(m[0], hosts);
      if (p) problems.push(`${where}: ${p}`);
    }
  };
  for (const rel of stagedFiles(dir)) {
    const name = basename(rel);
    let text: string;
    try {
      text = readFileSync(join(dir, rel), name === 'bun.lockb' ? 'latin1' : 'utf8');
    } catch {
      problems.push(`${rel} cannot be read`);
      continue;
    }
    if (name === 'bun.lockb') {
      problems.push(
        `${rel} is a binary Bun lockfile, which is not checked: switch to the text lockfile (bun install --save-text-lockfile, then remove bun.lockb)`,
      );
      continue;
    }
    if (name === 'package.json') {
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        problems.push(`${rel} is not valid JSON`);
        continue;
      }
      for (const field of DEP_FIELDS) {
        const deps = pkg[field];
        if (!deps || typeof deps !== 'object') continue;
        for (const [n, spec] of Object.entries(deps as Record<string, unknown>))
          if (typeof spec !== 'string' || !isRegistrySpec(spec))
            problems.push(`${rel} ${field}: an entry is not a registry package`);
      }
      const pnpm = (pkg.pnpm ?? {}) as Record<string, unknown>;
      specs(`${rel} overrides`, pkg.overrides);
      specs(`${rel} resolutions`, pkg.resolutions);
      specs(`${rel} packageExtensions`, pkg.packageExtensions);
      specs(`${rel} pnpm.overrides`, pnpm.overrides);
      specs(`${rel} pnpm.packageExtensions`, pnpm.packageExtensions);
      if (pnpm.patchedDependencies && Object.keys(pnpm.patchedDependencies as object).length)
        problems.push(`${rel} pnpm.patchedDependencies: patched dependencies are not installed this way`);
      continue;
    }
    if (name === 'pnpm-workspace.yaml' || name === '.yarnrc.yml') {
      let doc: Record<string, unknown> = {};
      try {
        doc = (parseYamlLimited(text, 20) ?? {}) as Record<string, unknown>;
      } catch {
        problems.push(`${rel} is not valid YAML`);
        continue;
      }
      if (name === 'pnpm-workspace.yaml') {
        specs(`${rel} overrides`, doc.overrides);
        specs(`${rel} catalog`, doc.catalog);
        specs(`${rel} catalogs`, doc.catalogs);
        if (doc.patchedDependencies && Object.keys(doc.patchedDependencies as object).length)
          problems.push(`${rel} patchedDependencies: patched dependencies are not installed this way`);
      }
      specs(`${rel} packageExtensions`, doc.packageExtensions);
      if (name === '.yarnrc.yml') {
        const keys = networkConfigKeys(name, text);
        if (keys.length && !allowNetworkConfig)
          problems.push(
            `${rel} sets ${keys.join(', ')} (proxy or TLS): not allowed unless policy.json installNetworkConfig is on`,
          );
      }
      urls(rel, text);
      continue;
    }
    if (CONFIG_FILES.has(name) || name === '.yarnrc.yml') {
      const keys = networkConfigKeys(name, text);
      if (keys.length && !allowNetworkConfig)
        problems.push(
          `${rel} sets ${keys.join(', ')} (proxy or TLS): not allowed unless policy.json installNetworkConfig is on`,
        );
    }
    if (LOCK_FILES.has(name)) {
      const bad = BAD_LOCK.exec(text);
      if (bad) problems.push(`${rel} has a non-registry dependency (git, file, link or patch)`);
    }
    urls(rel, text);
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------- where and with what it runs

const PASS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

/**
 * The whole environment of the install (nothing else is inherited): PATH, the sandbox HOME, temp, this worktree's own
 * package caches, locale and CA settings, the egress proxy (the only way out of the box), git without system or global
 * config, and the plan's package-manager switches. No token, no SSH agent, no git credential helper, no AOM_ or cloud
 * variable, no proxy of the runner's own.
 */
export function installEnv(o: {
  path: string;
  cacheRoot: string;
  parent: NodeJS.ProcessEnv;
  extra: Record<string, string>;
  proxyPort?: number;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASS) {
    const v = o.parent[k];
    if (v) out[k] = v;
  }
  const cache = cacheEnv(o.cacheRoot);
  const proxy = o.proxyPort ? `http://127.0.0.1:${o.proxyPort}` : undefined;
  Object.assign(out, {
    PATH: o.path,
    HOME: SERVICE_HOME,
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: `${SERVICE_HOME}/.cache`,
    XDG_CONFIG_HOME: `${SERVICE_HOME}/.config`,
    npm_config_cache: cache.npm_config_cache,
    npm_config_store_dir: cache.npm_config_store_dir,
    pnpm_config_store_dir: cache.pnpm_config_store_dir,
    YARN_CACHE_FOLDER: cache.YARN_CACHE_FOLDER,
    BUN_INSTALL_CACHE_DIR: join(o.cacheRoot, 'bun'),
    COREPACK_HOME: join(o.cacheRoot, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_update_notifier: 'false',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...(proxy
      ? {
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          NO_PROXY: '',
          no_proxy: '',
          npm_config_proxy: proxy,
          npm_config_https_proxy: proxy,
          YARN_HTTP_PROXY: proxy,
          YARN_HTTPS_PROXY: proxy,
          NODE_USE_ENV_PROXY: '1',
        }
      : {}),
    ...o.extra,
  });
  return out;
}

/** `<data dir>/install-cache`: the install caches, inside the runner's data dir, which every agent sandbox hides. */
export const installCacheRoot = (paths: { root: string }): string => join(paths.root, 'install-cache');

/** The file in each install cache naming the worktree it belongs to (for the sweep). */
export const CACHE_OWNER_FILE = 'worktree';

/** `<root>/<sha256(worktree)[:16]>`: the install cache of one worktree. */
export const installCacheDir = (root: string, worktree: string): string =>
  join(root, createHash('sha256').update(resolve(worktree)).digest('hex').slice(0, 16));

/** A cache younger than this is never swept for a missing owner file: another install may be creating it right now. */
export const CACHE_SWEEP_GRACE_MS = 10 * 60_000;

/**
 * Removes the install caches whose worktree is gone, and old caches that name none. A cache without an owner file that is
 * younger than `CACHE_SWEEP_GRACE_MS` is left alone (its install may not have written the file yet). Returns how many.
 */
export async function sweepInstallCaches(
  root: string,
  exists: (p: string) => boolean = existsSync,
  now: number = Date.now(),
): Promise<number> {
  let n = 0;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    const dir = join(root, name);
    let owner = '';
    try {
      owner = readFileSync(join(dir, CACHE_OWNER_FILE), 'utf8').trim();
    } catch {}
    if (owner && installCacheDir(root, owner) === dir && exists(owner)) continue;
    if (!owner) {
      try {
        if (now - statSync(dir).mtimeMs < CACHE_SWEEP_GRACE_MS) continue;
      } catch {
        continue;
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    n++;
  }
  return n;
}

/** One install per worktree at a time. */
const running = new Set<string>();

/** What an install may leave behind besides the staged files: Yarn PnP state (node_modules go back per package folder). */
const PNP_OUTPUTS = ['.pnp.cjs', '.pnp.loader.mjs', join('.yarn', 'install-state.gz')];

/** Folders never re-opened read-only in the install box, however a tool is installed: too broad. */
const BROAD = [
  '',
  '.local',
  join('.local', 'share'),
  join('.local', 'state'),
  '.config',
  '.cache',
  '.npm',
  '.yarn',
];

/**
 * The paths re-opened read-only inside the box (the real home is hidden): exactly the package manager (its single file,
 * or for a JavaScript one its package folder) and the Node install it needs. Never the home, a broad folder, or an
 * ancestor of a path that stays masked.
 */
export function exactReopens(o: {
  toolPath: string | null;
  nodeExec: string;
  realHome: string;
  masked: string[];
}): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (BROAD.some((b) => resolve(o.realHome, b) === p)) return;
    if (o.masked.some((m) => m === p || m.startsWith(`${p}${sep}`))) return;
    if (!out.includes(p)) out.push(p);
  };
  // the Node install: <root>/bin/node
  try {
    add(dirname(dirname(realpathSync(o.nodeExec))));
  } catch {}
  if (o.toolPath) {
    try {
      const real = realpathSync(o.toolPath);
      if (/\.(c|m)?js$/.test(real)) {
        // a JavaScript package manager: its package folder (the nearest one with a package.json)
        let d = dirname(real);
        while (d !== dirname(d) && !existsSync(join(d, 'package.json'))) d = dirname(d);
        if (d !== dirname(d)) add(d);
      } else add(real); // a native binary or script: the file alone
    } catch {}
  }
  return out;
}

/** Finds `cmd` on `path` (no shell): the first executable file. */
function whichOn(cmd: string, path: string): string | null {
  for (const d of path.split(delimiter)) {
    if (!d) continue;
    const f = join(d, cmd);
    try {
      if (statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

/**
 * A box with nothing but the system binaries and the given folders: the staging copies run here, so a symlink the shift
 * plants resolves inside this view (the worktree, the stage, /usr) and never reaches a secret. No network, no /proc.
 */
export function stagingBoxArgs(binds: Array<{ host: string; at: string; write: boolean }>): string[] {
  const args = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--tmpfs',
    '/tmp',
  ];
  for (const d of ['/bin', '/sbin', '/lib', '/lib64', '/lib32']) {
    try {
      const st = lstatSync(d);
      if (st.isSymbolicLink()) args.push('--symlink', readlinkSync(d), d);
      else if (st.isDirectory()) args.push('--ro-bind', d, d);
    } catch {}
  }
  for (const b of binds) args.push(b.write ? '--bind' : '--ro-bind', b.host, b.at);
  return args;
}

/** The names find(1) looks for (the STAGED set). */
const FIND_NAMES = [...STAGED].map((n) => `-name '${n}'`).join(' -o ');

/**
 * Inside the staging box: list the staged files of the worktree (/w) with find (no symlink is followed, one file system,
 * depth and count bounded), then copy each into the stage (/s) and the pristine copy (/o). A path whose real path leaves
 * /w, or that is not a regular file when it is copied, ends the box with exit 3.
 */
const COPY_IN = `set -e
cd /w
find . -maxdepth 9 -xdev \\( -name node_modules -o -name .git -o -name .pnpm-store -o -name .yarn \\) -prune -o -type f \\( ${FIND_NAMES} \\) -print0 | head -z -n 2000 > /tmp/list
while IFS= read -r -d '' rel; do
  rel=\${rel#./}
  r=$(realpath -e -- "/w/$rel") || exit 3
  case "$r" in /w/*) ;; *) exit 3 ;; esac
  [ -f "$r" ] || exit 3
  mkdir -p -- "$(dirname -- "/s/$rel")" "$(dirname -- "/o/$rel")"
  cat -- "$r" > "/s/$rel"
  cat -- "/s/$rel" > "/o/$rel"
done < /tmp/list`;

/**
 * Inside the copy-back box, in two passes: first every target is checked (a folder whose real path leaves /w ends the box
 * before anything is written), then the files the install changed (stage /s against the pristine /o) are written through a
 * temp file and a rename, and each package folder's node_modules is built beside the old one and swapped in with renames
 * (the old one is restored if the swap fails). Arguments: `f <rel>` for a file, `m <dir>` for a node_modules folder.
 */
const COPY_BACK = `set -e
inside() { case "$1/" in /w/*) return 0 ;; *) return 1 ;; esac; }
changed() { [ -f "/s/$1" ] && [ ! -L "/s/$1" ] && ! { [ -f "/o/$1" ] && cmp -s -- "/s/$1" "/o/$1"; }; }
check() {
  while [ "$#" -gt 1 ]; do
    kind=$1; rel=$2; shift 2
    if [ "$kind" = f ]; then
      changed "$rel" || continue
      d=$(dirname -- "/w/$rel")
      while [ ! -e "$d" ] && [ ! -L "$d" ]; do d=$(dirname -- "$d"); done
      rd=$(realpath -e -- "$d") || exit 3
      inside "$rd" || exit 3
    else
      [ -d "/s/$rel/node_modules" ] && [ ! -L "/s/$rel/node_modules" ] || continue
      rd=$(realpath -e -- "/w/$rel") || exit 3
      inside "$rd" || exit 3
    fi
  done
}
write() {
  while [ "$#" -gt 1 ]; do
    kind=$1; rel=$2; shift 2
    if [ "$kind" = f ]; then
      changed "$rel" || continue
      d=$(dirname -- "/w/$rel")
      mkdir -p -- "$d"
      rd=$(realpath -e -- "$d") || exit 3
      inside "$rd" || exit 3
      t="$rd/.aom-install-$$"
      cat -- "/s/$rel" > "$t"
      mv -f -- "$t" "$rd/$(basename -- "$rel")"
    else
      s="/s/$rel/node_modules"
      [ -d "$s" ] && [ ! -L "$s" ] || continue
      rd=$(realpath -e -- "/w/$rel") || exit 3
      inside "$rd" || exit 3
      new="$rd/node_modules.aom-new-$$"; old="$rd/node_modules.aom-old-$$"
      rm -rf -- "$new"
      cp -a -- "$s" "$new"
      if [ -e "$rd/node_modules" ] || [ -L "$rd/node_modules" ]; then mv -- "$rd/node_modules" "$old"; fi
      if mv -- "$new" "$rd/node_modules"; then rm -rf -- "$old"; else
        if [ -e "$old" ]; then mv -- "$old" "$rd/node_modules"; fi
        exit 3
      fi
    fi
  done
}
check "$@"
write "$@"`;

/**
 * Runs the change for the worktree and answers the agent's request:
 * 1. staging, in a box that sees only the worktree (read-only) and the stage: the files that decide what is fetched are
 *    copied there (symlinks resolve inside that view only; a path that leaves the worktree refuses the install);
 * 2. the scan, on the stage (out of every agent's reach);
 * 3. the package manager, in the stage, in the runner's bubblewrap profile with its own network namespace: the only way out
 *    is the runner's egress proxy, which lets a CONNECT through to the allowed registry hosts on 443 and nothing else; the
 *    real home and the runner's data dir hidden (only the package manager and the Node install re-opened, exactly); this
 *    worktree's own package caches; `installEnv` as the whole environment;
 * 4. copy-back, in a box that sees only the worktree, the stage and the pristine copy.
 */
export async function runDependencyChange(o: {
  dir: string;
  repo: string;
  change: DependencyChange;
  exec: Executor;
  scriptsAllowed: boolean;
  allowedRegistries?: readonly string[];
  allowNetworkConfig?: boolean;
  runnerRoot: string;
  realHome: string;
  /**
   * Root of the install caches, under the runner's data dir and outside every agent sandbox (`<data dir>/install-cache`):
   * each worktree gets `<cacheRoot>/<hash>` (no cache shared across worktrees, none an agent can write).
   */
  cacheRoot: string;
  /** Under the runner's data dir (out of every agent's reach): the stage and the private /tmp live here. */
  tmpRoot: string;
  parentEnv?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Test hook: start the egress proxy (default `startEgressProxy`). */
  startProxy?: typeof startEgressProxy;
}): Promise<IpcRpcResponse> {
  const plan = planDependencyChange(o.change, o.dir, o.repo, o.scriptsAllowed);
  if (!plan.ok) return { ok: false, error: `DevOps did not run it: ${plan.reason}` };
  const key = resolve(o.dir);
  if (running.has(key))
    return {
      ok: false,
      error: 'DevOps did not run it: another install is running in this worktree; ask again when it ends',
    };
  running.add(key);
  // caches of worktrees that are gone go first (cheap: one listing of the cache root)
  await sweepInstallCaches(o.cacheRoot).catch(() => 0);
  const line = `${plan.cmd} ${plan.args.join(' ')}`;
  const refuse = (why: string): IpcRpcResponse => ({ ok: false, error: `DevOps did not run it: ${why}` });
  let work: string | undefined;
  let proxy: { close(): Promise<void> } | undefined;
  try {
    await mkdir(o.tmpRoot, { recursive: true, mode: 0o700 });
    work = await mkdtemp(join(o.tmpRoot, 'aom-install-'));
    const stage = join(work, 'stage');
    const orig = join(work, 'orig');
    const runTmp = join(work, 'tmp');
    await mkdir(stage);
    await mkdir(orig);
    await mkdir(join(runTmp, 'home'), { recursive: true, mode: 0o700 });
    const boxEnv = { PATH: '/usr/bin:/bin', LANG: 'C' };
    // 1. staging, boxed: the worktree is listed and copied inside the box (nothing of it is read by the runner)
    const copyIn = await o.exec.run(
      'bwrap',
      [
        ...stagingBoxArgs([
          { host: o.dir, at: '/w', write: false },
          { host: stage, at: '/s', write: true },
          { host: orig, at: '/o', write: true },
        ]),
        '--',
        'bash',
        '-c',
        COPY_IN,
      ],
      { cwd: '/', env: boxEnv, exactEnv: true, timeoutMs: 120_000 },
    );
    if (copyIn.exitCode !== 0)
      return refuse(
        copyIn.exitCode === 127 && /bwrap/.test(copyIn.stderr)
          ? 'the bubblewrap sandbox is not available on this workstation'
          : 'a manifest, lockfile or registry setting is not a regular file inside the worktree (a symlink out of it, or it changed while it was copied)',
      );
    const files = stagedFiles(stage);
    if (!files.includes('package.json')) return refuse('the worktree has no package.json at its root');
    // 2. the scan, on the stage
    const problems = scanWorkspace(stage, o.allowedRegistries ?? [], o.allowNetworkConfig === true);
    if (problems.length)
      return refuse(
        `only registry packages are installed this way.\n- ${problems.slice(0, 10).join('\n- ')}`,
      );
    // 3. the install, boxed, its network only through the egress proxy
    const cacheDir = installCacheDir(o.cacheRoot, key);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    // the owner file is written atomically (temp + rename), so a sweep never reads half of it
    const ownerTmp = join(cacheDir, `.${CACHE_OWNER_FILE}.${process.pid}.tmp`);
    await writeFile(ownerTmp, `${key}\n`, { mode: 0o600 });
    await rename(ownerTmp, join(cacheDir, CACHE_OWNER_FILE));
    await ensureSharedCaches(cacheDir);
    await mkdir(join(cacheDir, 'bun'), { recursive: true });
    await mkdir(join(cacheDir, 'corepack'), { recursive: true });
    const parent = o.parentEnv ?? process.env;
    const searchPath = [...userBinDirs(o.realHome), ...(parent.PATH ?? '').split(delimiter), ...BREW_BIN_DIRS]
      .filter((x, i, a) => x && a.indexOf(x) === i)
      .join(delimiter);
    const toolPath = whichOn(plan.cmd, searchPath);
    if (!toolPath) return refuse(`${plan.cmd} is not installed on this workstation`);
    const spec = {
      runnerRoot: o.runnerRoot,
      realHome: o.realHome,
      worktrees: [stage],
      cacheRoot: cacheDir,
      runTmp,
      userSecrets: false,
      network: 'none' as const,
      dieWithParent: true,
      extraMasked: [o.realHome],
    };
    const masked = maskedPaths(spec);
    const readOnly = exactReopens({ toolPath, nodeExec: process.execPath, realHome: o.realHome, masked });
    const nodeBin = join(dirname(dirname(realpathSync(process.execPath))), 'bin');
    const boxPath = [nodeBin, '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
    const socketPath = join(runTmp, 'egress.sock');
    proxy = await (o.startProxy ?? startEgressProxy)({
      socketPath,
      allowedHosts: [...DEFAULT_REGISTRY_HOSTS, ...(o.allowedRegistries ?? [])],
      allowedPorts: [443],
      // a private or LAN registry is reachable only when the owner listed it (installRegistries), on 443
      privateEndpoints: (o.allowedRegistries ?? []).map((h) => `${h}:443`),
    });
    const port = 18080;
    const env = installEnv({ path: boxPath, cacheRoot: cacheDir, parent, extra: plan.env, proxyPort: port });
    const real = realpathSync(toolPath);
    const argv = /\.(c|m)?js$/.test(real)
      ? [join(nodeBin, 'node'), real, ...plan.args]
      : [real, ...plan.args];
    // the bridge: 127.0.0.1:<port> in the box -> the proxy's Unix socket (/tmp is the box's private /tmp = runTmp)
    const bridge = `socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/tmp/egress.sock >/dev/null 2>&1 & sleep 0.2; exec "$@"`;
    const c = sandboxCommand({ ...spec, readOnly }, ['sh', '-c', bridge, 'sh', ...argv]);
    o.log?.(`devops install for ${o.dir} (staged, sandboxed: bwrap, egress: registries only): ${line}`);
    const r = await o.exec.run(c.cmd, c.args, { cwd: stage, timeoutMs: 15 * 60_000, env, exactEnv: true });
    if (r.exitCode === 127 && /bwrap/.test(r.stderr))
      return refuse('the bubblewrap sandbox is not available on this workstation');
    if (r.exitCode !== 0)
      return {
        ok: false,
        error: `DevOps ran \`${line}\` for your worktree and it failed (exit ${r.exitCode}):\n${tail(r.stderr || r.stdout)}`,
      };
    // 4. copy-back, boxed
    const back: string[] = [];
    for (const rel of new Set([...stagedFiles(stage), ...PNP_OUTPUTS])) back.push('f', rel);
    for (const f of files.filter((x) => basename(x) === 'package.json')) back.push('m', dirname(f));
    const copyBack = await o.exec.run(
      'bwrap',
      [
        ...stagingBoxArgs([
          { host: o.dir, at: '/w', write: true },
          { host: stage, at: '/s', write: false },
          { host: orig, at: '/o', write: false },
        ]),
        '--',
        'sh',
        '-c',
        COPY_BACK,
        'sh',
        ...back,
      ],
      { cwd: '/', env: boxEnv, exactEnv: true, timeoutMs: 15 * 60_000 },
    );
    if (copyBack.exitCode !== 0)
      return {
        ok: false,
        error: `DevOps ran \`${line}\`, but the result could not be put back into your worktree (a folder there points out of it)`,
      };
    return {
      ok: true,
      result: {
        message: `DevOps ran \`${line}\` for your worktree: done. package.json and the lockfile are updated there; carry on (commit them with your change).`,
        command: line,
      },
    };
  } finally {
    running.delete(key);
    await proxy?.close().catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
