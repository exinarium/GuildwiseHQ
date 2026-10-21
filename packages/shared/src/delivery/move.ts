import { z } from 'zod';
import { DomainSchema } from './connect.ts';
import {
  ComposeProjectSchema,
  EnvVarNameSchema,
  ImageNameSchema,
  RemotePathSchema,
  ServiceNameSchema,
  type SetupEnv,
  SshAliasSchema,
} from './setup.ts';

/**
 * Moving to a new server (docs/design/deploy-run-ux-design.md J6, phase v3). A move copies the settings and the image, stops the
 * app on the old server, takes a last database backup there, restores it on the new one, starts the app and checks it. Then the
 * person points the domain at the new server (with a live DNS check) and confirms. The old server stays as a standby (fallback)
 * until the Owner retires it; retiring removes the keys Guildwise added and deletes nothing.
 *
 * Everything here is data and pure functions. The runner code that touches `ssh` is apps/runner/src/delivery/move.ts.
 */

/** Announced by a runner that answers `deploy.move`. */
export const DEPLOY_MOVE_CAPABILITY = 'deploy-move:1';

/** `active`: the one that is deployed to. `standby`: the old server after a move (a fallback, never deployed to). `retired`: let go. */
export const TARGET_ROLES = ['active', 'standby', 'retired'] as const;
export const TargetRoleSchema = z.enum(TARGET_ROLES);
export type TargetRole = z.infer<typeof TargetRoleSchema>;

// ------------------------------------------------------------------------------------------------ steps

/** Read-only look at both servers: nothing changes. */
export const MOVE_STEPS = [
  'check',
  'copy_config',
  'copy_image',
  'start_database',
  'stop_and_backup',
  'restore',
  'start_app',
  /** Undo: start the old app again and stop the new one (used by "Go back" and after a failed restore). */
  'restart_old',
  /** The Owner let the old server go: remove every key Guildwise added there. Nothing else is touched. */
  'retire_keys',
] as const;
export const MoveStepSchema = z.enum(MOVE_STEPS);
export type MoveStep = z.infer<typeof MoveStepSchema>;

/** Steps that change nothing on the old server: they run as soon as the move starts, before the person agrees to the downtime. */
export const PREPARE_STEPS = ['check', 'copy_config', 'copy_image', 'start_database'] as const;
/** Steps that take the old app down: they run after the person agrees. */
export const SWITCH_STEPS = ['stop_and_backup', 'restore', 'start_app'] as const;

export const MOVE_STEP_TEXT: Record<MoveStep, { title: string; doing: string }> = {
  check: { title: 'Look at both servers', doing: 'Looking at both servers' },
  copy_config: {
    title: 'Copy the app’s settings',
    doing: 'Copying the settings file to the new server (nothing is shown)',
  },
  copy_image: { title: 'Copy the app', doing: 'Copying the app itself to the new server' },
  start_database: { title: 'Start the database on the new server', doing: 'Starting the database' },
  stop_and_backup: {
    title: 'Stop the old app and take a last backup',
    doing: 'Stopping the app on the old server and saving a last backup',
  },
  restore: {
    title: 'Put the data on the new server',
    doing: 'Restoring the backup on the new server',
  },
  start_app: { title: 'Start the app on the new server', doing: 'Starting the app and checking it' },
  restart_old: {
    title: 'Start the old app again',
    doing: 'Starting the app on the old server again',
  },
  retire_keys: {
    title: 'Remove the Guildwise keys from the old server',
    doing: 'Removing the keys Guildwise added',
  },
};

// ------------------------------------------------------------------------------------------------ spec

/** `/ready` or `/api/health?x=1`: a path for the health check on the new server's own address. */
export const HealthPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/[A-Za-z0-9._~/%&=+,?-]*$/, 'a path like /ready');

/**
 * What the runner needs to know about the app, taken from the approved guided setup (never from the browser): where the compose
 * file is, which part is the app and which the database, where backups go. Both servers use the same layout.
 */
