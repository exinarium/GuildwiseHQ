import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type DeployProbePayload,
  type DeployProbeResult,
  type ProbeBackups,
  type ProbeComposeFile,
  type ProbeComposeService,
  type ProbeContainer,
  type ProbeError,
  type ProbeReport,
  ProbeReportSchema,
  type ProbeSshHost,
  parseYamlLimited,
} from '@aom/shared';
import { execa } from 'execa';
import { REMOTE_PROBE_SCRIPT } from './probe-remote.ts';

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
}

const SAFE_PATH = /^\/[A-Za-z0-9._/+@=-]*$/;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_COMPOSE_BYTES = 1_000_000;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
}

async function run(
  cmd: string,
  args: string[],
  o: { timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv },
): Promise<Ran> {
  const r = await execa(cmd, args, {
    reject: false,
    timeout: o.timeoutMs,
    ...(o.input !== undefined ? { input: o.input } : { stdin: 'ignore' as const }),
    env: o.env ?? process.env,
    maxBuffer: 4_000_000,
    all: false,
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

/** One `CONTAINER\tname\timage\tstate\tstatus\tports\tproject\tservice\tconfig_files\tworking_dir` line. */
export function parseContainerLine(line: string): ProbeContainer | null {
  const f = line.replace(/^CONTAINER\t/, '').split('\t');
  if (f.length < 4 || !f[0]) return null;
  const configFile = (f[7] ?? '').split(',')[0]?.trim();
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
  };
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

function classifySsh(r: Ran): { state: ProbeSshHost['state']; detail?: string } {
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
  if (ver.missing) return { ok: false, error: 'docker_missing' };
  if (/permission denied/i.test(ver.stderr)) return { ok: false, error: 'docker_permission' };
  const usable = ver.code === 0;
  const report: ProbeReport = {
    scope: 'local',
    at: now(o),
    docker: { installed: true, usable, ...(usable ? { version: ver.stdout.trim().slice(0, 40) } : {}) },
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
        'CONTAINER\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project.config_files"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
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
    for (const f of p.hints?.composeFiles ?? [])
      if (!files.has(f)) files.set(f.startsWith('~/') ? join(home, f.slice(2)) : f, undefined);
    for (const [path, project] of [...files].slice(0, 10)) {
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
    const dirs = new Set<string>(
      (p.hints?.dirs ?? []).map((d) => (d.startsWith('~/') ? join(home, d.slice(2)) : d)),
    );
    for (const cf of report.composeFiles) dirs.add(cf.path.slice(0, cf.path.lastIndexOf('/')) || '/');
    for (const d of [...dirs].slice(0, 12)) {
      if (!SAFE_PATH.test(d)) continue;
      const b = backupsIn(join(d, 'backups'));
      if (b) report.backups.push(b);
      const direct = backupsIn(d);
      if (direct && direct.count > 0 && /backup/i.test(d)) report.backups.push(direct);
    }
    for (const d of (p.hints?.dirs ?? []).slice(0, 10)) {
      const abs = d.startsWith('~/') ? join(home, d.slice(2)) : d;
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
  return { ok: true, report: fit(report) };
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
    text = readFileSync(join(home, '.ssh', 'config'), 'utf8');
  } catch {
    // no config: no aliases
  }
  const hosts = parseSshConfigHosts(text);
  const env = o.env ? { env: o.env } : {};
  const t = o.commandMs ?? 10_000;
  const sshHosts: ProbeSshHost[] = await Promise.all(
    hosts.map(async (h, i): Promise<ProbeSshHost> => {
      if (i >= 10) return { alias: h.alias, hasIdentity: h.hasIdentity, state: 'unchecked' };
      const g = await run('ssh', ['-G', '--', h.alias], { timeoutMs: t, ...env });
      const kv = new Map<string, string>();
      for (const l of g.stdout.split('\n')) {
        const m = /^(\w+)\s+(.*)$/.exec(l);
        if (m && !kv.has(m[1] as string)) kv.set(m[1] as string, (m[2] as string).trim());
      }
      const c = await run('ssh', [...SSH_BASE(o.connectSec ?? 8), '--', h.alias, 'true'], {
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
const IMAGE_VALUE = /^[A-Za-z0-9._/:@-]{1,200}$/;

async function probeSshTarget(
  p: DeployProbePayload,
  host: string,
  o: ProbeOptions,
): Promise<DeployProbeResult> {
  const dirs = [...new Set((p.hints?.dirs ?? []).filter((d) => SAFE_PATH.test(d)))].slice(0, 6);
  for (const f of p.hints?.composeFiles ?? [])
    if (SAFE_PATH.test(f)) {
      const d = f.slice(0, f.lastIndexOf('/'));
      if (d && !dirs.includes(d) && dirs.length < 8) dirs.push(d);
    }
  const r = await run(
    'ssh',
    [...SSH_BASE(o.connectSec ?? 10), '--', host, `sh -s -- ${dirs.map(shq).join(' ')}`.trimEnd()],
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
  const composePaths: string[] = [];
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
  report.folders = [...folders.values()].slice(0, 20);
  for (const path of composePaths.slice(0, 10)) {
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
