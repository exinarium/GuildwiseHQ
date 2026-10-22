import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type DeployProbePayload,
  type DeployProbeResult,
  isGuildwiseTemporaryOverride,
  type ProbeBackups,
  type ProbeComposeFile,
  type ProbeComposeService,
  type ProbeContainer,
  type ProbeError,
  type ProbeReport,
  ProbeReportSchema,
  type ProbeService,
  type ProbeSshHost,
  parseYamlLimited,
} from '@aom/shared';
import { execa } from 'execa';
import type { DeployKeys } from './deploy-keys.ts';
import { userSshArgs } from './deploy-keys.ts';
import { REMOTE_PROBE_SCRIPT, SERVICES_PROBE_SCRIPT } from './probe-remote.ts';

/**
 * `deploy.probe`: fixed, read-only questions about Docker on this computer or on a server (docs/design/deploy-run-ux-design.md
 * section 6). No model, no free-form command: every command line is built here from constants and from values that passed a
 * strict character set. Results are names and shapes. Compose files are reduced to structure (`environment:` values are never
 * kept), `.env` files to key names, private keys and `known_hosts` are never opened by this code (only `ssh` itself reads them).
 *
 * SSH safety (section 6.4): `StrictHostKeyChecking=yes` against the user's own `known_hosts`, `BatchMode=yes` (never a prompt),
 * a changed host key is a hard stop with no override, and `~/.ssh/config` is only READ (for host aliases).
 */

export interface ProbeOptions {
  home?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Whole probe budget (default 60 s) and one command (default 10 s). */
  totalMs?: number;
  commandMs?: number;
  /** ssh connect timeout in seconds (tests use 2). */
  connectSec?: number;
  /** This computer's dedicated deploy keys: a target that has one is reached with it (`ssh -F`), not with the person's own ssh. */
  keys?: DeployKeys;
  /** The person's ssh config, named explicitly (default `<home>/.ssh/config`). */
  userSshConfig?: string;
  /** Where hinted folders on a server may be (default /opt and /srv; tests use a temp folder). */
  hintRoots?: string[];
}

const SAFE_PATH = /^\/[A-Za-z0-9._/+@=-]*$/;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Hints are looked at, not trusted: a compose file by its name, a folder only where apps live. */
const COMPOSE_NAME = /(^|\/)(docker-compose|compose)(\.[A-Za-z0-9_-]+)?\.ya?ml$/;
const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
/** A folder the person typed or a hint named: under where apps live (and a user's home on a server), never a hidden folder. */
const serverHintDir = (d: string, roots: readonly string[] = ['/opt', '/srv', '/home']) =>
  roots.some((r) => under(d, r)) && !d.split('/').some((c) => c.startsWith('.'));
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_COMPOSE_BYTES = 1_000_000;

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
}

export async function run(
  cmd: string,
  args: string[],
  o: { timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv; raw?: boolean },
): Promise<Ran> {
  const r = await execa(cmd, args, {
    reject: false,
    timeout: o.timeoutMs,
    ...(o.input !== undefined ? { input: o.input } : { stdin: 'ignore' as const }),
    env: o.env ?? process.env,
    maxBuffer: 4_000_000,
    all: false,
    // a file copied through this computer has to arrive byte for byte, its last newline included
    ...(o.raw ? { stripFinalNewline: false } : {}),
  });
  const err = r as unknown as { code?: string; timedOut?: boolean; exitCode?: number };
  return {
    code: typeof r.exitCode === 'number' ? r.exitCode : null,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    missing: err.code === 'ENOENT',
    timedOut: err.timedOut === true,
  };
}

// ---------------------------------------------------------------------------------------------- parsing helpers

