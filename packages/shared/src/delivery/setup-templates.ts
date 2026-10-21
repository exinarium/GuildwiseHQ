import type { Gate } from './gate.ts';
import type { DeployStep, DirectManager, SetupEnv, UpdateMethod } from './setup.ts';

/**
 * The deploy templates the wizard fills from the probe and the person's answers (design sections 2 and 4.2): "this computer,
 * use the stack that is already there" and "a server, build here and ship over ssh". They only produce the structured
 * environment; `compileSetup` turns it into scripts. The safe defaults of requirement 7 live here.
 */

/** Test copy: updates after a merge (the existing 2 minute debounce), released by a rule, no gate. */
export const TEST_COPY_DEFAULTS = {
  trigger: ['after_merge'] as SetupEnv['trigger'],
  releasedBy: 'auto' as const,
  gate: 'none' as const,
};

/** How long the test copy must have been healthy on the same version before the live site may follow. */
export const PRODUCTION_GATE_MINUTES = 10;

/** Live site: only on request, the Owner releases it, and the test copy must be healthy on the same version for 10 minutes. */
export function productionDefaults(testEnv: string | null): {
  trigger: SetupEnv['trigger'];
  releasedBy: 'owner';
  gate: Gate | 'none';
} {
  return {
    trigger: ['on_request'],
    releasedBy: 'owner',
    gate: testEnv
      ? { requires: [{ envHealthy: testEnv, sameCommit: true, forMinutes: PRODUCTION_GATE_MINUTES }] }
      : 'none',
  };
}

export interface DatabaseAnswers {
  /** The compose service that runs the database. */
  service: string;
  /** A folder for the backups (this computer, or on the server). */
  dir: string;
  keep?: number;
}

export interface LocalAdoptAnswers {
  name: string;
  label: string;
  target: string;
  composeFile: string;
  composeProject?: string;
  service: string;
  imageName: string;
  appUrl?: string;
  /** Address the script and Guildwise poll; default `<appUrl>/api/health`. */
  healthUrl?: string;
  database?: DatabaseAnswers;
  imageKeep?: number;
  secrets?: string[];
  envFile?: string;
  testCopy?: boolean;
}

/** "On this computer: use the stack that is already there". Rebuilds only the app service, from the approved version. */
export function localAdoptEnv(a: LocalAdoptAnswers, testEnv: string | null = null): SetupEnv {
  const steps: DeployStep[] = [
    ...(a.database
      ? [
          {
            kind: 'db_backup' as const,
            service: a.database.service,
            dir: a.database.dir,
            keep: a.database.keep ?? 20,
          },
        ]
      : []),
    { kind: 'compose_up_local' as const },
  ];
  const defaults = a.testCopy === false ? productionDefaults(testEnv) : TEST_COPY_DEFAULTS;
  return {
    name: a.name,
    label: a.label,
    target: a.target,
    mode: 'guided',
    hosting: 'this_computer',
    app: {
      composeFile: a.composeFile,
      ...(a.composeProject ? { composeProject: a.composeProject } : {}),
      service: a.service,
      imageName: a.imageName,
      imageKeep: a.imageKeep ?? 5,
      ...(a.appUrl ? { appUrl: a.appUrl } : {}),
    },
    steps,
    health: a.healthUrl
      ? { kind: 'http', url: a.healthUrl, expect: '2xx' }
      : a.appUrl
        ? { kind: 'http', url: '${appUrl}/api/health', expect: '2xx' }
        : { kind: 'none', graceSec: 5 },
    healthTimeoutSec: 120,
    rollback: !!(a.healthUrl || a.appUrl),
    trigger: defaults.trigger,
    releasedBy: defaults.releasedBy,
    gate: defaults.gate,
    secrets: a.secrets ?? [],
    ...(a.envFile ? { envFile: a.envFile } : {}),
    timeoutSec: 1800,
  };
}

export interface SshShipAnswers {
  name: string;
  label: string;
  target: string;
  /** The ssh alias. */
  host: string;
  /** Compose file on the server, for example `/opt/app/docker-compose.yml`. */
  composeFile: string;
  composeProject?: string;
  service: string;
  imageName: string;
  /** The `.env` key that pins the image. Absent: the new version is named in `docker-compose.guildwise.yml` next to the compose file. */
  imageVar?: string;
  /** How the new version reaches the server (default: built here and copied over ssh). */
  method?: UpdateMethod;
  /** `registry`: the registry address, and whether this computer builds and uploads (default) or CI already did. */
  registry?: string;
  registryPush?: boolean;
  /** `build_on_server`: where the files are put on the server. */
  sourceDir?: string;
  healthUrl?: string;
  /** The address of the site: its home page is checked when there is no health address of its own. */
  appUrl?: string;
  database?: DatabaseAnswers;
  secrets?: string[];
  envFile?: string;
}

