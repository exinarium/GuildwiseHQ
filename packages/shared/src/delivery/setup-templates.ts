import type { Gate } from './gate.ts';
import type { DeployStep, SetupEnv } from './setup.ts';

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
  /** The `.env` key that pins the image. */
  imageVar: string;
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
    { kind: 'env_backup' as const },
    { kind: 'build_image_local' as const },
    { kind: 'ship_image_ssh' as const },
    { kind: 'set_image_var' as const },
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
      imageVar: a.imageVar,
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
