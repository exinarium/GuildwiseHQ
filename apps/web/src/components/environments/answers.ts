import {
  type ConnectionState,
  type DeliverySetup,
  type DirectApp,
  type DirectManager,
  directEnv,
  formatCommandLine,
  localAdoptEnv,
  type ProbeComposeFile,
  type ProbeComposeService,
  type ProbeContainer,
  type ProbeReport,
  type ProbeService,
  parseCommandLine,
  parseImageRef,
  type SetupEnv,
  sshShipEnv,
  type UpdateMethod,
  updateMethodOf,
} from '@aom/shared';
import { type EnvRole, roleOf } from './model.ts';

/**
 * The pure part of the Add environment dialog (docs/design/environments-ux.md section 5.2): what a probe found as choices a
 * person can read, the answers, and the structured environment those answers make (the templates of `@aom/shared`). No React.
 */

export type Purpose = EnvRole;
export type Hosting = 'this_computer' | 'ssh';

/** An app that runs directly on the machine (no Docker), as the probe found it: a system service, a pm2 process or a program. */
export type NativeApp = ProbeService;

/** The apps a probe found that run directly on the machine. A program that listens nowhere and has no folder is not an app. */
export function nativeAppsFromReport(report: ProbeReport | null | undefined): NativeApp[] {
  return (report?.services ?? []).filter(
    (a) => a.manager !== 'process' || a.ports.length > 0 || !!a.workingDir,
  );
}

/** The words for the manager of a found app ("a system service", "a pm2 process"). */
export const MANAGER_WORDS: Record<NativeApp['manager'], string> = {
  systemd: 'a system service',
  systemd_user: 'a service of your own user',
  pm2: 'a pm2 process',
  process: 'a running program',
};

export interface NativeAnswers {
  how: NativeApp['manager'] | 'typed';
  /** The unit, the pm2 name or the program: it names the app on the card. */
  name: string;
  /** Where it runs from now (the link the service must start from). */
  workingDir: string;
  /** The folder that holds `releases/` (a new one beside a plain folder). */
  appDir: string;
  /** It already runs from `.../current` of a releases layout: nothing to convert. */
  releaseLayout: boolean;
  /** The person confirmed that a plain folder may become the first release (moved, never copied or deleted). */
  adoptFolder: boolean;
  port: string;
  restartVia: 'service' | 'pm2' | 'command';
  /** The unit name, the pm2 name, or the command line. */
  restartTarget: string;
  scope: 'system' | 'user';
  /** Restarting needs sudo (only with an explicit yes). */
  sudo: boolean;
  keepReleases: number;
  /** Commands that build the new version, one per line (run in the new folder). */
  build: string;
  /** Files and folders kept in `shared/` and linked into every release. */
  shared: string;
  /** Files and folders that look like data the app writes itself (found by the look): they must be kept between versions. */
  statePaths: string[];
  /** Back up a database first (empty: none). */
  dbEngine: '' | 'postgres' | 'mysql' | 'sqlite';
  dbName: string;
  dbFile: string;
  dbDir: string;
}

export const emptyNative = (): NativeAnswers => ({
  how: 'typed',
  name: '',
  workingDir: '',
  appDir: '',
  releaseLayout: false,
  adoptFolder: false,
  port: '',
  restartVia: 'service',
  restartTarget: '',
  scope: 'system',
  sudo: false,
  keepReleases: 5,
  build: '',
  shared: '',
  statePaths: [],
  dbEngine: '',
  dbName: '',
  dbFile: '',
  dbDir: '',
});

/** What the answers can say about an app that was found: the folder layout, how it is restarted, the first guess for the rest. */
export function nativeFromApp(app: NativeApp, buildHint = ''): NativeAnswers {
  const wd = (app.workingDir ?? '').replace(/\/$/, '');
  const layout = !!app.releaseLayout || wd.endsWith('/current');
  const via = app.manager === 'pm2' ? 'pm2' : app.manager === 'process' ? 'command' : 'service';
  const unit = app.name.replace(/\.service$/, '');
  return {
    how: app.manager,
    name: unit,
    workingDir: wd,
    appDir: layout ? wd.replace(/\/current$/, '') : wd ? `${wd}-app` : '',
    releaseLayout: layout,
    adoptFolder: false,
    port: app.ports[0] ? String(app.ports[0]) : '',
    restartVia: via,
    restartTarget: via === 'service' ? `${unit}.service` : via === 'pm2' ? app.name : '',
    scope: app.manager === 'systemd_user' ? 'user' : 'system',
    sudo: false,
    keepReleases: 5,
    build: buildHint,
    shared: '',
    statePaths: app.statePaths ?? [],
    dbEngine: '',
    dbName: '',
    dbFile: '',
    dbDir: wd ? `${wd}-app/backups` : '',
  };
}