/** `0.0.0.0:4700->4600/tcp, [::]:4700->4600/tcp, 5432/tcp` */
export function parsePorts(s: string): ProbeContainer['ports'] {
  const out: ProbeContainer['ports'] = [];
  const seen = new Set<string>();
  for (const part of s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m = /^(?:(.*):)?(\d+)->(\d+)\/\w+$/.exec(part);
    const plain = /^(\d+)\/\w+$/.exec(part);
    const item = m
      ? {
          host: Number(m[2]),
          container: Number(m[3]),
          ...(m[1] ? { bind: m[1].replace(/^\[|\]$/g, '') } : {}),
        }
      : plain
        ? { host: null, container: Number(plain[1]) }
        : null;
    if (!item) continue;
    const k = `${item.host}:${item.container}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out.slice(0, 20);
}

/** Where Guildwise itself writes the new version of the app next to the compose file. */
const GUILDWISE_OVERRIDE = 'docker-compose.guildwise.yml';

/**
 * Why a stack cannot be restarted by Guildwise yet, from the labels `docker compose` wrote: several compose files (the override
 * files Guildwise writes itself do not count: the one next to the compose file and the temporary ones of a local deploy or rollback), an --env-file, or a project folder other than the one of the compose file.
 */
export function unsupportedStack(
  configFiles: string,
  workingDir: string,
  envFile: string,
): string | undefined {
  const files = configFiles
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const own = files.filter(
    (f) => f.split('/').pop() !== GUILDWISE_OVERRIDE && !isGuildwiseTemporaryOverride(f),
  );
  if (own.length > 1) return 'It was started from several compose files. This is not supported yet.';
  if (envFile.trim()) return 'It was started with its own --env-file. This is not supported yet.';
  const first = own[0];
  if (first && workingDir && (first.slice(0, first.lastIndexOf('/')) || '/') !== workingDir)
    return 'It was started with another project folder (--project-directory). This is not supported yet.';
  return undefined;
}

/** One `CONTAINER\tname\timage\tstate\tstatus\tports\tproject\tservice\tconfig_files\tworking_dir\tenvironment_file` line. */
export function parseContainerLine(line: string): ProbeContainer | null {
  const f = line.replace(/^CONTAINER\t/, '').split('\t');
  if (f.length < 4 || !f[0]) return null;
  const configFile = (f[7] ?? '').split(',')[0]?.trim();
  const unsupported = unsupportedStack(f[7] ?? '', f[8] ?? '', f[9] ?? '');
  return {
    name: (f[0] ?? '').slice(0, 200),
    image: (f[1] ?? '').slice(0, 200),
    state: (f[2] ?? '').slice(0, 40),
    ...(f[3] ? { status: f[3].slice(0, 100) } : {}),
    ports: parsePorts(f[4] ?? ''),
    ...(f[5] ? { project: f[5].slice(0, 200) } : {}),
    ...(f[6] ? { service: f[6].slice(0, 200) } : {}),
    ...(configFile ? { composeFile: configFile.slice(0, 300) } : {}),
    ...(f[8] ? { workingDir: f[8].slice(0, 300) } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}

/** A compose file inherits the "not supported yet" reason of a running stack that was started from it. */
export function markUnsupportedStacks(report: ProbeReport): void {
  for (const cf of report.composeFiles) {
    const c = report.containers.find((x) => x.unsupported && x.composeFile === cf.path);
    if (c?.unsupported) cf.unsupported = c.unsupported;
  }
}

const DB_IMAGES: Array<[RegExp, NonNullable<ProbeComposeService['database']>]> = [
  [/postgres|timescale|pgvector/i, 'postgres'],
  [/mysql|mariadb/i, 'mysql'],
  [/mongo/i, 'mongo'],
  [/redis|valkey/i, 'redis'],
];

const varsIn = (v: unknown): string[] => {
  const out = new Set<string>();
  const text = JSON.stringify(v ?? null);
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1] as string);
  return [...out].slice(0, 40);
};

/**
 * A compose file reduced to its structure: service names, `image:`, `build:` context, published ports, named volumes,
 * `env_file` paths and the NAMES of `${VARS}`. Nothing under `environment:` survives. Never throws.
 */
export function parseComposeStructure(path: string, text: string, project?: string): ProbeComposeFile {
  const base = { path: path.slice(0, 300), ...(project ? { project } : {}) };
  if (Buffer.byteLength(text) > MAX_COMPOSE_BYTES)
    return { ...base, services: [], volumes: [], unreadable: 'the file is too big to read' };
  let doc: unknown;
  try {
    doc = parseYamlLimited(text, 50);
  } catch {
    return { ...base, services: [], volumes: [], unreadable: 'not valid YAML' };
  }
  if (!doc || typeof doc !== 'object')
    return { ...base, services: [], volumes: [], unreadable: 'not a compose file' };
  const d = doc as Record<string, unknown>;
  const services: ProbeComposeService[] = [];
  const svcs = d.services && typeof d.services === 'object' ? (d.services as Record<string, unknown>) : {};
  for (const [name, raw] of Object.entries(svcs).slice(0, 40)) {
    const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const image = typeof s.image === 'string' ? s.image : undefined;
    const build =
      typeof s.build === 'string'
        ? s.build
        : s.build &&
            typeof s.build === 'object' &&
            typeof (s.build as { context?: unknown }).context === 'string'
          ? ((s.build as { context: string }).context as string)
          : undefined;
    const ports = (Array.isArray(s.ports) ? s.ports : [])
      .map((p) =>
        typeof p === 'string' || typeof p === 'number'
          ? String(p)
          : p && typeof p === 'object'
            ? `${(p as { published?: unknown }).published ?? ''}:${(p as { target?: unknown }).target ?? ''}`
            : '',
      )
      .filter(Boolean)
      .slice(0, 20);
    const volumes = (Array.isArray(s.volumes) ? s.volumes : [])
      .map((v) => {
        const src =
          typeof v === 'string'
            ? v.split(':')[0]
            : v && typeof v === 'object'
              ? (v as { source?: unknown }).source
              : '';
        return typeof src === 'string' && src && !/^[./~$]/.test(src) ? src : '';
      })
      .filter(Boolean)
      .slice(0, 20);
    const ef = s.env_file;
    const envFiles = (Array.isArray(ef) ? ef : ef ? [ef] : [])
      .map((e) =>
        typeof e === 'string' ? e : e && typeof e === 'object' ? (e as { path?: unknown }).path : '',
      )
      .filter((e): e is string => typeof e === 'string' && !!e)
      .slice(0, 10);
    const { environment: _env, ...withoutEnv } = s;
    void _env;
    const database = image ? DB_IMAGES.find(([re]) => re.test(image))?.[1] : undefined;
    services.push({
      name: name.slice(0, 200),
      ...(image ? { image: image.slice(0, 200) } : {}),
      ...(build ? { build: build.slice(0, 300) } : {}),
      ports,
      volumes,
      envFiles,
      // only the NAMES of ${VARS}, from the whole service including environment values (the values themselves are dropped)
      vars: [...new Set([...varsIn(withoutEnv), ...varsIn(s.environment)])].slice(0, 40),
      ...(database ? { database } : {}),
    });
  }
  const vols = d.volumes && typeof d.volumes === 'object' ? Object.keys(d.volumes as object) : [];
  const nameKey = typeof d.name === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(d.name) ? d.name : undefined;
  return {
    ...base,
    ...(!project && nameKey ? { project: nameKey } : {}),
    services,
    volumes: vols.slice(0, 40).map((v) => v.slice(0, 200)),
  };
}

// ------------------------------------------------------------------------------- apps that run without Docker

/** A command line shortened for display: a few words, nothing that looks like a value, a password or an address with a login. */
export function safeCommand(cmd: string): string | undefined {
  const out: string[] = [];
  let skipNext = false;
  for (const t of cmd.trim().split(/\s+/).filter(Boolean)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (/^-{1,2}(p|pass|password|passwd|token|secret|key|api-?key|auth)$/i.test(t)) {
      skipNext = true;
      continue;
    }
    if (t.includes('=') || t.includes('@')) continue;
    out.push(t);
    if (out.length >= 5) break;
  }
  const text = out.join(' ').slice(0, 300);
  return text || undefined;
}

export interface ServiceLines {
  services: string[];
  pm2: string[];
  processes: string[];
  appDirs: string[];
  /** `dir<TAB>path,path,...` rows of folders that hold data the app keeps itself. */
  statePaths: string[];
}

/** The `SERVICE`, `PM2JSON`, `PROCESS` and `APPDIR` lines of the services probe as a report part. */
export function buildServices(l: ServiceLines): { services: ProbeService[]; appDirs: string[] } {
  const services: ProbeService[] = [];
  const num = (x: string) =>
    x
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  for (const row of l.services) {
    const [manager, name, state, wd, user, ports, layout, argv] = row.split('\t');
    if (!name || (manager !== 'systemd' && manager !== 'systemd_user')) continue;
    const cmd = safeCommand(argv ?? '');
    services.push({
      manager,
      name: name.slice(0, 120),
      state: (state ?? 'running').slice(0, 40),
      ...(wd && SAFE_PATH.test(wd) ? { workingDir: wd.slice(0, 300) } : {}),
      ...(cmd ? { command: cmd } : {}),
      ports: num(ports ?? '').slice(0, 10),
      ...(user ? { user: user.slice(0, 60) } : {}),
      ...(layout === '1' ? { releaseLayout: true } : {}),
    });
  }
  for (const text of l.pm2) {
    try {
      const list = JSON.parse(text) as Array<{
        name?: string;
        pm2_env?: {
          status?: string;
          pm_cwd?: string;
          pm_exec_path?: string;
          username?: string;
          args?: unknown;
        };
      }>;
      for (const p of Array.isArray(list) ? list.slice(0, 20) : []) {
        if (!p.name || !/^[A-Za-z0-9._-]+$/.test(p.name)) continue;
        const wd = p.pm2_env?.pm_cwd;
        const exec = [
          p.pm2_env?.pm_exec_path,
          ...(Array.isArray(p.pm2_env?.args) ? (p.pm2_env.args as unknown[]).map(String) : []),
        ]
          .filter(Boolean)
          .join(' ');
        const cmd = safeCommand(exec);
        services.push({
          manager: 'pm2',
          name: p.name.slice(0, 120),
          state: (p.pm2_env?.status ?? 'unknown').slice(0, 40),
          ...(wd && SAFE_PATH.test(wd) ? { workingDir: wd.slice(0, 300) } : {}),
          ...(cmd ? { command: cmd } : {}),
          ports: [],
          ...(p.pm2_env?.username ? { user: String(p.pm2_env.username).slice(0, 60) } : {}),
        });
      }
    } catch {
      // not JSON: no pm2 processes to report
    }
  }
  // listening programs that no service explains
  const byPid = new Map<string, { ports: number[]; cwd: string; cmd: string }>();
  for (const row of l.processes) {
    const [port, pid, cwd, cmd] = row.split('\t');
    if (!pid || !cwd || !SAFE_PATH.test(cwd)) continue;
    const e = byPid.get(pid) ?? { ports: [], cwd, cmd: cmd ?? '' };
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && !e.ports.includes(n)) e.ports.push(n);
    byPid.set(pid, e);
  }
  for (const e of byPid.values()) {
    if (services.some((s) => s.workingDir === e.cwd || s.ports.some((p) => e.ports.includes(p)))) continue;
    const cmd = safeCommand(e.cmd);
    const prog = (e.cmd.trim().split(/\s+/)[0] ?? 'program').split('/').pop() ?? 'program';
    services.push({
      manager: 'process',
      name: prog.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) || 'program',
      state: 'running',
      workingDir: e.cwd.slice(0, 300),
      ...(cmd ? { command: cmd } : {}),
      ports: e.ports.slice(0, 10),
    });
  }
  for (const s of services)
    if (!s.releaseLayout && s.workingDir && s.workingDir.endsWith('/current')) s.releaseLayout = true;
  const state = new Map<string, string[]>();
  for (const row of l.statePaths) {
    const [dir, list] = row.split('\t');
    if (!dir || !list) continue;
    state.set(
      dir,
      list
        .split(',')
        .filter((x) => x && /^[A-Za-z0-9._][A-Za-z0-9._/+@=-]*$/.test(x))
        .slice(0, 20),
    );
  }
  for (const s of services) {
    const sp = s.workingDir ? state.get(s.workingDir) : undefined;
    if (sp?.length) s.statePaths = sp;
  }
  const appDirs = [...new Set(l.appDirs.filter((d) => SAFE_PATH.test(d)))].slice(0, 30);
  return { services: services.slice(0, 40), appDirs };
}

const splitServiceLines = (out: string): ServiceLines => {
  const l: ServiceLines = { services: [], pm2: [], processes: [], appDirs: [], statePaths: [] };
  for (const line of out.split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const tag = line.slice(0, i);
    const rest = line.slice(i + 1);
    if (tag === 'SERVICE') l.services.push(rest);
    else if (tag === 'PM2JSON') l.pm2.push(rest);
    else if (tag === 'PROCESS') l.processes.push(rest);
    else if (tag === 'APPDIR') l.appDirs.push(rest);
    else if (tag === 'STATEPATHS') l.statePaths.push(rest);
  }
  return l;
};

export function classifySsh(r: Ran): { state: ProbeSshHost['state']; detail?: string } {
  if (r.code === 0) return { state: 'reachable' };
  const e = r.stderr;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i.test(e))
    return { state: 'host_key_changed', detail: 'the server’s identity changed' };
  if (/Host key verification failed|No .* host key is known|host key.*not known/i.test(e))
    return { state: 'host_key_unknown', detail: 'this computer has never connected to it' };
  if (/Permission denied|no (supported )?authentication methods|Too many authentication failures/i.test(e))
    return { state: 'asks_password', detail: 'it did not accept the sign-in without a password' };
  if (
    /Could not resolve|timed out|refused|No route|unreachable|Network is|closed by remote|Connection reset/i.test(
      e,
    )
  )
    return {
      state: 'unreachable',
      detail: (e.split('\n').find(Boolean) ?? '').replace(/^ssh: /, '').slice(0, 150),
    };
  return {
    state: r.timedOut ? 'unreachable' : 'unreachable',
    detail: (e.split('\n').find(Boolean) ?? 'did not answer').slice(0, 150),
  };
}

const SSH_BASE = (connectSec: number) => [
  '-o',
  'BatchMode=yes',
  '-o',
  `ConnectTimeout=${connectSec}`,
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'LogLevel=ERROR',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
];

/** The non-wildcard `Host` aliases of `~/.ssh/config` (text only), with whether an IdentityFile line sits in the block. */
export function parseSshConfigHosts(text: string): Array<{ alias: string; hasIdentity: boolean }> {
  const out: Array<{ alias: string; hasIdentity: boolean }> = [];
  let current: Array<{ alias: string; hasIdentity: boolean }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const host = /^host\s+(.+)$/i.exec(line);
    if (host) {
      current = (host[1] as string)
        .split(/\s+/)
        .filter((a) => SAFE_ALIAS.test(a))
        .map((alias) => ({ alias, hasIdentity: false }));
      out.push(...current);
      continue;
    }
    if (/^match\s/i.test(line)) {
      current = [];
      continue;
    }
    if (/^identityfile\s/i.test(line)) for (const c of current) c.hasIdentity = true;
  }
  const seen = new Set<string>();
  return out.filter((h) => (seen.has(h.alias) ? false : (seen.add(h.alias), true))).slice(0, 30);
}

// ---------------------------------------------------------------------------------------------- the probe

export async function runDeployProbe(
  p: DeployProbePayload,
  opts: ProbeOptions = {},
): Promise<DeployProbeResult> {
  const total = opts.totalMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DeployProbeResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: 'timeout', detail: 'the check took longer than a minute' }),
      total,
    );
    timer.unref?.();
  });
  try {
    const work = (async (): Promise<DeployProbeResult> => {
      if (process.platform === 'win32') return { ok: false, error: 'unsupported_os' };
      if (p.scope === 'local') return await probeLocal(p, opts);
      if (p.scope === 'ssh_hosts') return await probeSshHosts(opts);
      if (!p.host || !SAFE_ALIAS.test(p.host))
        return { ok: false, error: 'bad_request', detail: 'a server name is needed' };
      if (p.scope === 'ssh_check') return await probeSshCheck(p, p.host, opts);
      return await probeSshTarget(p, p.host, opts);
    })();
    return await Promise.race([work, timeout]);
  } catch (err) {
    return {
      ok: false,
      error: 'bad_request',
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fit(report: ProbeReport): ProbeReport {
  let r = report;
  for (let i = 0; i < 6 && Buffer.byteLength(JSON.stringify(r)) > MAX_REPORT_BYTES; i++) {
    r = {
      ...r,
      containers: r.containers.slice(0, Math.max(5, 40 >> i)),
      folders: r.folders.map((f) => ({ ...f, entries: f.entries.slice(0, Math.max(5, 20 >> i)) })),
      volumes: r.volumes.slice(0, Math.max(5, 40 >> i)),
    };
  }
  return ProbeReportSchema.parse(r);
}

const now = (o: ProbeOptions) => (o.now?.() ?? new Date()).toISOString();

async function probeLocal(p: DeployProbePayload, o: ProbeOptions): Promise<DeployProbeResult> {
  const t = o.commandMs ?? 10_000;
  const home = o.home ?? homedir();
  const ver = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: t,
    ...(o.env ? { env: o.env } : {}),
  });
  // apps that run without Docker: a machine with none of Docker still has a report when it has such apps
  const svc = await run('sh', ['-c', SERVICES_PROBE_SCRIPT], {
    timeoutMs: t,
    ...(o.env ? { env: o.env } : {}),
  });
  const direct = buildServices(splitServiceLines(svc.stdout));
  const hasDirect = direct.services.length > 0 || direct.appDirs.length > 0;
  if (ver.missing && !hasDirect) return { ok: false, error: 'docker_missing' };
  if (!ver.missing && /permission denied/i.test(ver.stderr) && !hasDirect)
    return { ok: false, error: 'docker_permission' };
  const usable = !ver.missing && ver.code === 0;
  const report: ProbeReport = {
    scope: 'local',
    at: now(o),
    docker: {
      installed: !ver.missing,
      usable,
      ...(usable ? { version: ver.stdout.trim().slice(0, 40) } : {}),
    },
    ...(direct.services.length ? { services: direct.services } : {}),
    ...(direct.appDirs.length ? { appDirs: direct.appDirs } : {}),
    containers: [],
    composeFiles: [],
    volumes: [],
    folders: [],
    backups: [],
    proxies: [],
    urls: [],
    listeners: [],
  };
  const env = o.env ? { env: o.env } : {};
  if (usable) {
    const cv = await run('docker', ['compose', 'version', '--short'], { timeoutMs: t, ...env });
    if (cv.code === 0 && report.docker) report.docker.composeVersion = cv.stdout.trim().slice(0, 40);
    const ps = await run(
      'docker',
      [
        'ps',
        '--all',
        '--format',
        'CONTAINER\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project.config_files"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project.environment_file"}}',
      ],
      { timeoutMs: t, ...env },
    );
    for (const l of ps.stdout.split('\n')) {
      const c = l.startsWith('CONTAINER\t') ? parseContainerLine(l) : null;
      if (c) report.containers.push(c);
    }
    const vols = await run('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeoutMs: t, ...env });
    report.volumes = vols.stdout
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 100);
    const ls = await run('docker', ['compose', 'ls', '--all', '--format', 'json'], { timeoutMs: t, ...env });
    const projects = new Map<string, string[]>();
    try {
      for (const row of JSON.parse(ls.stdout || '[]') as Array<{ Name?: string; ConfigFiles?: string }>)
        if (row.Name)
          projects.set(
            row.Name,
            (row.ConfigFiles ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          );
    } catch {
      // an older compose without json: containers' labels still tell the files
    }
    const files = new Map<string, string | undefined>();
    for (const [name, list] of projects) for (const f of list) files.set(f, name);
    for (const c of report.containers)
      if (c.composeFile && !files.has(c.composeFile)) files.set(c.composeFile, c.project);
    for (const f of p.hints?.composeFiles ?? []) {
      const abs = f.startsWith('~/') ? join(home, f.slice(2)) : f;
      if (COMPOSE_NAME.test(abs) && (under(abs, home) || serverHintDir(abs, o.hintRoots)) && !files.has(abs))
        files.set(abs, undefined);
    }
    // compose files in the usual places: one and two levels under the home folder, and under /opt and /srv
    const checked: string[] = [];
    const note = (x: string) => {
      if (!checked.includes(x) && checked.length < 60) checked.push(x);
    };
    for (const c of report.containers) if (c.workingDir) note(c.workingDir);
    for (const d of p.hints?.dirs ?? []) note(d.startsWith('~/') ? join(home, d.slice(2)) : d);
    const roots: Array<[string, number]> = [
      [home, 2],
      ...((o.hintRoots ?? ['/opt', '/srv']).map((r) => [r, 1]) as Array<[string, number]>),
    ];
    for (const [root, depth] of roots) note(`${root}/*${depth > 1 ? '/*' : ''}`);
    const found = scanComposeFiles(roots, [
      ...(p.hints?.dirs ?? []).map((d) => (d.startsWith('~/') ? join(home, d.slice(2)) : d)),
    ]);
    for (const f of found) if (!files.has(f)) files.set(f, undefined);
    if (checked.length) report.checked = checked;
    for (const [path, project] of [...files].slice(0, 16)) {
      if (!path.startsWith('/') || !SAFE_PATH.test(path)) continue;
      try {
        if (statSync(path).size > MAX_COMPOSE_BYTES) {
          report.composeFiles.push({
            path,
            ...(project ? { project } : {}),
            services: [],
            volumes: [],
            unreadable: 'the file is too big to read',
          });
          continue;
        }
        report.composeFiles.push(parseComposeStructure(path, readFileSync(path, 'utf8'), project));
      } catch {
        report.composeFiles.push({
          path,
          ...(project ? { project } : {}),
          services: [],
          volumes: [],
          unreadable: 'could not be read',
        });
      }
    }
    // folders: the hinted dirs and the backups folder next to a compose file
    const hintDirs = (p.hints?.dirs ?? [])
      .map((d) => (d.startsWith('~/') ? join(home, d.slice(2)) : d))
      .filter((d) => under(d, home) || serverHintDir(d, o.hintRoots));
    const dirs = new Set<string>(hintDirs);
    for (const cf of report.composeFiles) dirs.add(cf.path.slice(0, cf.path.lastIndexOf('/')) || '/');
    for (const d of [...dirs].slice(0, 12)) {
      if (!SAFE_PATH.test(d)) continue;
      const b = backupsIn(join(d, 'backups'));
      if (b) report.backups.push(b);
      const direct = backupsIn(d);
      if (direct && direct.count > 0 && /backup/i.test(d)) report.backups.push(direct);
    }
    for (const abs of hintDirs.slice(0, 10)) {
      if (!SAFE_PATH.test(abs)) continue;
      const b = backupsIn(abs);
      if (b && b.count > 0 && !report.backups.some((x) => x.dir === b.dir)) report.backups.push(b);
    }
    // urls: the hinted ones, and the app's own published ports of a hinted compose project
    const urls = new Set<string>(
      (p.hints?.urls ?? []).filter((u) => /^https?:\/\/[A-Za-z0-9._~:/?#@%&=+,-]+$/.test(u)),
    );
    const hintedProjects = new Set(
      report.composeFiles
        .filter((c) => (p.hints?.composeFiles ?? []).some((h) => c.path.endsWith(h.replace(/^~/, ''))))
        .map((c) => c.project),
    );
    for (const c of report.containers)
      if (c.project && hintedProjects.has(c.project))
        for (const pt of c.ports)
          if (pt.host && /^(?:0\.0\.0\.0|127\.0\.0\.1)?$|^::$/.test(pt.bind ?? ''))
            urls.add(`http://127.0.0.1:${pt.host}/api/health`);
    for (const u of [...urls].slice(0, 6)) report.urls.push({ url: u, status: await status(u, o) });
  }
  const df = await run('df', ['-Pm', home], { timeoutMs: t, ...env });
  const mb = Number(df.stdout.trim().split('\n').pop()?.trim().split(/\s+/)[3]);
  if (Number.isFinite(mb)) report.freeDiskMb = mb;
  markUnsupportedStacks(report);
  return { ok: true, report: fit(report) };
}

const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];

/** Compose files directly in the given folders, and one or two levels under the roots (hidden and dependency folders skipped). */
function scanComposeFiles(roots: Array<[string, number]>, folders: string[]): string[] {
  const out: string[] = [];
  const add = (dir: string) => {
    for (const n of COMPOSE_FILENAMES) {
      const f = `${dir}/${n}`;
      try {
        if (statSync(f).isFile() && SAFE_PATH.test(f) && !out.includes(f)) out.push(f);
      } catch {
        // not there
      }
    }
  };
  const kids = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter((n) => !n.startsWith('.') && n !== 'node_modules' && n !== 'snap')
        .slice(0, 200)
        .map((n) => join(dir, n))
        .filter((c) => {
          try {
            return statSync(c).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  };
  for (const f of folders) if (SAFE_PATH.test(f)) add(f);
  for (const [root, depth] of roots) {
    for (const d1 of kids(root)) {
      add(d1);
      if (depth > 1) for (const d2 of kids(d1)) add(d2);
    }
  }
  return out.slice(0, 16);
}

function backupsIn(dir: string): ProbeBackups | null {
  try {
    const names = readdirSync(dir).filter((n) => /\.(sql|sql\.gz|dump|tar\.gz|bak)$/i.test(n));
    if (names.length === 0 && !statSync(dir).isDirectory()) return null;
    let newest: { n: string; t: number } | undefined;
    for (const n of names) {
      const t = statSync(join(dir, n)).mtimeMs;
      if (!newest || t > newest.t) newest = { n, t };
    }
    return {
      dir,
      count: names.length,
      ...(newest ? { newestName: newest.n.slice(0, 200), newestAt: new Date(newest.t).toISOString() } : {}),
    };
  } catch {
    return null;
  }
}

async function status(url: string, o: ProbeOptions): Promise<number | null> {
  try {
    const f = o.fetchImpl ?? fetch;
    const res = await f(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3000) });
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

async function probeSshHosts(o: ProbeOptions): Promise<DeployProbeResult> {
  const home = o.home ?? homedir();
  let text = '';
  try {
    text = readFileSync(o.userSshConfig ?? join(home, '.ssh', 'config'), 'utf8');
  } catch {
    // no config: no aliases
  }
  const hosts = parseSshConfigHosts(text);
  const env = o.env ? { env: o.env } : {};
  const t = o.commandMs ?? 10_000;
  const sshHosts: ProbeSshHost[] = await Promise.all(
    hosts.map(async (h, i): Promise<ProbeSshHost> => {
      if (i >= 10) return { alias: h.alias, hasIdentity: h.hasIdentity, state: 'unchecked' };
      const own = userSshArgs(home, o.userSshConfig);
      const g = await run('ssh', [...own, '-G', '--', h.alias], { timeoutMs: t, ...env });
      const kv = new Map<string, string>();
      for (const l of g.stdout.split('\n')) {
        const m = /^(\w+)\s+(.*)$/.exec(l);
        if (m && !kv.has(m[1] as string)) kv.set(m[1] as string, (m[2] as string).trim());
      }
      const c = await run('ssh', [...own, ...SSH_BASE(o.connectSec ?? 8), '--', h.alias, 'true'], {
        timeoutMs: t + 3000,
        ...env,
      });
      const cls = classifySsh(c);
      const port = Number(kv.get('port'));
      return {
        alias: h.alias,
        ...(kv.get('hostname') ? { hostname: (kv.get('hostname') as string).slice(0, 200) } : {}),
        ...(kv.get('user') ? { user: (kv.get('user') as string).slice(0, 80) } : {}),
        ...(Number.isInteger(port) && port > 0 ? { port } : {}),
        hasIdentity: h.hasIdentity,
        state: cls.state,
        ...(cls.detail ? { detail: cls.detail } : {}),
      };
    }),
  );
  return {
    ok: true,
    report: fit({
      scope: 'ssh_hosts',
      at: now(o),
      containers: [],
      composeFiles: [],
      volumes: [],
      folders: [],
      backups: [],
      proxies: [],
      urls: [],
      listeners: [],
      sshHosts,
    } as ProbeReport),
  };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `-F <config>` when this computer holds a dedicated key for the target (else the person's own ssh decides). */
function managedArgs(p: DeployProbePayload, host: string, o: ProbeOptions): string[] {
  const cfg = o.keys?.sshConfigFor(p.targetId, host);
  return cfg ? ['-F', cfg] : userSshArgs(o.home ?? homedir(), o.userSshConfig);
}

/** `ssh_check`: can this computer sign in to the target's server without a prompt? Reads nothing from the server. */
async function probeSshCheck(
  p: DeployProbePayload,
  host: string,
  o: ProbeOptions,
): Promise<DeployProbeResult> {
  const r = await run(
    'ssh',
    [...managedArgs(p, host, o), ...SSH_BASE(o.connectSec ?? 8), '--', host, 'true'],
    { timeoutMs: (o.commandMs ?? 10_000) + 3000, ...(o.env ? { env: o.env } : {}) },
  );
  if (r.missing)
    return { ok: false, error: 'ssh_unreachable', detail: 'ssh is not installed on this computer' };
  if (r.code === 0)
    return {
      ok: true,
      report: ProbeReportSchema.parse({
        scope: 'ssh_check',
        at: now(o),
        host,
        containers: [],
        composeFiles: [],
        volumes: [],
        folders: [],
        backups: [],
        proxies: [],
        urls: [],
        listeners: [],
      }),
    };
  const c = classifySsh(r);
  const error: ProbeError =
    c.state === 'host_key_changed'
      ? 'ssh_host_key_changed'
      : c.state === 'host_key_unknown'
        ? 'ssh_host_key_unknown'
        : c.state === 'asks_password'
          ? 'ssh_auth'
          : r.timedOut
            ? 'timeout'
            : 'ssh_unreachable';
  return { ok: false, error, ...(c.detail ? { detail: c.detail } : {}) };
}

const IMAGE_VALUE = /^[A-Za-z0-9._/:@-]{1,200}$/;

async function probeSshTarget(
  p: DeployProbePayload,
  host: string,
  o: ProbeOptions,
): Promise<DeployProbeResult> {
  const dirs = [
    ...new Set((p.hints?.dirs ?? []).filter((d) => SAFE_PATH.test(d) && serverHintDir(d, o.hintRoots))),
  ].slice(0, 6);
  for (const f of p.hints?.composeFiles ?? [])
    if (SAFE_PATH.test(f) && COMPOSE_NAME.test(f)) {
      const d = f.slice(0, f.lastIndexOf('/'));
      if (d && serverHintDir(d, o.hintRoots) && !dirs.includes(d) && dirs.length < 8) dirs.push(d);
    }
  const r = await run(
    'ssh',
    [
      ...managedArgs(p, host, o),
      ...SSH_BASE(o.connectSec ?? 10),
      '--',
      host,
      `sh -s -- ${dirs.map(shq).join(' ')}`.trimEnd(),
    ],
    { timeoutMs: o.commandMs ?? 45_000, input: REMOTE_PROBE_SCRIPT, ...(o.env ? { env: o.env } : {}) },
  );
  if (r.missing)
    return { ok: false, error: 'ssh_unreachable', detail: 'ssh is not installed on this computer' };
  if (r.timedOut) return { ok: false, error: 'timeout' };
  if (r.code !== 0 && !r.stdout.includes('@@DONE')) {
    const c = classifySsh(r);
    const error: ProbeError =
      c.state === 'host_key_changed'
        ? 'ssh_host_key_changed'
        : c.state === 'host_key_unknown'
          ? 'ssh_host_key_unknown'
          : c.state === 'asks_password'
            ? 'ssh_auth'
            : 'ssh_unreachable';
    return { ok: false, error, ...(c.detail ? { detail: c.detail } : {}) };
  }
  const report = parseRemoteOutput(r.stdout, host, o);
  // The public addresses are asked from THIS computer (status only): the way a person's browser would reach the site.
  for (const u of (p.hints?.urls ?? [])
    .filter((x) => /^https?:\/\/[A-Za-z0-9._~:/?#@%&=+,-]+$/.test(x))
    .slice(0, 9))
    report.urls.push({ url: u, status: await status(u, o) });
  return { ok: true, report: fit(report) };
}

/** The line protocol of `REMOTE_PROBE_SCRIPT` as a report. Compose text is reduced to structure and dropped. */
export function parseRemoteOutput(out: string, host: string, o: ProbeOptions = {}): ProbeReport {
  const report: ProbeReport = {
    scope: 'ssh_target',
    at: now(o),
    host,
    containers: [],
    composeFiles: [],
    volumes: [],
    folders: [],
    backups: [],
    proxies: [],
    urls: [],
    listeners: [],
  };
  const docker: { installed: boolean; usable: boolean; version?: string; composeVersion?: string } = {
    installed: true,
    usable: false,
  };
  const folders = new Map<string, ProbeReport['folders'][number]>();
  const folder = (path: string) => {
    let f = folders.get(path);
    if (!f) {
      f = { path, exists: true, entries: [] };
      folders.set(path, f);
    }
    return f;
  };
  const svcLines: ServiceLines = { services: [], pm2: [], processes: [], appDirs: [], statePaths: [] };
  const composePaths: string[] = [];
  const checked: string[] = [];
  const sites = new Map<string, Set<string>>();
  const systemd = new Set<string>();
  let compose: { path: string; text: string[] } | null = null;
  const composeTexts = new Map<string, string>();
  for (const line of out.split('\n')) {
    if (compose) {
      if (line === '@@ENDCOMPOSE') {
        composeTexts.set(compose.path, compose.text.join('\n'));
        compose = null;
      } else compose.text.push(line);
      continue;
    }
    if (line.startsWith('@@COMPOSE ')) {
      compose = { path: line.slice('@@COMPOSE '.length).trim(), text: [] };
      continue;
    }
    const sp = line.search(/[ \t]/);
    const tag = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1);
    switch (tag) {
      case 'OS':
        report.os = rest.slice(0, 80);
        break;
      case 'DOCKER_MISSING':
        docker.installed = false;
        break;
      case 'DOCKER_VERSION':
        if (rest.trim()) docker.version = rest.trim().slice(0, 40);
        break;
      case 'DOCKER_USABLE':
        docker.usable = rest.trim() === '1';
        break;
      case 'COMPOSE_VERSION':
        if (rest.trim()) docker.composeVersion = rest.trim().slice(0, 40);
        break;
      case 'CONTAINER': {
        const c = parseContainerLine(line);
        if (c) report.containers.push(c);
        break;
      }
      case 'VOLUME':
        report.volumes.push(rest.trim().slice(0, 200));
        break;
      case 'COMPOSEFILE':
        if (SAFE_PATH.test(rest.trim()) && !composePaths.includes(rest.trim()))
          composePaths.push(rest.trim());
        break;
      case 'SERVICE':
        svcLines.services.push(rest);
        break;
      case 'PM2JSON':
        svcLines.pm2.push(rest);
        break;
      case 'PROCESS':
        svcLines.processes.push(rest);
        break;
      case 'APPDIR':
        svcLines.appDirs.push(rest);
        break;
      case 'STATEPATHS':
        svcLines.statePaths.push(rest);
        break;
      case 'CHECKED':
        if (
          /^\/[A-Za-z0-9._/+@=*-]*$/.test(rest.trim()) &&
          !checked.includes(rest.trim()) &&
          checked.length < 60
        )
          checked.push(rest.trim());
        break;
      case 'NODIR':
        folders.set(rest.trim(), { path: rest.trim(), exists: false, entries: [] });
        break;
      case 'DIR':
        folder(rest.trim());
        break;
      case 'ENTRY': {
        const [d, e] = rest.split('\t');
        if (d && e && folders.has(d)) (folders.get(d) as { entries: string[] }).entries.push(e.slice(0, 120));
        break;
      }
      case 'ENVKEY': {
        const [d, k] = rest.split('\t');
        if (d && k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          const f = folder(d);
          f.envKeys = [...(f.envKeys ?? []), k];
        }
        break;
      }
      case 'IMAGEVAR': {
        const [d, k, v] = rest.split('\t');
        const val = (v ?? '').replace(/^["']|["']$/g, '');
        if (d && k && IMAGE_VALUE.test(val)) {
          const f = folder(d);
          f.imageVars = [...(f.imageVars ?? []), { name: k.slice(0, 80), value: val }];
        }
        break;
      }
      case 'BACKUPS': {
        const [d, n] = rest.split('\t');
        if (d) report.backups.push({ dir: d.slice(0, 300), count: Number(n) || 0 });
        break;
      }
      case 'NEWEST': {
        const [d, name, at] = rest.split('\t');
        const b = report.backups.find((x) => x.dir === d);
        if (b && name) {
          b.newestName = name.slice(0, 200);
          if (at) b.newestAt = at.slice(0, 40);
        }
        break;
      }
      case 'SITE': {
        const [kind, s] = rest.split('\t');
        if (kind && s) {
          const set = sites.get(kind) ?? new Set<string>();
          for (const x of s.split(/[\s,]+/).filter(Boolean))
            if (/^[A-Za-z0-9.*:/_-]+$/.test(x)) set.add(x.slice(0, 200));
          sites.set(kind, set);
        }
        break;
      }
      case 'SYSTEMD':
        systemd.add(rest.trim());
        break;
      case 'LISTEN': {
        const n = Number(rest.trim());
        if (n === 80 || n === 443) report.listeners.push(n);
        break;
      }
      case 'DISK': {
        const n = Number(rest.trim());
        if (Number.isFinite(n) && report.freeDiskMb === undefined) report.freeDiskMb = n;
        break;
      }
    }
  }
  report.docker = docker;
  if (checked.length) report.checked = checked;
  const direct = buildServices(svcLines);
  if (direct.services.length) report.services = direct.services;
  if (direct.appDirs.length) report.appDirs = direct.appDirs;
  report.folders = [...folders.values()].slice(0, 20);
  for (const path of composePaths.slice(0, 16)) {
    const text = composeTexts.get(path);
    const project = report.containers.find((c) => c.composeFile === path)?.project;
    report.composeFiles.push(
      text !== undefined
        ? parseComposeStructure(path, text, project)
        : {
            path,
            ...(project ? { project } : {}),
            services: [],
            volumes: [],
            unreadable: 'could not be read',
          },
    );
  }
  markUnsupportedStacks(report);
  // Only an image variable that a compose file of that folder really refers to is reported (not any `*IMAGE*` line of a .env)
  for (const f of report.folders) {
    if (!f.imageVars) continue;
    const named = new Set(
      report.composeFiles
        .filter((c) => c.path.startsWith(`${f.path}/`))
        .flatMap((c) => c.services.flatMap((svc) => svc.vars)),
    );
    const kept = f.imageVars.filter((v) => named.has(v.name));
    if (kept.length) f.imageVars = kept;
    else delete f.imageVars;
  }
  // proxies: running containers and active services
  for (const c of report.containers) {
    const kind = /caddy/i.test(c.image)
      ? 'caddy'
      : /nginx/i.test(c.image)
        ? 'nginx'
        : /traefik/i.test(c.image)
          ? 'traefik'
          : null;
    if (kind && c.state === 'running')
      report.proxies.push({
        kind,
        via: 'container',
        name: c.name,
        sites: [...(sites.get(kind) ?? [])].slice(0, 30),
      });
  }
  for (const u of systemd)
    if (u === 'caddy' || u === 'nginx' || u === 'traefik')
      report.proxies.push({
        kind: u,
        via: 'systemd',
        name: u,
        sites: [...(sites.get(u) ?? [])].slice(0, 30),
      });
  report.listeners = [...new Set(report.listeners)];
  return report;
}
