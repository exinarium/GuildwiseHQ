import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { forbiddenReadPath } from '../read-repos.ts';
import { redact } from '../secrets/redact.ts';
import { compareVersions, describeDotnet, selectDotnet } from './dotnet.ts';

/**
 * Agent toolchains (docs/RUNNER.md "Agent toolchains"): tools installed on this workstation that sandboxed agents may
 * use. An entry is a set of directories (bin dirs go on PATH and are readable, read dirs are only readable) plus a few
 * environment variables. Sources: `detected` (cheap directory reads of the usual user-space managers), `config`
 * (`toolchainPaths`, `dotnetRoot` in config.json) and `devops` (the DevOps engineer registers a tool it installed with
 * `aom toolchain add`; persisted in `toolchains.json`). Nothing here spawns a process.
 */
export type ToolchainSource = 'detected' | 'devops' | 'config';

export interface ToolchainEntry {
  name: string;
  binDirs: string[];
  readDirs: string[];
  env: Record<string, string>;
  source: ToolchainSource;
  /** What is installed, when cheap to know (`8.0.425, 10.0.401`). */
  version?: string;
  addedBy?: 'devops' | 'owner';
  addedAt?: string;
}

export class ToolchainError extends Error {}

const MAX_DIRS = 8;
const MAX_ENV = 16;
const NAME_RE = /^[a-z0-9][a-z0-9._+-]{0,39}$/i;

/** Variables a toolchain may set although their name looks like a credential or a tool setting. */
export const ENV_ALLOW = new Set([
  'DOTNET_ROOT',
  'DOTNET_ROOT_X64',
  'DOTNET_ROOT_ARM64',
  'JAVA_HOME',
  'GOROOT',
  'GOPATH',
  'GOBIN',
  'GRADLE_HOME',
  'MAVEN_HOME',
  'M2_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_NDK_HOME',
  'RUSTUP_HOME',
  'CARGO_HOME',
  'PYENV_ROOT',
  'NVM_DIR',
  'SDKMAN_DIR',
  'MISE_DATA_DIR',
  'ASDF_DIR',
  'ASDF_DATA_DIR',
  'FLUTTER_ROOT',
  'DENO_INSTALL',
  'BUN_INSTALL',
  'PNPM_HOME',
  'VOLTA_HOME',
]);
const SECRETISH = /TOKEN|SECRET|PASSW|PASSPHRASE|KEY|CREDENTIAL|AUTH|COOKIE|SESSION/i;
/** Shapes of credentials that must never travel in a toolchain variable, whatever its name. */
const SECRET_VALUE =
  /\b(sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.)|-----BEGIN [A-Z ]*PRIVATE KEY|:\/\/[^\s/:@]+:[^\s/@]+@|^Bearer\s/i;
/** Never settable by a toolchain: process control, the runner's own variables, the sandbox identity. */
const RESERVED =
  /^(PATH|HOME|USERPROFILE|TMP|TMPDIR|TEMP|SHELL|USER|LOGNAME|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PERL5LIB|RUBYLIB|LD_.*|DYLD_.*|AOM_.*|CLAUDE.*|ANTHROPIC.*|GIT_.*|NPM_CONFIG_.*|npm_config_.*|NUGET_.*|DOTNET_CLI_HOME)$/;

/** Throws `ToolchainError` when the variable may not be set by a toolchain. */
export function checkEnvVar(key: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key))
    throw new ToolchainError(`"${key}" is not a valid variable name`);
  if (RESERVED.test(key))
    throw new ToolchainError(`${key} is managed by the runner and cannot be set by a toolchain`);
  if (value.length > 1000 || /[\r\n\0]/.test(value))
    throw new ToolchainError(`the value of ${key} must be one line of at most 1000 characters`);
  if (!ENV_ALLOW.has(key) && SECRETISH.test(key))
    throw new ToolchainError(
      `${key} looks like a credential: toolchains may only set paths and tool settings`,
    );
  if (redact(value) !== value || SECRET_VALUE.test(value))
    throw new ToolchainError(
      `the value of ${key} looks like a secret: toolchains may only set paths and tool settings`,
    );
}

export interface ToolchainInput {
  name: string;
  bin?: string[];
  read?: string[];
  env?: Record<string, string>;
}