/** The restart in plain words ("restart the service invoice-web.service"). */
export function restartWords(n: Pick<NativeAnswers, 'restartVia' | 'restartTarget'>): string {
  return n.restartVia === 'service'
    ? `restart the service ${n.restartTarget || '(name it)'}`
    : n.restartVia === 'pm2'
      ? `restart ${n.restartTarget || '(name it)'} with pm2`
      : `run ${n.restartTarget || '(your restart command)'}`;
}

/** The same sentence for a saved environment. */
export function directRestartWords(d: DirectApp): string {
  const m = d.manager;
  return m.kind === 'systemd'
    ? `restart the service ${m.unit}`
    : m.kind === 'pm2'
      ? `restart ${m.name} with pm2`
      : `run ${formatCommandLine(m.restart)}`;
}

export type Runtime = 'docker' | 'native';

export interface Stack {
  path: string;
  project?: string | undefined;
  services: ProbeComposeService[];
  containers: ProbeContainer[];
  volumes: string[];
  /** Something of it runs now. */
  running: boolean;
  /** Guildwise cannot update it yet (several compose files, --env-file, another project folder): why, in words. */
  unsupported?: string | undefined;
  /** The folder the running containers were started in (their `working_dir` label). */
  workingDir?: string | undefined;
  /**
   * Another checkout of the same compose project (same project name) than the one that is running: it is NOT what runs, so
   * it is listed apart ("other copies of this file, not running") and never preselected. The path of the running one.
   */
  copyOf?: string | undefined;
  /** Several copies with the same project name were found and none runs: the person must pick one explicitly. */
  mustPick?: boolean | undefined;
}

/** The home folder the report's absolute paths live under (`/home/user`), to compare `~/x` with `/home/user/x`. */
export function homeOfReport(report: ProbeReport | null | undefined): string | undefined {
  const paths = [
    ...(report?.composeFiles.map((c) => c.path) ?? []),
    ...(report?.containers.map((c) => c.composeFile ?? '') ?? []),
  ];
  for (const p of paths) {
    const m = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)\//.exec(p);
    if (m) return m[1];
  }
  return undefined;
}

/** A path with a leading `~` written out as the home folder, so `~/a` and `/home/u/a` compare equal. */
export function normPath(p: string, home: string | undefined): string {
  return home && (p === '~' || p.startsWith('~/')) ? `${home}${p.slice(1)}` : p;
}

/**
 * The compose stacks a report found, running ones first. A running stack takes its compose file and folder from the labels of its
 * containers: several checkouts of one repo share the compose project name, so the project name alone says nothing about which
 * file the running app was started from.
 */
