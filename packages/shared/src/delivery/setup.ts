import { z } from 'zod';
import { RunHealthSchema } from '../runs/plan.ts';
import { EnvNameSchema, GateSchema } from './gate.ts';
import { ReleasedBySchema, SECRET_NAME, TriggerSchema } from './recipe.ts';

/**
 * The guided deploy setup (docs/design/deploy-run-ux-design.md sections 4.2 and 4.3). `delivery/setup.json` holds what the
 * person answered and what was adopted from the probe; a pure compiler (`compileSetup`, setup-compile.ts) turns it into
 * `recipe.yaml` and one script per environment. All of them are in the bundle the Owner approves, so the approval hash, the
 * drift check and `deploy.exec` do not change. Every user-supplied value is validated here to a strict character set; the
 * compiler single-quotes it on top (two layers: a value that passes here still never reaches a shell unquoted).
 */

export const SETUP_FILE = 'setup.json';
export const SETUP_VERSION = 1;
/** The compiler version recorded in `setup.json`: a newer compiler never silently rewrites approved scripts. */
export const SETUP_GENERATOR = 'setup-1.3';
/** Did an older compiler write these scripts? (The "improved steps are available" nudge.) */
export const isOlderGenerator = (g: string): boolean => g !== SETUP_GENERATOR;

/** `/abs/path` or `~/path`: letters, digits and `._/+@=-` only, no `..`. */
const PATH_RE = /^(?:~\/|\/)[A-Za-z0-9._/+@=-]*$/;
const noDotDot = (p: string) => !p.split('/').includes('..');
export const LocalPathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(PATH_RE, 'a full path like /home/you/app or ~/app (letters, digits and . _ / + @ = - only)')
  .refine(noDotDot, 'a path cannot contain ..');
export const RemotePathSchema = z
  .string()
  .min(2)
  .max(300)
  .regex(
    /^\/[A-Za-z0-9._/+@=-]*$/,
    'a full path on the server like /opt/app (letters, digits and . _ / + @ = - only)',
  )
  .refine(noDotDot, 'a path cannot contain ..');