export interface ValidateContext {
  runnerRoot: string;
  home: string;
}

const expand = (p: string, home: string): string => (p.startsWith('~') ? join(home, p.slice(1)) : p);

function realDir(raw: string, what: string, c: ValidateContext): string {
  const p = expand(raw.trim(), c.home);
  if (!isAbsolute(p)) throw new ToolchainError(`${what} "${raw}" must be an absolute path`);
  let real: string;
  try {
    real = realpathSync(p);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ToolchainError(`${what} "${raw}" does not exist or is not a directory`);
  }
  if (forbiddenReadPath(real, c.runnerRoot, c.home))
    throw new ToolchainError(
      `${what} "${raw}" is not allowed: it is the root, the home folder (or a parent of it), the runner's data folder or a credential store`,
    );
  return real;
}

function hasExecutable(dir: string): boolean {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      try {
        const p = join(dir, e.name);
        if (!statSync(p).isFile()) continue;
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        /* dangling link or not executable */
      }
    }
  } catch {
    /* unreadable */
  }
  return false;
}

/** Validates what `aom toolchain add` sent; returns the entry with real paths. Throws `ToolchainError` with the reason. */
export function validateToolchain(
  input: ToolchainInput,
  source: ToolchainSource,
  c: ValidateContext,
): ToolchainEntry {
  const name = (input.name ?? '').trim();
  if (!NAME_RE.test(name))
    throw new ToolchainError(
      'the name is 1-40 letters, digits, dots, dashes or underscores (for example "go-1.23")',
    );
  const bin = input.bin ?? [];
  const read = input.read ?? [];
  if (!bin.length && !read.length) throw new ToolchainError('give at least one --bin or --read directory');
  if (bin.length > MAX_DIRS || read.length > MAX_DIRS)
    throw new ToolchainError(`at most ${MAX_DIRS} directories`);
  const binDirs = [...new Set(bin.map((b) => realDir(b, 'bin directory', c)))];
  for (const b of binDirs)
    if (!hasExecutable(b)) throw new ToolchainError(`bin directory "${b}" contains no executable file`);
  const readDirs = [...new Set(read.map((r) => realDir(r, 'read directory', c)))];
  const entries = Object.entries(input.env ?? {});
  if (entries.length > MAX_ENV) throw new ToolchainError(`at most ${MAX_ENV} variables`);
  for (const [k, v] of entries) checkEnvVar(k, v);
  return { name, binDirs, readDirs, env: Object.fromEntries(entries), source };
}

// ------------------------------------------------------------------------------------------------ detection

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const subdirs = (p: string): string[] => {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
};
const highest = (names: string[]): string | undefined =>
  [...names].sort((a, b) => compareVersions(a.replace(/^\D+/, ''), b.replace(/^\D+/, ''))).at(-1);
const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf8').trim().slice(0, 200);
  } catch {
    return '';
  }
};

export interface DetectOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** `dotnetRoot` of config.json. */
  dotnetRoot?: string;
  /** Test hook: see `DotnetDetectOptions.systemRoots`. */
  systemRoots?: string[];
}