export function stacksFromReport(report: ProbeReport | null | undefined): Stack[] {
  if (!report) return [];
  const home = homeOfReport(report);
  const norm = (p: string) => normPath(p, home);
  const files = report.composeFiles.filter((c: ProbeComposeFile) => !c.unreadable && c.services.length > 0);
  // the file each container was started from (its first config file label); some have none
  const labelled = report.containers.filter((k) => k.composeFile);
  const projectHasLabel = (project: string | undefined) =>
    !!project && labelled.some((k) => k.project === project);
  const stacks: Stack[] = files.map((c) => {
    const containers = report.containers.filter((k) =>
      k.composeFile
        ? norm(k.composeFile) === norm(c.path)
        : !!c.project && k.project === c.project && !projectHasLabel(c.project),
    );
    const running = containers.some((k) => k.state === 'running');
    const wd = containers.find((k) => k.workingDir)?.workingDir;
    return {
      path: running ? (containers.find((k) => k.composeFile)?.composeFile ?? c.path) : c.path,
      project: c.project,
      services: c.services,
      containers,
      volumes: c.volumes,
      running,
      workingDir: wd,
      unsupported: c.unsupported ?? containers.find((k) => k.unsupported)?.unsupported,
    };
  });
  // a running stack whose file the report did not list: borrow the parts of a sibling with the same project name
  for (const k of labelled) {
    const p = norm(k.composeFile as string);
    if (k.state !== 'running' || stacks.some((s) => norm(s.path) === p)) continue;
    const sibling = stacks.find((s) => s.project && s.project === k.project);
    if (!sibling) continue;
    const containers = labelled.filter((x) => norm(x.composeFile as string) === p);
    stacks.push({
      path: k.composeFile as string,
      project: k.project,
      services: sibling.services,
      containers,
      volumes: sibling.volumes,
      running: true,
      workingDir: containers.find((x) => x.workingDir)?.workingDir,
      unsupported: containers.find((x) => x.unsupported)?.unsupported,
    });
  }
  // other checkouts of a project that runs from somewhere else
  for (const s of stacks) {
    const runner = stacks.find((r) => r.running && r.project && r.project === s.project);
    if (!s.running && runner) s.copyOf = runner.path;
    else if (!s.running && s.project && stacks.filter((r) => r.project === s.project).length > 1)
      s.mustPick = true;
  }
  return stacks.sort(
    (a, b) =>
      Number(b.running) - Number(a.running) ||
      Number(!!a.copyOf) - Number(!!b.copyOf) ||
      (a.path < b.path ? -1 : 1),
  );
}

const isDb = (s: ProbeComposeService) => !!s.database && s.database !== 'redis';

/** The part built from the project's own code, else the first one that is not a database. */
export function guessAppService(stack: Stack): string {
  return (
    stack.services.find((s) => s.build)?.name ??
    stack.services.find((s) => !isDb(s) && s.image?.includes('${'))?.name ??
    stack.services.find((s) => !isDb(s))?.name ??
    stack.services[0]?.name ??
    ''
  );
}

export function guessDbService(stack: Stack): string {
  return stack.services.find((s) => s.database === 'postgres')?.name ?? '';
}

/** `guildwise-hq` from `guildwise-hq:4f2c1ab`, `demo-server` from `192.168.1.11:5000/demo-server:v1` (the registry is the registry field); a compose-built service has `<project>-<service>`. */
export function guessImageName(stack: Stack, service: string, serverImage?: string): string {
  const fromImage = parseImageRef(
    serverImage ?? stack.containers.find((c) => c.service === service)?.image ?? '',
  ).name;
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._/-]/g, '-')
      .replace(/^[^a-z0-9]+/, '');
  if (fromImage && /^[a-z0-9][a-z0-9._/-]*$/.test(fromImage) && !fromImage.includes('$')) return fromImage;
  return clean(`${stack.project ?? 'app'}-${service}`) || 'app';
}

/** `http://localhost:4700` from the port the app part publishes. */
export function guessAppUrl(stack: Stack, service: string): string {
  const c = stack.containers.find((k) => k.service === service && k.state === 'running');
  const p = c?.ports.find((x) => x.host && (!x.bind || x.bind === '0.0.0.0' || x.bind === '127.0.0.1'));
  return p?.host ? `http://localhost:${p.host}` : '';
}

/** Addresses that answered with a 2xx in the probe: safe candidates for the health check. */
export function healthyUrls(report: ProbeReport | null | undefined): string[] {
  return (report?.urls ?? [])
    .filter((u) => u.status !== null && u.status >= 200 && u.status < 300)
    .map((u) => u.url);
}

/** Addresses worth asking a server about: its proxy sites with the usual health paths. */
export function healthProbeUrls(report: ProbeReport | null | undefined): string[] {
  const sites = (report?.proxies ?? [])
    .flatMap((p) => p.sites)
    .filter((s) => /^[A-Za-z0-9.-]+$/.test(s) && s.includes('.'));
  return [...new Set(sites)]
    .slice(0, 3)
    .flatMap((s) => ['/ready', '/api/health', '/health'].map((p) => `https://${s}${p}`));
}

/** The run stopped because the app was started from another compose file than the one in the setup (the script's own words). */
export const ORIGIN_MISMATCH = /started from .+, not from /i;

/**
 * The compose file the app of `env` is running from, as the last probe saw it (the labels of its running container), when that
 * is not the file the setup names. Null when it is the same file, or the probe does not know.
 */