/** The settings file kept on the computer for a script: a plain path, never a place where credentials live. */
export const SetupEnvFileSchema = LocalPathSchema.refine(
  (p) =>
    !/(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gcloud|etc|proc|sys|root)(\/|$)/.test(p) &&
    !/(^|\/)id_[a-z0-9]+/i.test(p),
  'a settings file of your own (not an ssh, cloud or system folder)',
);
export const ServiceNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'a service name has letters, digits and . _ - only');
export const ImageNameSchema = z
  .string()
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/, 'an image name has lowercase letters, digits and . _ / - only');
export const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,62}$/, 'a variable name is UPPER_SNAKE_CASE');
export const SshAliasSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a server name has letters, digits and . _ - only');
export const ComposeProjectSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'a compose project name has lowercase letters, digits, - and _ only');
export const SetupUrlSchema = z
  .string()
  .max(500)
  .regex(/^https?:\/\/[A-Za-z0-9._~:/?#@%&=+,${}-]+$/, 'an address like https://app.example.com/ready');

/** The health address of a guided environment: a web address, or `${appUrl}` followed by a path. */
export const HealthUrlSchema = z
  .string()
  .max(500)
  .regex(
    /^(?:https?:\/\/|\$\{appUrl\})[A-Za-z0-9._~:/?#@%&=+,-]*$/,
    'an address like https://app.example.com/ready',
  );

export const SetupAppSchema = z.object({
  /** The compose file of the app: local (`~/...` allowed) or an absolute path on the server. */
  composeFile: LocalPathSchema,
  /** Compose project name (`-p`); absent: the name inside the compose file. */
  composeProject: ComposeProjectSchema.optional(),
  /** The only service that is rebuilt or restarted. */
  service: ServiceNameSchema,
  imageName: ImageNameSchema,
  /** On a server: the `.env` key that pins the image (`GUILDWISE_IMAGE`). */
  imageVar: EnvVarNameSchema.optional(),
  /**
   * How many `<imageName>:<commit>` tags to keep on this computer (older ones are removed, never the running or previous).
   * Only used when the app runs on this computer: a server's images are not pruned.
   */
  imageKeep: z.number().int().min(1).max(50).default(5),
  appUrl: SetupUrlSchema.optional(),
});
export type SetupApp = z.infer<typeof SetupAppSchema>;

const Keep = z.number().int().min(0).max(500).default(20);

export const DeployStepSchema = z.discriminatedUnion('kind', [
  /** Back up the database before anything changes; a failed backup stops the deploy. */
  z.object({
    kind: z.literal('db_backup'),
    /** The compose service that runs the database (postgres). */
    service: ServiceNameSchema,
    dir: LocalPathSchema,
    /** Newest N backups of this environment to keep; 0 keeps all. */
    keep: Keep,
    /** Default: the container's own POSTGRES_USER / POSTGRES_DB. */
    dbUser: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,63}$/)
      .optional(),
    dbName: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,63}$/)
      .optional(),
  }),
  /** Save a copy of the server's `.env` before the image variable is changed. */
  z.object({ kind: z.literal('env_backup') }),
  /** Build the image from the approved commit on this computer. */
  z.object({ kind: z.literal('build_image_local') }),
  /** Copy the image to the server over ssh. */
  z.object({ kind: z.literal('ship_image_ssh') }),
  /** Point the server's `.env` at the new image. */
  z.object({ kind: z.literal('set_image_var') }),
  /** This computer: rebuild and restart only the app service. */
  z.object({ kind: z.literal('compose_up_local') }),
  /** The server: restart only the app service. */
  z.object({ kind: z.literal('compose_up_remote') }),
  /**
   * Run a command in the app's image before the app is restarted, for example the database migrations
   * (`docker compose run --rm <service> <argv>`, the way the app itself runs). Needs the database backup before it.
   */
  z.object({
    kind: z.literal('compose_run'),
    label: z.string().min(1).max(120).default('Run database updates'),
    argv: z.array(z.string().max(500)).min(1).max(40),
    /** Default: the app service. */
    service: ServiceNameSchema.optional(),
  }),
  /** Developer: a command of your own (argv, no shell). Runs where the script runs, after the steps above it. */
  z.object({
    kind: z.literal('custom_command'),
    label: z.string().min(1).max(120),
    argv: z.array(z.string().max(500)).min(1).max(40),
    /** `server`: through ssh on the server (ssh setups only). */
    where: z.enum(['here', 'server']).default('here'),
  }),
]);
export type DeployStep = z.infer<typeof DeployStepSchema>;
export type DeployStepKind = DeployStep['kind'];

export const SetupEnvSchema = z
  .object({
    name: EnvNameSchema,
    /** "Test copy", "Live site". */
    label: z.string().min(1).max(60),
    /** `deploy_targets.name` of the project. */
    target: z.string().min(1).max(80),
    /** `custom`: the script is hand-written; the compiler leaves its file alone. */
    mode: z.enum(['guided', 'custom']).default('guided'),
    hosting: z.enum(['this_computer', 'ssh']),
    /** The ssh alias of the server (display and probing; the script reads it from `AOM_DEPLOY_HOST`). */
    host: SshAliasSchema.optional(),
    app: SetupAppSchema,
    steps: z.array(DeployStepSchema).max(20),
    health: RunHealthSchema.default({ kind: 'none', graceSec: 3 }),
    healthTimeoutSec: z.number().int().min(10).max(900).default(120),
    /** Put the previous image back when the health check fails (the database is never rolled back). */
    rollback: z.boolean().default(true),
    trigger: z.array(TriggerSchema).min(1).max(3).default(['on_request']),
    releasedBy: ReleasedBySchema.default('owner'),
    gate: z.union([z.literal('none'), z.string().min(1).max(60), GateSchema]).default('none'),
    secrets: z.array(z.string().regex(SECRET_NAME)).max(30).default([]),
    envFile: SetupEnvFileSchema.optional(),
    timeoutSec: z.number().int().min(60).max(21_600).default(1800),
  })
  .superRefine((e, ctx) => {
    for (const m of validateEnvShape(e)) ctx.addIssue({ code: 'custom', message: m });
    if (e.health.kind === 'http' && !HealthUrlSchema.safeParse(e.health.url).success)
      ctx.addIssue({
        code: 'custom',
        path: ['health', 'url'],
        message: 'an address like https://app.example.com/ready',
      });
  });