/** The usual user-space installs of tools, by directory reads only. */
export function detectToolchains(o: DetectOptions): ToolchainEntry[] {
  const { home } = o;
  const platform = o.platform ?? process.platform;
  if (platform === 'win32') return [];
  const out: ToolchainEntry[] = [];
  const add = (e: Omit<ToolchainEntry, 'source'>, source: ToolchainSource = 'detected') => {
    const binDirs = e.binDirs.filter(isDir);
    const readDirs = e.readDirs.filter(isDir);
    if (binDirs.length || (readDirs.length && e.name === 'dotnet'))
      out.push({ ...e, binDirs, readDirs, source });
  };

  // .NET: one root that holds every SDK (the muxer resolves SDKs only inside its own root)
  const dn = selectDotnet({
    home,
    platform,
    ...(o.env ? { env: o.env } : {}),
    ...(o.systemRoots ? { systemRoots: o.systemRoots } : {}),
    ...(o.dotnetRoot ? { override: o.dotnetRoot } : {}),
  });
  if (dn.chosen)
    add(
      {
        name: 'dotnet',
        binDirs: [dn.chosen.root],
        readDirs: [dn.chosen.root],
        env: { DOTNET_ROOT: dn.chosen.root },
        version: describeDotnet(dn.chosen, home),
      },
      dn.reason === 'config' ? 'config' : 'detected',
    );

  // Node via nvm: the default alias, else the newest installed
  const nvm = join(home, '.nvm', 'versions', 'node');
  if (isDir(nvm)) {
    const alias = readText(join(home, '.nvm', 'alias', 'default')).replace(/^v/, '');
    const names = subdirs(nvm);
    const pick =
      names.find((n) => alias && (n === `v${alias}` || n.startsWith(`v${alias}.`))) ?? highest(names);
    if (pick)
      add({
        name: 'node-nvm',
        binDirs: [join(nvm, pick, 'bin')],
        readDirs: [join(nvm, pick)],
        env: {},
        version: pick.replace(/^v/, ''),
      });
  }

  // Python: pyenv shims, uv-managed interpreters
  if (isDir(join(home, '.pyenv', 'shims')))
    add({
      name: 'python-pyenv',
      binDirs: [join(home, '.pyenv', 'shims'), join(home, '.pyenv', 'bin')],
      readDirs: [join(home, '.pyenv')],
      env: {},
      version: readText(join(home, '.pyenv', 'version')).split('\n')[0] || undefined,
    } as Omit<ToolchainEntry, 'source'>);
  const uvPy = join(home, '.local', 'share', 'uv', 'python');
  if (isDir(uvPy)) {
    const pick = highest(subdirs(uvPy).filter((n) => /\d/.test(n)));
    if (pick)
      add({
        name: 'python-uv',
        binDirs: [join(uvPy, pick, 'bin')],
        readDirs: [join(uvPy, pick)],
        env: {},
        version: pick.split('-')[1] ?? pick,
      });
  }

  // Go: the official tarball or a version manager (~/go/sdk/go1.x)
  const goSdk = join(home, 'go', 'sdk');
  const goRoots = [
    '/usr/local/go',
    ...subdirs(goSdk)
      .filter((n) => /^go\d/.test(n))
      .sort((a, b) => compareVersions(b.slice(2), a.slice(2)))
      .map((n) => join(goSdk, n)),
  ].filter((r) => isDir(join(r, 'bin')));
  if (goRoots[0])
    add({
      name: 'go',
      binDirs: [join(goRoots[0], 'bin')],
      readDirs: [goRoots[0]],
      env: { GOROOT: goRoots[0] },
      version: readText(join(goRoots[0], 'VERSION')).split('\n')[0]?.replace(/^go/, '') || undefined,
    } as Omit<ToolchainEntry, 'source'>);

  // Rust: the proxies in ~/.cargo/bin only (the cargo home holds credentials), plus the read-only toolchains they start
  if (isDir(join(home, '.cargo', 'bin')))
    add({
      name: 'rust',
      binDirs: [join(home, '.cargo', 'bin')],
      readDirs: [join(home, '.rustup', 'toolchains')],
      env: isDir(join(home, '.rustup')) ? { RUSTUP_HOME: join(home, '.rustup') } : {},
    });

  // Java, Gradle, Maven via sdkman (the `current` links)
  const sdkman = join(home, '.sdkman', 'candidates');
  for (const [cand, label] of [
    ['java', 'java'],
    ['gradle', 'gradle'],
    ['maven', 'maven'],
  ] as const) {
    const cur = join(sdkman, cand, 'current');
    if (isDir(join(cur, 'bin'))) {
      let real = cur;
      try {
        real = realpathSync(cur);
      } catch {
        /* keep the link */
      }
      add({
        name: `${label}-sdkman`,
        binDirs: [join(cur, 'bin')],
        readDirs: [join(sdkman, cand)],
        env: cand === 'java' ? { JAVA_HOME: cur } : {},
        version: real.split('/').at(-1),
      });
    }
  }

  // mise / asdf shims, user-level binaries
  const mise = join(home, '.local', 'share', 'mise');
  if (isDir(join(mise, 'shims')))
    add({ name: 'mise', binDirs: [join(mise, 'shims')], readDirs: [mise], env: {} });
  if (isDir(join(home, '.asdf', 'shims')))
    add({ name: 'asdf', binDirs: [join(home, '.asdf', 'shims')], readDirs: [join(home, '.asdf')], env: {} });
  if (isDir(join(home, '.local', 'bin')))
    add({ name: 'local-bin', binDirs: [join(home, '.local', 'bin')], readDirs: [], env: {} });
  return out;
}