export function runningFileFor(env: SetupEnv, report: ProbeReport | null | undefined): string | null {
  if (!report || env.runtime === 'direct') return null;
  const home = homeOfReport(report);
  const wanted = normPath(env.app.composeFile, home);
  const project =
    env.app.composeProject ||
    report.composeFiles.find((c) => normPath(c.path, home) === wanted)?.project ||
    report.containers.find((c) => c.composeFile && normPath(c.composeFile, home) === wanted)?.project;
  const c = report.containers.find(
    (k) =>
      k.state === 'running' &&
      !!k.composeFile &&
      k.service === env.app.service &&
      (!project || k.project === project),
  );
  return c?.composeFile && normPath(c.composeFile, home) !== wanted ? c.composeFile : null;
}

/** The same failure in plain words (the script's sentence names paths that may be shortened). */
export function originMismatchSentence(env: SetupEnv, runningFile: string | null): string {
  return runningFile
    ? `The update did not start: the app is running from ${runningFile}, but this environment is set up with ${env.app.composeFile}, another copy of the same app. Nothing was changed.`
    : `The update did not start: the app is running from a different copy of the compose file than the one this environment is set up with (${env.app.composeFile}). Nothing was changed.`;
}

/** The usual health addresses of an app, best first. */
export const HEALTH_PATHS = ['/ready', '/api/health', '/health', '/'] as const;

/** The port the running app part publishes on the machine (`0.0.0.0:5500->500` is 5500), or null. */
export function publishedPort(stack: Stack | undefined, service: string): number | null {
  const c = stack?.containers.find((k) => k.service === service && k.state === 'running');
  const p = c?.ports.find((x) => x.host && x.bind !== '127.0.0.1' && x.bind !== '::1');
  return p?.host ?? null;
}

/** `http://192.168.1.13:5500` from the address of a server and the port its app part publishes; '' when either is unknown. */
export function serverAppBase(address: string | undefined, port: number | null): string {
  return address && port ? `http://${address}:${port}` : '';
}

/** The addresses to try for an app that answers on `base`: `base/ready`, `base/api/health`, `base/health`, `base`. */
export function healthCandidates(base: string): string[] {
  return base ? HEALTH_PATHS.map((p) => (p === '/' ? base : `${base}${p}`)) : [];
}

/** The first of `candidates` that answered with a 2xx in the report (a tested address), or ''. */
export function firstAnswering(report: ProbeReport | null | undefined, candidates: string[]): string {
  const ok = new Set(healthyUrls(report));
  return candidates.find((u) => ok.has(u)) ?? '';
}

/** `GUILDWISE_IMAGE` and its current value from the server's settings file, for the folder of a stack. */
export function imageVarOf(report: ProbeReport | null | undefined, stack: Stack | undefined) {
  const dir = stack ? stack.path.slice(0, stack.path.lastIndexOf('/')) : '';
  const f = report?.folders.find((x) => x.path === dir);
  const iv = f?.imageVars?.[0];
  return { name: iv?.name ?? f?.envKeys?.find((k) => /IMAGE/.test(k)) ?? '', value: iv?.value ?? '', dir };
}

export interface Answers {
  role: Purpose;
  /** Docker (a compose stack) or directly on the machine. */
  runtime: Runtime;
  native: NativeAnswers;
  /** How a new version gets onto a server. */
  method: UpdateMethod;
  registry: string;
  name: string;
  label: string;
  hosting: Hosting;
  /** The computer that deploys (and was probed). */
  workstationId: string;
  stackPath: string;
  /** The compose project name (so the scripts address the same stack Compose does). */
  composeProject: string;
  appService: string;
  dbService: string;
  imageName: string;
  appUrl: string;
  /** The address to check (empty: no health check, so no automatic rollback). */
  healthUrl: string;
  host: string;
  imageVar: string;
  backupDir: string;
  production: boolean;
  trigger: 'after_merge' | 'on_request';
  requireTestFirst: boolean;
  testEnv: string | null;
  targetName: string;
  secrets: string[];
  /** A command that updates the database with the new version before the app is restarted (empty: none). */
  migrateCmd: string;
}