/** "A server: build here, ship over ssh". Reproduces the manual release procedure step by step. */
export function sshShipEnv(a: SshShipAnswers, testEnv: string | null = null): SetupEnv {
  const d = productionDefaults(testEnv);
  const method = a.method ?? 'ship';
  const steps: DeployStep[] = [
    ...(a.database
      ? [
          {
            kind: 'db_backup' as const,
            service: a.database.service,
            dir: a.database.dir,
            keep: a.database.keep ?? 20,
          },
        ]
      : []),
    ...(a.imageVar ? [{ kind: 'env_backup' as const }] : []),
    ...(method === 'ship'
      ? [{ kind: 'build_image_local' as const }, { kind: 'ship_image_ssh' as const }]
      : method === 'registry'
        ? [
            ...(a.registryPush === false
              ? []
              : [{ kind: 'build_image_local' as const }, { kind: 'push_image_registry' as const }]),
            { kind: 'pull_image_ssh' as const },
          ]
        : [{ kind: 'ship_source_ssh' as const }, { kind: 'build_image_server' as const }]),
    a.imageVar ? { kind: 'set_image_var' as const } : { kind: 'write_override' as const },
    { kind: 'compose_up_remote' as const },
  ];
  return {
    name: a.name,
    label: a.label,
    target: a.target,
    mode: 'guided',
    hosting: 'ssh',
    host: a.host,
    app: {
      composeFile: a.composeFile,
      ...(a.composeProject ? { composeProject: a.composeProject } : {}),
      service: a.service,
      imageName: a.imageName,
      ...(a.imageVar ? { imageVar: a.imageVar } : {}),
      ...(method === 'registry' && a.registry ? { registry: a.registry } : {}),
      ...(method === 'build_on_server' && a.sourceDir ? { sourceDir: a.sourceDir } : {}),
      // only used when deploying on this computer (a server is not pruned)
      imageKeep: 5,
      ...(a.appUrl ? { appUrl: a.appUrl } : {}),
    },
    steps,
    health: a.healthUrl
      ? { kind: 'http', url: a.healthUrl, expect: '2xx' }
      : a.appUrl
        ? { kind: 'http', url: '${appUrl}/', expect: '2xx3xx' }
        : { kind: 'none', graceSec: 10 },
    healthTimeoutSec: 120,
    rollback: !!(a.healthUrl || a.appUrl),
    trigger: d.trigger,
    releasedBy: d.releasedBy,
    gate: d.gate,
    secrets: a.secrets ?? [],
    ...(a.envFile ? { envFile: a.envFile } : {}),
    timeoutSec: 3600,
  };
}

export interface DirectAnswers {
  name: string;
  label: string;
  target: string;
  /** The ssh alias; absent: the app runs on this computer. */
  host?: string;
  /** The folder that holds `releases/` and the link to the running version. */
  appDir: string;
  /** Where the link lives (default `<appDir>/current`); the service must start from here. */
  currentLink?: string;
  /** The person confirmed that a plain folder at `currentLink` may become the first release. */
  adoptFolder?: boolean;
  manager: DirectManager;
  build?: Array<{ label: string; argv: string[] }>;
  shared?: string[];
  keep?: number;
  /** Back up this database first (uses the signed-in user's own access to it). */
  database?: { engine: 'postgres' | 'mysql' | 'sqlite'; database?: string; sqliteFile?: string; dir: string; keep?: number };
  healthUrl?: string;
  appUrl?: string;
  /** A live site (owner releases, gated) rather than a test site (updates after each merge). */
  live?: boolean;
  /** Label of the app (shown); default the unit or process name. */
  appName?: string;
}

/** "The app runs directly on the machine": a new folder per version, a link switched in one step, a restart by the detected manager. */
export function directEnv(a: DirectAnswers, testEnv: string | null = null): SetupEnv {
  const defaults = a.live ? productionDefaults(testEnv) : TEST_COPY_DEFAULTS;
  const steps: DeployStep[] = [
    ...(a.database
      ? [
          {
            kind: 'direct_db_backup' as const,
            engine: a.database.engine,
            ...(a.database.database ? { database: a.database.database } : {}),
            ...(a.database.sqliteFile ? { sqliteFile: a.database.sqliteFile } : {}),
            dir: a.database.dir,
            keep: a.database.keep ?? 20,
          },
        ]
      : []),
    { kind: 'direct_prepare' as const },
    { kind: 'direct_switch' as const },
  ];
  const unit = a.manager.kind === 'systemd' ? a.manager.unit.replace(/\.service$/, '') : a.manager.kind === 'pm2' ? a.manager.name : 'app';
  const name = (a.appName ?? unit).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '') || 'app';
  return {
    name: a.name,
    label: a.label,
    target: a.target,
    mode: 'guided',
    hosting: a.host ? 'ssh' : 'this_computer',
    ...(a.host ? { host: a.host } : {}),
    runtime: 'direct',
    direct: {
      appDir: a.appDir,
      ...(a.currentLink ? { currentLink: a.currentLink } : {}),
      ...(a.adoptFolder ? { adoptFolder: true } : {}),
      keep: a.keep ?? 5,
      build: a.build ?? [],
      manager: a.manager,
      shared: a.shared ?? [],
    },
    app: {
      composeFile: a.appDir,
      service: a.manager.kind === 'systemd' ? a.manager.unit : a.manager.kind === 'pm2' ? a.manager.name : unit,
      imageName: name,
      imageKeep: 5,
      ...(a.appUrl ? { appUrl: a.appUrl } : {}),
    },
    steps,
    health: a.healthUrl
      ? { kind: 'http', url: a.healthUrl, expect: '2xx' }
      : a.appUrl
        ? { kind: 'http', url: '${appUrl}/', expect: '2xx3xx' }
        : { kind: 'none', graceSec: 10 },
    healthTimeoutSec: 120,
    rollback: !!(a.healthUrl || a.appUrl),
    trigger: defaults.trigger,
    releasedBy: defaults.releasedBy,
    gate: defaults.gate,
    secrets: [],
    timeoutSec: 3600,
  };
}