// -------------------------------------------------------------------------------------------------- registry

export interface ToolchainConfig {
  toolchainPaths: string[];
  dotnetRoot?: string;
}

export interface ResolvedToolchains {
  entries: ToolchainEntry[];
  /** Directories for the front of PATH (existing only, stable order: devops/config before detected). */
  pathDirs: string[];
  /** Read access for the sandbox: bin dirs, read dirs and the configured toolchainPaths. */
  readDirs: string[];
  /** Merged variables (the first entry that sets one wins). */
  env: Record<string, string>;
}

export class ToolchainRegistry {
  /** Called after a registration or removal (the runner reports the new list to the server). */
  onChange?: () => void;

  constructor(
    private readonly file: string,
    private readonly runnerRoot: string,
    private readonly cfg: () => ToolchainConfig = () => ({ toolchainPaths: [] }),
    private readonly home: string = homedir(),
    private readonly platform: NodeJS.Platform = process.platform,
    /** Test hook: environment and system locations the detection looks at. */
    private readonly detect: Pick<DetectOptions, 'env' | 'systemRoots'> = {},
  ) {}

  private ctx(): ValidateContext {
    return { runnerRoot: this.runnerRoot, home: this.home };
  }

  /** Entries the DevOps engineer or the owner registered. */
  persisted(): ToolchainEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { toolchains?: unknown };
      const list = Array.isArray(raw.toolchains) ? raw.toolchains : [];
      const out: ToolchainEntry[] = [];
      for (const e of list as ToolchainEntry[]) {
        // re-validate on every load: a file edited by hand must not open the home folder or a credential store
        try {
          const v = validateToolchain(
            { name: e.name, bin: e.binDirs, read: e.readDirs, env: e.env },
            'devops',
            this.ctx(),
          );
          out.push({
            ...v,
            ...(e.addedBy ? { addedBy: e.addedBy } : {}),
            ...(e.addedAt ? { addedAt: e.addedAt } : {}),
          });
        } catch {
          /* gone or no longer allowed: skipped */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private save(list: ToolchainEntry[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ toolchains: list }, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* not supported everywhere */
    }
    renameSync(tmp, this.file);
  }

  /** Registers (or replaces) a toolchain. Throws `ToolchainError`. */
  add(input: ToolchainInput, by: 'devops' | 'owner' = 'devops', now: Date = new Date()): ToolchainEntry {
    const entry = {
      ...validateToolchain(input, 'devops', this.ctx()),
      addedBy: by,
      addedAt: now.toISOString(),
    };
    const list = this.persisted().filter((e) => e.name !== entry.name);
    list.push(entry);
    this.save(list);
    this.onChange?.();
    return entry;
  }

  remove(name: string): boolean {
    const list = this.persisted();
    const next = list.filter((e) => e.name !== name);
    if (next.length === list.length) return false;
    this.save(next);
    this.onChange?.();
    return true;
  }

  /** Config `toolchainPaths` as entries (read access only, as before). */
  private configured(): ToolchainEntry[] {
    return this.cfg().toolchainPaths.flatMap((raw) => {
      const p = resolve(expand(raw, this.home));
      return forbiddenReadPath(p, this.runnerRoot, this.home) || !existsSync(p)
        ? []
        : [{ name: `path:${raw}`, binDirs: [], readDirs: [p], env: {}, source: 'config' as const }];
    });
  }

  /** Every entry in stable order: devops, config, detected (a detected entry yields to a registered one of the same name). */
  list(): ToolchainEntry[] {
    const devops = this.persisted();
    const detected = detectToolchains({
      home: this.home,
      platform: this.platform,
      ...this.detect,
      ...(this.cfg().dotnetRoot ? { dotnetRoot: this.cfg().dotnetRoot as string } : {}),
    }).filter((d) => !devops.some((e) => e.name === d.name));
    return [...devops, ...this.configured(), ...detected];
  }

  resolve(): ResolvedToolchains {
    const entries = this.list();
    const pathDirs: string[] = [];
    const readDirs: string[] = [];
    const env: Record<string, string> = {};
    for (const e of entries) {
      for (const b of e.binDirs) if (existsSync(b) && !pathDirs.includes(b)) pathDirs.push(b);
      for (const r of [...e.binDirs, ...e.readDirs]) if (!readDirs.includes(r)) readDirs.push(r);
      for (const [k, v] of Object.entries(e.env)) {
        try {
          checkEnvVar(k, v);
        } catch {
          continue;
        }
        if (!(k in env)) env[k] = v;
      }
    }
    return { entries, pathDirs, readDirs, env };
  }
}

/** `PATH` for an agent: the runner's own bin first (the `aom` shim), then the toolchains, then the rest. */
export function agentPath(
  tc: Pick<ResolvedToolchains, 'pathDirs'>,
  runnerBin: string,
  base = process.env.PATH ?? '',
): string {
  const seen = new Set<string>();
  return [runnerBin, ...tc.pathDirs, ...base.split(delimiter)]
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(delimiter);
}

const shorten = (p: string, home: string) =>
  p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;

/** Short list for the agent instructions: `dotnet 8.0.425, 10.0.401; node-nvm 22.1.0; go 1.23.1`. */
export function describeToolchains(entries: ToolchainEntry[]): string {
  return entries
    .filter((e) => e.binDirs.length)
    .map((e) => (e.version ? `${e.name} ${e.version.replace(/ \(.*\)$/, '')}` : e.name))
    .join('; ');
}

/** One line per entry for `aom toolchain list`. */
export function formatToolchainList(entries: ToolchainEntry[], home: string = homedir()): string {
  if (!entries.length) return 'No toolchains registered or detected.';
  return entries
    .map(
      (e) =>
        `${e.name}  [${e.source}]${e.version ? `  ${e.version.replace(/ \(.*\)$/, '')}` : ''}  ${[...e.binDirs, ...e.readDirs].map((d) => shorten(d, home)).join(', ')}${Object.keys(e.env).length ? `  env: ${Object.keys(e.env).join(',')}` : ''}${e.addedAt ? `  added ${e.addedAt.slice(0, 10)}${e.addedBy === 'devops' ? ' by DevOps' : ''}` : ''}`,
    )
    .join('\n');
}

/** The instruction line for sandboxed agents (appended by the supervisor). */
export const toolchainNote = (available: string): string =>
  `Toolchains available to you: ${available || 'none registered'}. If a tool is missing, do not install it yourself: ask DevOps (\`aom devops\`) to install it and register it with \`aom toolchain add\`.`;

/** `aom toolchain list|add|remove` over the IPC: anyone may list, only the DevOps engineer changes the list. */
export function toolchainRpc(
  registry: ToolchainRegistry | undefined,
  method: string,
  params: Record<string, unknown>,
  isDevops: boolean,
): { ok: true; result: unknown } | { ok: false; error: string } {
  if (!registry) return { ok: false, error: 'toolchains are not available on this runner' };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  try {
    if (method === 'toolchain.list')
      return { ok: true, result: { text: formatToolchainList(registry.list()) } };
    if (!isDevops) return { ok: false, error: 'only the DevOps engineer can add or remove toolchains' };
    if (method === 'toolchain.add') {
      const env =
        params.env && typeof params.env === 'object'
          ? Object.fromEntries(
              Object.entries(params.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            )
          : {};
      const e = registry.add(
        { name: String(params.name ?? ''), bin: strings(params.bin), read: strings(params.read), env },
        'devops',
      );
      return {
        ok: true,
        result: {
          message: `Registered "${e.name}". New shifts and chats of the agents get it on PATH and can read it.`,
        },
      };
    }
    if (method === 'toolchain.remove') {
      const name = String(params.name ?? '');
      return registry.remove(name)
        ? { ok: true, result: { message: `Removed "${name}".` } }
        : { ok: false, error: `no registered toolchain "${name}" (detected ones cannot be removed)` };
    }
  } catch (err) {
    if (err instanceof ToolchainError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: false, error: `${method} is not available` };
}