export const emptyAnswers = (role: Purpose, label?: string, taken: string[] = []): Answers => {
  const title = label ?? (role === 'test' ? 'Test site' : role === 'live' ? 'Live site' : '');
  const name = slugName(title || 'site', taken);
  return {
    role,
    runtime: 'docker',
    native: emptyNative(),
    method: 'ship',
    registry: '',
    name,
    label: title,
    hosting: role === 'live' ? 'ssh' : 'this_computer',
    workstationId: '',
    stackPath: '',
    composeProject: '',
    appService: '',
    dbService: '',
    imageName: '',
    appUrl: '',
    healthUrl: '',
    host: '',
    imageVar: '',
    backupDir: '',
    production: role === 'live',
    trigger: role === 'live' ? 'on_request' : 'after_merge',
    requireTestFirst: true,
    testEnv: null,
    targetName: '',
    secrets: [],
    migrateCmd: '',
  };
};

function slugName(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'site';
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

/** The home-relative form of a path (`~/x`) when it sits under the home the probe reported (stored scripts are portable). */
export function tildePath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The structured environment the answers make. Throws nothing; the server compiles and checks it. */
export function buildEnv(a: Answers, homeDir?: string): SetupEnv {
  if (a.runtime === 'native') return buildNativeEnv(a);
  const test = a.role === 'live' ? a.testEnv : null;
  const database = a.dbService
    ? {
        // New setups default to ~/guildwise-backups; an existing environment keeps its stored dir (backupDir is loaded from it).
        service: a.dbService,
        dir: a.backupDir || (a.hosting === 'ssh' ? `${dirOf(a.stackPath)}/backups` : '~/guildwise-backups'),
        keep: 20,
      }
    : undefined;
  const env =
    a.hosting === 'ssh'
      ? sshShipEnv(
          {
            name: a.name,
            label: a.label,
            target: a.targetName,
            host: a.host,
            composeFile: a.stackPath,
            ...(a.composeProject ? { composeProject: a.composeProject } : {}),
            service: a.appService,
            imageName: a.imageName,
            ...(a.imageVar ? { imageVar: a.imageVar } : {}),
            method: a.method,
            ...(a.method === 'registry' && a.registry ? { registry: a.registry } : {}),
            ...(a.healthUrl ? { healthUrl: a.healthUrl } : {}),
            ...(a.appUrl ? { appUrl: a.appUrl } : {}),
            ...(database ? { database } : {}),
            secrets: a.secrets,
          },
          test,
        )
      : localAdoptEnv(
          {
            name: a.name,
            label: a.label,
            target: a.targetName,
            composeFile: tildePath(a.stackPath, homeDir),
            ...(a.composeProject ? { composeProject: a.composeProject } : {}),
            service: a.appService,
            imageName: a.imageName,
            ...(a.appUrl ? { appUrl: a.appUrl } : {}),
            ...(a.healthUrl ? { healthUrl: a.healthUrl.replace(a.appUrl, '${appUrl}') } : {}),
            ...(database ? { database: { ...database, dir: tildePath(database.dir, homeDir) } } : {}),
            secrets: a.secrets,
            testCopy: a.role !== 'live',
          },
          test,
        );
  const live = env.gate !== 'none' || a.role === 'live';
  const migrate = a.migrateCmd.trim() ? parseCommandLine(a.migrateCmd.trim()) : [];
  if (migrate.length > 0) {
    // the database updates run with the new version, before the app is restarted (and after the backup)
    const at = env.steps.findIndex((s) => s.kind === 'compose_up_local' || s.kind === 'compose_up_remote');
    env.steps.splice(at < 0 ? env.steps.length : at, 0, {
      kind: 'compose_run',
      label: 'Run database updates',
      argv: migrate,
    });
  }
  return {
    ...env,
    ...(a.role !== 'test' || (env as { role?: string }).role ? { role: a.role } : { role: a.role }),
    trigger: [a.trigger],
    // turning the safety nets off is a developer's decision (advanced view); the wizard keeps the gate the template made
    gate: live && !a.requireTestFirst ? 'none' : env.gate,
  };
}

/** The environment of an app that runs directly on the machine: the shared builder fills the steps (prepare, switch) and the rules. */
function buildNativeEnv(a: Answers): SetupEnv {
  const n = a.native;
  const port = Number(n.port) || null;
  const url = a.appUrl || (port ? `http://${a.hosting === 'ssh' ? a.host : 'localhost'}:${port}` : '');
  const manager: DirectManager =
    n.restartVia === 'service'
      ? {
          kind: 'systemd',
          unit: n.restartTarget.trim() || `${n.name}.service`,
          scope: n.scope,
          sudo: n.scope === 'system' && n.sudo,
        }
      : n.restartVia === 'pm2'
        ? { kind: 'pm2', name: n.restartTarget.trim() }
        : { kind: 'command', restart: parseCommandLine(n.restartTarget.trim()), sudo: n.sudo };
  const build = n.build
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ label: l.length > 60 ? `${l.slice(0, 57)}...` : l, argv: parseCommandLine(l) }));
  const env = directEnv(
    {
      name: a.name,
      label: a.label,
      target: a.targetName,
      ...(a.hosting === 'ssh' ? { host: a.host } : {}),
      appDir: n.appDir,
      ...(n.releaseLayout ? {} : n.workingDir ? { currentLink: n.workingDir } : {}),
      ...(n.adoptFolder ? { adoptFolder: true } : {}),
      manager,
      build,
      shared: n.shared.split(/[\s,]+/).filter(Boolean),
      keep: n.keepReleases,
      ...(a.healthUrl ? { healthUrl: a.healthUrl } : {}),
      ...(url ? { appUrl: url } : {}),
      ...(n.dbEngine
        ? {
            database: {
              engine: n.dbEngine,
              ...(n.dbEngine !== 'sqlite' && n.dbName ? { database: n.dbName } : {}),
              ...(n.dbEngine === 'sqlite' && n.dbFile ? { sqliteFile: n.dbFile } : {}),
              dir: n.dbDir || `${n.appDir}/backups`,
            },
          }
        : {}),
      live: a.role === 'live',
      appName: n.name,
    },
    a.role === 'live' ? a.testEnv : null,
  );
  return { ...env, trigger: [a.trigger], role: a.role };
}