export type SetupEnv = z.infer<typeof SetupEnvSchema>;

export const DeliverySetupSchema = z
  .object({
    version: z.literal(SETUP_VERSION).default(SETUP_VERSION),
    generator: z.string().max(40).default(SETUP_GENERATOR),
    environments: z.array(SetupEnvSchema).min(1).max(12),
  })
  .superRefine((s, ctx) => {
    const names = s.environments.map((e) => e.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup)
      ctx.addIssue({ code: 'custom', path: ['environments'], message: `environment ${dup} is listed twice` });
  });
export type DeliverySetup = z.infer<typeof DeliverySetupSchema>;

/** The steps each kind of hosting may contain. */
const ALLOWED: Record<SetupEnv['hosting'], DeployStepKind[]> = {
  this_computer: ['db_backup', 'compose_run', 'compose_up_local', 'custom_command'],
  ssh: [
    'db_backup',
    'env_backup',
    'build_image_local',
    'ship_image_ssh',
    'set_image_var',
    'compose_run',
    'compose_up_remote',
    'custom_command',
  ],
};

/** Plain-words problems with the shape of one environment (not with single values: the schema reports those). */
export function validateEnvShape(
  e: Pick<SetupEnv, 'hosting' | 'steps' | 'app' | 'rollback' | 'health' | 'host' | 'mode'> & {
    name?: string;
  },
): string[] {
  if (e.mode === 'custom') return [];
  const out: string[] = [];
  const kinds = e.steps.map((s) => s.kind);
  for (const k of kinds)
    if (!ALLOWED[e.hosting].includes(k))
      out.push(
        e.hosting === 'ssh'
          ? `The step "${k}" belongs to deploying on this computer, not on a server.`
          : `The step "${k}" belongs to deploying on a server, not on this computer.`,
      );
  const once = (k: DeployStepKind) => kinds.filter((x) => x === k).length > 1;
  for (const k of ALLOWED[e.hosting])
    if (k !== 'custom_command' && once(k)) out.push(`The step "${k}" appears twice.`);
  if (e.hosting === 'this_computer') {
    if (!kinds.includes('compose_up_local')) out.push('Add the step that restarts the app on this computer.');
    if (e.app.composeFile.startsWith('~') === false && !e.app.composeFile.startsWith('/'))
      out.push('The compose file must be a full path.');
  } else {
    if (e.app.composeFile.startsWith('~'))
      out.push('On a server the compose file needs a full path like /opt/app/docker-compose.yml.');
    if (!e.app.imageVar)
      out.push('A server deploy needs the name of the setting that holds the image (for example APP_IMAGE).');
    if (!e.host) out.push('A server deploy needs the name of the server.');
    for (const need of ['build_image_local', 'ship_image_ssh', 'set_image_var', 'compose_up_remote'] as const)
      if (!kinds.includes(need)) out.push(`A server deploy needs the step "${need}".`);
    const order = (k: DeployStepKind) => kinds.indexOf(k);
    if (
      kinds.includes('build_image_local') &&
      !(
        order('build_image_local') < order('ship_image_ssh') &&
        order('ship_image_ssh') < order('set_image_var') &&
        order('set_image_var') < order('compose_up_remote')
      )
    )
      out.push(
        'The steps must run in this order: build, copy to the server, switch the image, restart the app.',
      );
    if (kinds.includes('env_backup') && order('env_backup') > order('set_image_var'))
      out.push('The settings file must be saved before the image is switched.');
  }
  const bk = kinds.indexOf('db_backup');
  const up = kinds.findIndex((k) => k === 'compose_up_local' || k === 'compose_up_remote');
  if (bk >= 0 && up >= 0 && bk > up) out.push('The database backup must come before the app is restarted.');
  const runs = kinds.indexOf('compose_run');
  if (runs >= 0) {
    if (up >= 0 && runs > up) out.push('The database updates must run before the app is restarted.');
    if (bk >= 0 && runs < bk) out.push('The database backup must come before the database updates.');
    if (bk < 0) out.push('Back up the database before running database updates.');
    if (e.hosting === 'ssh' && kinds.includes('ship_image_ssh') && runs < kinds.indexOf('ship_image_ssh'))
      out.push('The new app must be on the server before the database updates run.');
  }
  if (e.rollback && e.health.kind !== 'http')
    out.push(
      'Automatic rollback needs a web address (http) health check, so the script can see the site is healthy.',
    );
  return out;
}