export const MoveSpecSchema = z.object({
  from: z.object({ targetId: z.uuid(), alias: SshAliasSchema }),
  to: z.object({ targetId: z.uuid(), alias: SshAliasSchema }),
  composeFile: RemotePathSchema,
  composeProject: ComposeProjectSchema.optional(),
  appService: ServiceNameSchema,
  imageVar: EnvVarNameSchema,
  imageName: ImageNameSchema.optional(),
  dbService: ServiceNameSchema,
  dbUser: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,63}$/)
    .optional(),
  dbName: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,63}$/)
    .optional(),
  backupDir: RemotePathSchema,
  healthPath: HealthPathSchema.optional(),
});
export type MoveSpec = z.infer<typeof MoveSpecSchema>;

export type MoveSpecResult = { ok: true; spec: MoveSpec } | { ok: false; blockers: string[] };

/**
 * The move spec of one guided environment. Pure: a setup that cannot be moved safely answers with plain-words blockers
 * (a hand-written script, no database backup step, ...).
 */
export function buildMoveSpec(
  env: SetupEnv,
  from: { targetId: string; alias: string },
  to: { targetId: string; alias: string },
): MoveSpecResult {
  const blockers: string[] = [];
  if (env.mode === 'custom')
    blockers.push(
      'This part of the deploy was edited by hand. Moving needs the guided setup, because Guildwise has to know which part is the database.',
    );
  if (env.hosting !== 'ssh') blockers.push('Only an app on a server can be moved to a new server.');
  const backup = env.steps.find((s) => s.kind === 'db_backup');
  if (!backup)
    blockers.push(
      'The setup has no database backup step, so Guildwise cannot tell which part is the database. Add the backup step first (Show technical details).',
    );
  if (!env.app.imageVar)
    blockers.push('The setup does not say which setting holds the app’s version (the image).');
  if (env.app.composeFile.startsWith('~')) blockers.push('The compose file needs a full path on the server.');
  if (blockers.length || !backup || backup.kind !== 'db_backup' || !env.app.imageVar)
    return { ok: false, blockers };
  let healthPath: string | undefined;
  if (env.health.kind === 'http') {
    const m = /^(?:https?:\/\/[^/]+|\$\{appUrl\})(\/[^#]*)?$/.exec(env.health.url);
    const p = m?.[1] ?? '/';
    if (HealthPathSchema.safeParse(p).success) healthPath = p;
  }
  const spec = MoveSpecSchema.safeParse({
    from,
    to,
    composeFile: env.app.composeFile,
    ...(env.app.composeProject ? { composeProject: env.app.composeProject } : {}),
    appService: env.app.service,
    imageVar: env.app.imageVar,
    imageName: env.app.imageName,
    dbService: backup.service,
    ...(backup.dbUser ? { dbUser: backup.dbUser } : {}),
    ...(backup.dbName ? { dbName: backup.dbName } : {}),
    backupDir: backup.dir,
    ...(healthPath ? { healthPath } : {}),
  });
  if (!spec.success)
    return {
      ok: false,
      blockers: [
        `The setup has a value that cannot be used for a move: ${spec.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
          .slice(0, 300)}`,
      ],
    };
  return { ok: true, spec: spec.data };
}

// ------------------------------------------------------------------------------------------------ the command

export const DeployMovePayloadSchema = z.object({
  projectId: z.uuid(),
  moveId: z.uuid(),
  step: MoveStepSchema,
  spec: MoveSpecSchema,
  /** What earlier steps of this move found (the server keeps it; the computer is stateless between steps). */
  context: z
    .object({
      backupFile: RemotePathSchema.optional(),
      appPort: z.number().int().min(1).max(65535).optional(),
    })
    .default({}),
});
export type DeployMovePayload = z.infer<typeof DeployMovePayloadSchema>;

export const MOVE_ERRORS = [
  'old_unreachable',
  'new_unreachable',
  'timeout',
  'blocked',
  'config_differs',
  'image_missing',
  'database_not_ready',
  'backup_failed',
  'new_database_not_empty',
  'restore_failed',
  'app_not_healthy',
  'failed',
  'bad_request',
] as const;
export const MoveErrorSchema = z.enum(MOVE_ERRORS);
export type MoveError = z.infer<typeof MoveErrorSchema>;

export const MoveCheckSchema = z.object({
  id: z.string().max(40),
  ok: z.boolean(),
  /** Plain words, no secret values. */
  text: z.string().max(300),
});
export type MoveCheck = z.infer<typeof MoveCheckSchema>;

export const MoveFactsSchema = z
  .object({
    /** The app image running on the old server (a name and tag; never a secret). */
    image: z.string().max(200).optional(),
    /** The port the app is published on (the same on the new server). */
    appPort: z.number().int().min(1).max(65535).optional(),
    /** Names of the settings in the settings file, counted, never the values. */
    settingsCount: z.number().int().min(0).optional(),
    /** The last backup, on the OLD server. */
    backupFile: z.string().max(300).optional(),
    backupBytes: z.number().int().min(0).optional(),
    /** How many tables the old and new databases hold after the restore. */
    tablesOld: z.number().int().min(0).optional(),
    tablesNew: z.number().int().min(0).optional(),
    /** The new app answered its health address (`null`: it could not be asked, the app is running). */
    healthy: z.boolean().nullable().optional(),
    healthStatus: z.number().int().optional(),
    /** Public IPv4 addresses are resolved by the server, not the computer. */
    removedKeys: z.number().int().min(0).optional(),
    keysBackup: z.string().max(300).optional(),
    /**
     * Set by the SERVER, never by a computer: the "stop the old app and back up" step failed without saying the app is running
     * (a timeout, a lost connection), so the old app may be stopped. A cancel then runs the undo (idempotent). Cleared by a step
     * that knows (the stop succeeded, the app is reported running, or the undo worked).
     */
    oldAppUnknown: z.boolean().optional(),
  })
  .strict();
export type MoveFacts = z.infer<typeof MoveFactsSchema>;

export const DeployMoveResultSchema = z.object({
  ok: z.boolean(),
  step: MoveStepSchema,
  error: MoveErrorSchema.optional(),
  detail: z.string().max(400).optional(),
  checks: z.array(MoveCheckSchema).max(30).default([]),
  facts: MoveFactsSchema.default({}),
  /** After a failure: is the app running on the old server (the site works as before)? */
  oldAppRunning: z.boolean().optional(),
  /** Was a step skipped because it was already done (a retry)? */
  skipped: z.boolean().optional(),
});
export type DeployMoveResult = z.infer<typeof DeployMoveResultSchema>;

export function moveErrorText(error: MoveError, detail?: string): string {
  const d = detail ? ` (${detail})` : '';
  switch (error) {
    case 'old_unreachable':
      return `This computer cannot sign in to the old server${d}.`;
    case 'new_unreachable':
      return `This computer cannot sign in to the new server${d}.`;
    case 'timeout':
      return 'A server did not answer in time. Nothing was lost: try again.';
    case 'blocked':
      return detail ?? 'Something has to be fixed before the move can start.';
    case 'config_differs':
      return `The new server already has a different settings file or compose file in that folder${d}. Guildwise will not overwrite it. Remove or rename it, then try again.`;
    case 'image_missing':
      return `The app image could not be found on the old server${d}.`;
    case 'database_not_ready':
      return `The database on the new server did not start${d}.`;
    case 'backup_failed':
      return `The last backup on the old server failed${d}. The old app was started again; nothing changed.`;
    case 'new_database_not_empty':
      return 'The database on the new server already has data in it, so Guildwise will not restore over it. Use a new, empty database.';
    case 'restore_failed':
      return `Putting the data on the new server failed${d}. Nothing was applied there. The old app was started again.`;
    case 'app_not_healthy':
      return `The app on the new server did not answer${d}. The data is on the new server and the old app is still stopped: try again, or go back to the old server.`;
    case 'failed':
      return `That step failed${d}.`;
    case 'bad_request':
      return detail ?? 'That could not be started.';
  }
}

// ------------------------------------------------------------------------------------------------ states

export const MOVE_STATES = [
  /** Looking at both servers and getting the new one ready (nothing changes on the old one). */
  'preparing',
  /** The new server is ready; waiting for the person to agree to the short downtime. */
  'ready',
  /** Stopping the old app, backing up, restoring, starting the new app. */
  'moving',
  /** The new app runs and answers; waiting for the domain and the confirmation. */
  'app_ready',
  'completed',
  'failed',
  'cancelled',
] as const;
export const MoveStateSchema = z.enum(MOVE_STATES);
export type MoveState = z.infer<typeof MoveStateSchema>;
export const MOVE_OPEN_STATES: readonly MoveState[] = ['preparing', 'ready', 'moving', 'app_ready', 'failed'];

/** The step that follows `done` in the chain a move runs by itself, or null at a place where the person decides. */
export function nextMoveStep(done: MoveStep): MoveStep | null {
  const i = (PREPARE_STEPS as readonly string[]).indexOf(done);
  if (i >= 0 && i < PREPARE_STEPS.length - 1) return PREPARE_STEPS[i + 1] as MoveStep;
  const j = (SWITCH_STEPS as readonly string[]).indexOf(done);
  if (j >= 0 && j < SWITCH_STEPS.length - 1) return SWITCH_STEPS[j + 1] as MoveStep;
  return null;
}

/** The state a move is in after a step finished (`ok`) or failed. */
export function moveStateAfter(step: MoveStep, ok: boolean): MoveState {
  if (!ok) return 'failed';
  if (step === 'start_database') return 'ready';
  if (step === 'start_app') return 'app_ready';
  if ((SWITCH_STEPS as readonly string[]).includes(step)) return 'moving';
  if (step === 'restart_old') return 'cancelled';
  return 'preparing';
}

/** Where a failed move continues when the person presses "Try again". */
export function resumeStep(failed: MoveStep): MoveStep {
  // a failed backup or restore started the old app again: start the switch from its beginning
  if (failed === 'restore') return 'stop_and_backup';
  return failed;
}

// ------------------------------------------------------------------------------------------------ DNS

export const DNS_STATES = [
  /** The domain points at the new server. */
  'new',
  /** It still points at the old server. */
  'old',
  /** It points somewhere else (a proxy, a CDN, another server). */
  'other',
  /** The domain has no address yet. */
  'none',
  /** The check itself failed. */
  'error',
] as const;
export const DnsStateSchema = z.enum(DNS_STATES);
export type DnsState = z.infer<typeof DnsStateSchema>;

export const DnsCheckDtoSchema = z.object({
  domain: z.string(),
  state: DnsStateSchema,
  /** The address(es) of the new server: what the domain should point to. */
  expected: z.array(z.string()),
  /** What the domain points to now. */
  found: z.array(z.string()),
  oldAddresses: z.array(z.string()),
  at: z.iso.datetime(),
  /** One sentence for the person. */
  text: z.string(),
});
export type DnsCheckDto = z.infer<typeof DnsCheckDtoSchema>;

/** Compares what the domain resolves to with the old and new servers' addresses. Pure. */
export function dnsVerdict(
  domain: string,
  found: readonly string[],
  expected: readonly string[],
  oldAddresses: readonly string[],
  failed?: string,
): Pick<DnsCheckDto, 'state' | 'text'> {
  const exp = new Set(expected);
  const old = new Set(oldAddresses);
  if (failed)
    return {
      state: 'error',
      text: `The check could not be done right now (${failed.slice(0, 120)}). Try again.`,
    };
  if (found.length === 0)
    return {
      state: 'none',
      text: `${domain} does not point anywhere yet. Add the address below at the company that manages your domain.`,
    };
  const all = found.every((f) => exp.has(f));
  if (all)
    return {
      state: 'new',
      text: `${domain} points to the new server. Visitors reach it from now on.`,
    };
  if (found.every((f) => old.has(f)) && !found.some((f) => exp.has(f)))
    return {
      state: 'old',
      text: `${domain} still points to the old server. Change it to ${[...exp].join(' or ')} where your domain is managed; it can take a few minutes (sometimes hours) to spread.`,
    };
  if (found.some((f) => exp.has(f)))
    return {
      state: 'other',
      text: `${domain} points to the new server and to something else (${found.filter((f) => !exp.has(f)).join(', ')}). Remove the other address, or wait while the change spreads.`,
    };
  return {
    state: 'other',
    text: `${domain} points to ${found.join(', ')}, which is neither server. If you use a service in front of your server (a proxy or CDN), that can be right: confirm below. Otherwise change it to ${[...exp].join(' or ')}.`,
  };
}

/** The domain of an app address, or null for an address that is not a real name (localhost, an IP address). */
export function domainOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return DomainSchema.safeParse(h).success ? h : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ names

export const STANDBY_SUFFIX = ' (old server)';
/** The name the old server gets when the new one takes over the name the deploys use. */
export function standbyName(name: string, taken: readonly string[] = []): string {
  const base = `${name.slice(0, 120 - STANDBY_SUFFIX.length)}${STANDBY_SUFFIX}`;
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const n = `${base.slice(0, 116)} ${i}`;
    if (!lower.has(n.toLowerCase())) return n;
  }
  return `${base.slice(0, 100)} ${Date.now() % 100000}`;
}

// ------------------------------------------------------------------------------------------------ API

export const MoveStepDtoSchema = z.object({
  step: MoveStepSchema,
  ok: z.boolean(),
  detail: z.string().nullable(),
  checks: z.array(MoveCheckSchema),
  at: z.iso.datetime(),
});
export type MoveStepDto = z.infer<typeof MoveStepDtoSchema>;

export const MoveDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  envName: z.string(),
  fromTargetId: z.uuid(),
  fromName: z.string(),
  toTargetId: z.uuid(),
  toName: z.string(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  state: MoveStateSchema,
  /** The step that is running or failed. */
  currentStep: MoveStepSchema.nullable(),
  steps: z.array(MoveStepDtoSchema),
  /** The last failure in plain words. */
  error: z.string().nullable(),
  /** The old app is stopped by this move (the site is down until the new app answers). */
  oldAppStopped: z.boolean(),
  facts: MoveFactsSchema,
  domain: z.string().nullable(),
  /** The address(es) the domain has to point to. */
  newAddresses: z.array(z.string()),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type MoveDto = z.infer<typeof MoveDtoSchema>;

export const MoveStartRequestSchema = z.object({
  /** The target being left (the one the environment deploys to now). */
  fromTargetId: z.uuid(),
  /** The new server's target (made with Connect a server). */
  toTargetId: z.uuid(),
  /** The computer that signs in to both servers. */
  workstationId: z.uuid(),
});
export type MoveStartRequest = z.infer<typeof MoveStartRequestSchema>;

export const MoveSwitchRequestSchema = z.object({
  /** The person agreed to a short downtime while the data moves. */
  agreedDowntime: z.literal(true),
});
export type MoveSwitchRequest = z.infer<typeof MoveSwitchRequestSchema>;

export const MoveCompleteRequestSchema = z.object({
  /**
   * `dns`: the live check showed the domain on the new server. `unverified`: the person says the domain is handled some other
   * way (a proxy in front, no domain). The server checks `dns` itself and refuses it when the domain does not point to the new server.
   */
  dns: z.enum(['verified', 'unverified']),
});
export type MoveCompleteRequest = z.infer<typeof MoveCompleteRequestSchema>;

export const RetireRequestSchema = z.object({
  /** The Owner read what retiring does. */
  confirmed: z.literal(true),
});
export type RetireRequest = z.infer<typeof RetireRequestSchema>;

export const MoveListDtoSchema = z.object({ moves: z.array(MoveDtoSchema) });
export type MoveListDto = z.infer<typeof MoveListDtoSchema>;

/** Plain words about what retiring does. Shown before the button, kept as one source for the web, the docs and the tests. */
export const RETIRE_EXPLAINER = [
  'Guildwise removes the keys it added to the old server, so this project can no longer sign in there.',
  'Nothing else changes: the data, the app and the settings on the old server stay exactly as they are. Guildwise never deletes anything there. When you cancel the server with your hosting company, they remove it.',
] as const;