/** The direct block of an environment, when it runs directly on the machine. */
export const nativeOf = (env: SetupEnv): DirectApp | null =>
  env.runtime === 'direct' && env.direct ? env.direct : null;

/** What the dialog asks again when someone edits an existing environment. */
export function answersFromEnv(env: SetupEnv, target: { production: boolean }): Answers {
  const db = env.steps.find((s) => s.kind === 'db_backup');
  const gate = env.gate;
  const testEnv =
    typeof gate === 'object'
      ? ((gate.requires.find((r) => 'envHealthy' in r) as { envHealthy?: string } | undefined)?.envHealthy ??
        null)
      : null;
  const nat = nativeOf(env);
  const mgr = nat?.manager;
  return {
    role: roleOf(env, target),
    runtime: nat ? 'native' : 'docker',
    native: nat
      ? {
          ...emptyNative(),
          how:
            mgr?.kind === 'pm2'
              ? 'pm2'
              : mgr?.kind === 'command'
                ? 'process'
                : mgr?.scope === 'user'
                  ? 'systemd_user'
                  : 'systemd',
          name: env.app.imageName,
          workingDir: nat.currentLink ?? `${nat.appDir}/current`,
          appDir: nat.appDir,
          releaseLayout: !nat.currentLink || nat.currentLink === `${nat.appDir}/current`,
          adoptFolder: !!nat.adoptFolder,
          port: /:(\d+)/.exec(env.app.appUrl ?? '')?.[1] ?? '',
          restartVia: mgr?.kind === 'pm2' ? 'pm2' : mgr?.kind === 'command' ? 'command' : 'service',
          restartTarget:
            mgr?.kind === 'pm2'
              ? mgr.name
              : mgr?.kind === 'command'
                ? formatCommandLine(mgr.restart)
                : (mgr?.unit ?? ''),
          scope: mgr?.kind === 'systemd' ? mgr.scope : 'system',
          sudo: mgr?.kind === 'systemd' || mgr?.kind === 'command' ? mgr.sudo : false,
          keepReleases: nat.keep,
          build: nat.build.map((b) => formatCommandLine(b.argv)).join('\n'),
          shared: nat.shared.join(' '),
          ...dbFrom(env),
        }
      : emptyNative(),
    method: env.hosting === 'ssh' ? updateMethodOf(env) : 'ship',
    registry: env.app.registry ?? '',
    name: env.name,
    label: env.label,
    hosting: env.hosting,
    workstationId: '',
    stackPath: env.app.composeFile,
    composeProject: env.app.composeProject ?? '',
    appService: env.app.service,
    dbService: db?.kind === 'db_backup' ? db.service : '',
    imageName: env.app.imageName,
    appUrl: env.app.appUrl ?? '',
    healthUrl: env.health.kind === 'http' ? env.health.url : '',
    host: env.host ?? '',
    imageVar: env.app.imageVar ?? '',
    backupDir: db?.kind === 'db_backup' ? db.dir : '',
    production: target.production,
    trigger: env.trigger[0] === 'after_merge' ? 'after_merge' : 'on_request',
    requireTestFirst: typeof gate === 'object' && gate.requires.length > 0,
    testEnv,
    targetName: env.target,
    secrets: env.secrets,
    migrateCmd: (() => {
      const s = env.steps.find((x) => x.kind === 'compose_run');
      return s?.kind === 'compose_run' ? formatCommandLine(s.argv) : '';
    })(),
  };
}

