import type { ChangeGroup } from '@aom/shared';
import {
  type ConnectionState,
  type DeliverySetup,
  formatCommandLine,
  localAdoptEnv,
  type ProbeComposeFile,
  type ProbeComposeService,
  type ProbeContainer,
  type ProbeReport,
  parseCommandLine,
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

/** An app that runs directly on the machine: found as a system service, a pm2 process or a running program, or typed in. */
export interface NativeApp {
  kind: 'systemd' | 'pm2' | 'process';
  name: string;
  folder: string;
  port: number | null;
  user?: string | undefined;
  running: boolean;
  /** The command that restarts it, when it is known (a service or a pm2 name). */
  restart: string | null;
}

/** The apps a probe found that run directly on the machine (not in Docker). */
export function nativeAppsFromReport(report: ProbeReport | null | undefined): NativeApp[] {
  return ((report as { nativeApps?: NativeApp[] } | null | undefined)?.nativeApps ?? []).filter(
    (a) => a.kind !== 'process' || a.port !== null || !!a.folder,
  );
}

export interface NativeAnswers {
  how: 'systemd' | 'pm2' | 'process' | 'typed';
  name: string;
  folder: string;
  port: string;
  restartVia: 'service' | 'pm2' | 'command';
  restartTarget: string;
  keepReleases: number;
}

export const emptyNative = (): NativeAnswers => ({
  how: 'typed',
  name: '',
  folder: '',
  port: '',
  restartVia: 'service',
  restartTarget: '',
  keepReleases: 5,
});

/** How an app found on the machine is restarted, as the first guess. */
export function nativeFromApp(app: NativeApp): NativeAnswers {
  const via = app.kind === 'systemd' ? 'service' : app.kind === 'pm2' ? 'pm2' : 'command';
  return {
    how: app.kind,
    name: app.name,
    folder: app.folder,
    port: app.port ? String(app.port) : '',
    restartVia: via,
    restartTarget:
      app.kind === 'systemd'
        ? `${app.name}.service`.replace(/\.service\.service$/, '.service')
        : app.kind === 'pm2'
          ? app.name
          : '',
    keepReleases: 5,
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

export type Runtime = 'docker' | 'native';

export interface Stack {
  path: string;
  project?: string | undefined;
  services: ProbeComposeService[];
  containers: ProbeContainer[];
  volumes: string[];
  /** Something of it runs now. */
  running: boolean;
}

/** The compose stacks a report found, running ones first. */
export function stacksFromReport(report: ProbeReport | null | undefined): Stack[] {
  if (!report) return [];
  const out = report.composeFiles
    .filter((c: ProbeComposeFile) => !c.unreadable && c.services.length > 0)
    .map((c) => {
      const containers = report.containers.filter(
        (k) => (c.project && k.project === c.project) || k.composeFile === c.path,
      );
      return {
        path: c.path,
        project: c.project,
        services: c.services,
        containers,
        volumes: c.volumes,
        running: containers.some((k) => k.state === 'running'),
      };
    });
  return out.sort((a, b) => Number(b.running) - Number(a.running) || (a.path < b.path ? -1 : 1));
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

/** `guildwise-hq` from `guildwise-hq:4f2c1ab`; a compose-built service has `<project>-<service>`. */
export function guessImageName(stack: Stack, service: string, serverImage?: string): string {
  const fromImage = (serverImage ?? stack.containers.find((c) => c.service === service)?.image ?? '').split(
    ':',
  )[0];
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
        service: a.dbService,
        dir: a.backupDir || (a.hosting === 'ssh' ? `${dirOf(a.stackPath)}/backups` : '~/aom-backups'),
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

/**
 * An app that runs directly on the machine. The environment keeps the same shape as the others (a place, an update rule, the
 * rules); how it is updated is the `runtime` block: get the new version, build it in a new folder, switch to it, restart.
 * ASSUMPTION until the API contract (section 13) names the real field.
 */
function buildNativeEnv(a: Answers): SetupEnv {
  const n = a.native;
  const compose = `${n.folder.replace(/\/$/, '')}/docker-compose.yml`;
  const port = Number(n.port) || null;
  const url = a.appUrl || (port ? `http://${a.hosting === 'ssh' ? a.host : 'localhost'}:${port}` : '');
  const base =
    a.hosting === 'ssh'
      ? sshShipEnv(
          {
            name: a.name,
            label: a.label,
            target: a.targetName,
            host: a.host,
            composeFile: compose,
            service: 'app',
            imageName: 'app',
            ...(url ? { appUrl: url } : {}),
          },
          a.role === 'live' ? a.testEnv : null,
        )
      : localAdoptEnv(
          {
            name: a.name,
            label: a.label,
            target: a.targetName,
            composeFile: compose,
            service: 'app',
            imageName: 'app',
            ...(url ? { appUrl: url } : {}),
            testCopy: a.role !== 'live',
          },
          a.role === 'live' ? a.testEnv : null,
        );
  return {
    ...base,
    steps: [],
    trigger: [a.trigger],
    role: a.role,
    runtime: {
      kind: 'native',
      how: n.how,
      name: n.name,
      folder: n.folder,
      port,
      restart: { via: n.restartVia, target: n.restartTarget },
      keepReleases: n.keepReleases,
    },
  } as unknown as SetupEnv;
}

/** The native block of an environment, when it runs directly on the machine. */
export const nativeOf = (
  env: SetupEnv,
): {
  how: NativeAnswers['how'];
  name: string;
  folder: string;
  port: number | null;
  restart: { via: NativeAnswers['restartVia']; target: string };
  keepReleases: number;
} | null => {
  const r = (env as unknown as { runtime?: { kind?: string } }).runtime;
  return r?.kind === 'native' ? (r as never) : null;
};

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
  return {
    role: roleOf(env, target),
    runtime: nat ? 'native' : 'docker',
    native: nat
      ? {
          how: nat.how,
          name: nat.name,
          folder: nat.folder,
          port: nat.port ? String(nat.port) : '',
          restartVia: nat.restart.via,
          restartTarget: nat.restart.target,
          keepReleases: nat.keepReleases,
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

/** "Found / Each update will / Will not be touched" for an app that runs directly on the machine. */
export function nativeChangeItems(a: Answers): Array<{ group: ChangeGroup; text: string; env: string }> {
  const n = a.native;
  const env = a.name;
  const where = a.hosting === 'ssh' ? `the server ${a.host}` : 'this computer';
  const items: Array<{ group: ChangeGroup; text: string; env: string }> = [];
  if (n.name || n.folder)
    items.push({
      group: 'reuse',
      text: `${n.name || 'The app'}${n.folder ? ` in ${n.folder}` : ''} on ${where} is used as it is`,
      env,
    });
  if (!n.name || !n.folder) items.push({ group: 'question', text: 'Name the app and its folder', env });
  if (!n.restartTarget.trim()) items.push({ group: 'question', text: 'Say how the app is restarted', env });
  items.push(
    { group: 'each_deploy', text: 'Get the new version of the code', env },
    { group: 'each_deploy', text: 'Build it in a new folder next to the current one', env },
    { group: 'each_deploy', text: 'Switch to the new version', env },
    { group: 'each_deploy', text: `Then ${restartWords(n)} and check the app answers`, env },
    { group: 'each_deploy', text: `Keep the last ${n.keepReleases} versions so you can go back`, env },
    { group: 'untouched', text: 'Your data, your settings files and everything else on the machine', env },
  );
  return items;
}