export type SetupParse = { ok: true; setup: DeliverySetup } | { ok: false; error: string };

export function parseSetup(raw: unknown): SetupParse {
  const r = DeliverySetupSchema.safeParse(raw);
  if (r.success) return { ok: true, setup: r.data };
  return {
    ok: false,
    error: r.error.issues
      .map((i) => `${i.path.join('.') || 'setup'}: ${i.message}`)
      .join('; ')
      .slice(0, 800),
  };
}

export function parseSetupText(text: string): SetupParse {
  try {
    return parseSetup(JSON.parse(text));
  } catch (err) {
    return {
      ok: false,
      error: `setup.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------------------------------- plain words

/** One line about a step, for the "Each update will" list. */
export function describeSetupStep(s: DeployStep, env: Pick<SetupEnv, 'app' | 'hosting'>): string {
  switch (s.kind) {
    case 'db_backup':
      return `Back up the database (${s.service}) to ${s.dir}${s.keep ? `, keeping the newest ${s.keep}` : ''}. If the backup fails, nothing else happens.`;
    case 'env_backup':
      return 'Save a copy of the server’s settings file (.env) next to it.';
    case 'build_image_local':
      return `Build the app from the approved version on this computer (${env.app.imageName}:<version>).`;
    case 'ship_image_ssh':
      return 'Copy the new app image to the server (skipped if it is already there).';
    case 'set_image_var':
      return `Switch the server to the new version (only the ${env.app.imageVar ?? 'image'} line of its settings file changes).`;
    case 'compose_up_local':
      return `Rebuild and restart only "${env.app.service}" on this computer, from the approved version (nothing else is stopped).`;
    case 'compose_up_remote':
      return `Restart only "${env.app.service}" on the server (nothing else is stopped).`;
    case 'compose_run':
      return `${s.label}: run ${s.argv.join(' ')} with the new version of the app, before it is restarted. The database is not rolled back if a later step fails.`;
    case 'custom_command':
      return `${s.label} (your own command: ${s.argv.join(' ')}).`;
  }
}

/** The implicit steps around the explicit ones, in plain words. */
export function implicitStepText(env: Pick<SetupEnv, 'rollback' | 'health' | 'app'>): {
  before: string[];
  after: string[];
} {
  const before = [
    'Skip everything if this version is already running and healthy.',
    'Make sure no other deploy of this environment is running.',
  ];
  const after: string[] = [];
  if (env.health.kind === 'http')
    after.push(
      `Check the site answers (${env.health.url.replace('${appUrl}', env.app.appUrl ?? 'the app address')})${env.rollback ? ', and put the previous version back if it does not. The database is never rolled back automatically' : ''}.`,
    );
  return { before, after };
}