/** Replaces (or appends) an environment of a setup. */
export function withEnv(setup: DeliverySetup | null, env: SetupEnv): { environments: SetupEnv[] } {
  const others = (setup?.environments ?? []).filter((e) => e.name !== env.name);
  const all = [...others, env];
  // an environment with a rule about another one comes after it (a gate may name an earlier environment)
  const gated = (e: SetupEnv) => Number(typeof e.gate === 'object' && e.gate.requires.length > 0);
  all.sort((a, b) => gated(a) - gated(b));
  return { environments: all };
}

// ------------------------------------------------------------------------------------------------ words

export const CONNECTION_TEXT: Record<
  ConnectionState,
  { text: string; tone: 'green' | 'amber' | 'red' | 'neutral' }
> = {
  reachable: { text: 'Can sign in', tone: 'green' },
  asks_password: { text: 'Asks for a password', tone: 'amber' },
  unreachable: { text: 'Server not reachable', tone: 'red' },
  host_key_unknown: { text: 'Never connected before', tone: 'amber' },
  host_key_changed: { text: 'Server identity changed', tone: 'red' },
  unchecked: { text: 'Not checked', tone: 'neutral' },
};

/** Lint items in plain words. */
export function plainLint(l: { code: string; message: string; level: string }): string {
  switch (l.code) {
    case 'production_no_gate':
      return 'The live site must not update automatically without a rule: it needs your release or the "test copy healthy first" rule.';
    case 'unknown_target':
      return `${l.message.replace(/^[^:]*: /, '')} Add the place it deploys to first.`;
    case 'hand_edited':
      return l.message;
    case 'secret_in_file':
      return 'A file would contain a password or key. Passwords stay on the computer and are never saved in the project.';
    case 'runner_update_needed':
      return `${l.message.replace(/\.$/, '')}. Update it first: saving and releases both need the newer version.`;
    case 'unknown_env_in_gate':
      return 'The live site waits for a test copy that is not in this setup.';
    default:
      return l.message;
  }
}

/** A short sentence for the "when does it update" choice. */
export function whenText(trigger: string): string {
  return trigger === 'after_merge'
    ? 'Automatically after changes are merged (it waits 2 minutes so a few merges become one update)'
    : 'Only when you press Release';
}

const dbFrom = (env: SetupEnv): Pick<NativeAnswers, 'dbEngine' | 'dbName' | 'dbFile' | 'dbDir'> => {
  const b = env.steps.find((x) => x.kind === 'direct_db_backup');
  return b?.kind === 'direct_db_backup'
    ? { dbEngine: b.engine, dbName: b.database ?? '', dbFile: b.sqliteFile ?? '', dbDir: b.dir }
    : { dbEngine: '', dbName: '', dbFile: '', dbDir: '' };
};

/** The state paths of a folder that is adopted and that are not in the shared list yet. */
export const missingShared = (
  n: Pick<NativeAnswers, 'statePaths' | 'shared' | 'releaseLayout' | 'workingDir'>,
): string[] => {
  if (n.releaseLayout || !n.workingDir) return [];
  const have = new Set(n.shared.split(/[\s,]+/).filter(Boolean));
  return n.statePaths.filter((p) => !have.has(p));
};
