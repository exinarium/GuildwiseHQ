import { z } from 'zod';
import { ConnectionStateSchema, type ProbeReport } from './probe.ts';
import { LocalPathSchema, RemotePathSchema, ServiceNameSchema, SshAliasSchema } from './setup.ts';

/**
 * Guided connect, dedicated deploy keys and server preparation (docs/design/deploy-run-ux-design.md sections 6.4, 7.4 and 8,
 * phase v2). Everything here is data and pure functions: the runner code that touches `ssh` lives in apps/runner/src/delivery.
 *
 * - A dedicated deploy key is generated in the runner's data directory (`keys/deploy/<target>/`); the private key never
 *   leaves the workstation, the server only ever sees the public key and its fingerprint.
 * - A password (or a key file the host gave the person) is sealed in the browser to the runner key, used once to append the
 *   public key to the server's `authorized_keys`, and dropped.
 * - Server preparation is a closed list of idempotent actions; nothing outside the list can be asked of the runner.
 */

/** Announced by a runner that answers `deploy.hostkey`, `deploy.key`, `deploy.connect`, `deploy.revoke` and `deploy.prepare`. */
export const DEPLOY_CONNECT_CAPABILITY = 'deploy-connect:1';

/** Announced by a runner that opens `h2` sealed sign-ins (bound to the project and the server they were typed for). */
export const SEAL_AAD_CAPABILITY = 'deploy-seal-aad:1';

/**
 * What a sealed password or key file is bound to (AES-GCM additional data): the project and the server address, port and user it
 * was typed for. A sealed sign-in that is replayed against another address (by anything between the browser and the computer)
 * does not open.
 */
export const connectSealAad = (p: {
  projectId: string;
  address: string;
  port: number;
  user: string;
}): string => `aom-connect|${p.projectId}|${p.address.toLowerCase()}|${p.port}|${p.user}`;

/** Every comment of a key Guildwise installs starts with this: the only keys Guildwise ever removes from a server. */
export const DEPLOY_KEY_COMMENT_PREFIX = 'guildwise-deploy:';

// ---------------------------------------------------------------------------------------------------- values

/** A server name or IPv4 address (no user, no port, no leading dash). IPv6 is not supported by generated scripts. */
export const ServerAddressSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/,
    'a server name like shop.example.com or an address like 203.0.113.9',
  );
export const SshUserSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'a user name like root (letters, digits and . _ - only)');
export const SshPortSchema = z.number().int().min(1).max(65535);
export const DomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'a web address without https://, like shop.example.com',
  );
/** `SHA256:` followed by base64 (no padding). */
export const FingerprintSchema = z
  .string()
  .max(80)
  .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'a fingerprint like SHA256:abc...');
/** A random reference for a key made before its target exists. */
export const KeyRefSchema = z.uuid();

/** The default `ssh` port. */
export const DEFAULT_SSH_PORT = 22;

/** Turns a computer's name into a safe key comment tail (letters, digits, `_.-`). */
export function keyLabel(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'workstation';
}

/** The ssh alias Guildwise gives a server it connected itself: `aom-` and a short name. */
export function suggestAlias(name: string, taken: readonly string[] = []): string {
  const base = `aom-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'server'
  }`;
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 100000}`;
}

// ------------------------------------------------------------------------------------------------ host key

export const HostKeyEntrySchema = z.object({
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`. */
  type: z.string().max(40),
  fingerprint: FingerprintSchema,
  bits: z.number().int().optional(),
});
export type HostKeyEntry = z.infer<typeof HostKeyEntrySchema>;

export const HostKeyScanPayloadSchema = z.object({
  projectId: z.uuid(),
  address: ServerAddressSchema,
  port: SshPortSchema.default(DEFAULT_SSH_PORT),
});
export type HostKeyScanPayload = z.infer<typeof HostKeyScanPayloadSchema>;

export const HOST_KEY_ERRORS = ['unreachable', 'no_keys', 'timeout', 'no_ssh', 'bad_request'] as const;
export const HostKeyScanResultSchema = z.union([
  z.object({ ok: z.literal(true), keys: z.array(HostKeyEntrySchema).min(1).max(6) }),
  z.object({
    ok: z.literal(false),
    error: z.enum(HOST_KEY_ERRORS),
    detail: z.string().max(300).optional(),
  }),
]);
export type HostKeyScanResult = z.infer<typeof HostKeyScanResultSchema>;

/** The key people compare with what the hosting company shows: ed25519 first. */
export function preferredHostKey(keys: readonly HostKeyEntry[]): HostKeyEntry | undefined {
  const rank = (t: string) => (t === 'ssh-ed25519' ? 0 : t.startsWith('ecdsa') ? 1 : 2);
  return [...keys].sort((a, b) => rank(a.type) - rank(b.type))[0];
}

/** "ED25519", "ECDSA", "RSA" for a key type. */
export const hostKeyKind = (type: string): string =>
  type === 'ssh-ed25519' ? 'ED25519' : type.startsWith('ecdsa') ? 'ECDSA' : type === 'ssh-rsa' ? 'RSA' : type;

// ------------------------------------------------------------------------------------------------ the key

/** `deploy.key`: make (or find) this computer's dedicated key for a server. Public key out, nothing secret. */
export const DeployKeyPayloadSchema = z
  .object({
    projectId: z.uuid(),
    /** The target, when it exists. */
    targetId: z.uuid().optional(),
    /** A reference for a key made before the target exists (the wizard asks for the key first). */
    keyRef: KeyRefSchema.optional(),
    /** The computer's name (the key's comment, so the server's list tells whose key it is). */
    label: z.string().min(1).max(80),
  })
  .refine((p) => !!p.targetId !== !!p.keyRef, 'name a target or a key reference, not both');
export type DeployKeyPayload = z.infer<typeof DeployKeyPayloadSchema>;

export const KEY_ERRORS = ['no_ssh', 'keygen_failed', 'bad_request'] as const;
export const DeployKeyResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    publicKey: z.string().max(600),
    fingerprint: FingerprintSchema,
    /** The key was there already (kept, not replaced). */
    existed: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.enum(KEY_ERRORS), detail: z.string().max(300).optional() }),
]);
export type DeployKeyResult = z.infer<typeof DeployKeyResultSchema>;

// ------------------------------------------------------------------------------------------------ connect

export const CONNECT_METHODS = ['password', 'keyfile', 'panel', 'alias'] as const;
export const ConnectMethodSchema = z.enum(CONNECT_METHODS);
export type ConnectMethod = z.infer<typeof ConnectMethodSchema>;

/** What the browser seals for the runner: a password, or the key file the host gave (with its passphrase, if any). */
export const ConnectSecretSchema = z.union([
  z.object({ password: z.string().min(1).max(512) }),
  z.object({ privateKey: z.string().min(40).max(20_000), passphrase: z.string().max(512).optional() }),
]);
export type ConnectSecret = z.infer<typeof ConnectSecretSchema>;

export const DeployConnectPayloadSchema = z
  .object({
    projectId: z.uuid(),
    targetId: z.uuid(),
    keyRef: KeyRefSchema.optional(),
    method: ConnectMethodSchema,
    /** The name the generated scripts use for the server (`AOM_DEPLOY_HOST`): the target's host. */
    alias: SshAliasSchema,
    address: ServerAddressSchema.optional(),
    user: SshUserSchema.optional(),
    port: SshPortSchema.default(DEFAULT_SSH_PORT),
    /** The fingerprint the person confirmed (every method except `alias`). */
    hostKeyFingerprint: FingerprintSchema.optional(),
    label: z.string().min(1).max(80),
    /** The server made the target for this very request: a failed connect removes it again (the panel flow keeps it to try again). */
    fresh: z.boolean().optional(),
    /** Sealed secret (`password` and `keyfile`); the payload is emptied once the runner answered. */
    keyId: z.string().min(1).max(100).optional(),
    ciphertext: z.string().min(1).max(40_000).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.method !== 'alias') {
      for (const k of ['address', 'user', 'hostKeyFingerprint'] as const)
        if (!p[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is needed` });
    }
    if ((p.method === 'password' || p.method === 'keyfile') && (!p.ciphertext || !p.keyId))
      ctx.addIssue({ code: 'custom', path: ['ciphertext'], message: 'the sealed sign-in is needed' });
  });
export type DeployConnectPayload = z.infer<typeof DeployConnectPayloadSchema>;

export const CONNECT_ERRORS = [
  'bad_password',
  'bad_key_file',
  'host_key_mismatch',
  'host_key_changed',
  'unreachable',
  'timeout',
  'copy_paste_needed',
  'key_not_accepted',
  'install_failed',
  'alias_not_reachable',
  'sealed_unreadable',
  'key_changed',
  'no_ssh',
  'bad_request',
] as const;
export const ConnectErrorSchema = z.enum(CONNECT_ERRORS);
export type ConnectError = z.infer<typeof ConnectErrorSchema>;

export const DeployConnectResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    publicKey: z.string().max(600),
    fingerprint: FingerprintSchema,
    hostKeyFingerprint: FingerprintSchema.optional(),
    /** `added` our key line, it was `already` there, or the person `pasted` it (panel). */
    installed: z.enum(['added', 'already', 'pasted']),
    /** A dated copy of the server's authorized_keys was made first. */
    backup: z.string().max(300).optional(),
  }),
  z.object({ ok: z.literal(false), error: ConnectErrorSchema, detail: z.string().max(300).optional() }),
]);
export type DeployConnectResult = z.infer<typeof DeployConnectResultSchema>;

/** Plain-words copy for a connect error. */
export function connectErrorText(error: ConnectError, detail?: string): string {
  switch (error) {
    case 'bad_password':
      return 'The server did not accept that user name and password. Check them in your hosting company’s email or panel, then try again.';
    case 'bad_key_file':
      return 'The server did not accept that key file. Make sure it is the whole file (it starts with -----BEGIN) and that the passphrase is right.';
    case 'host_key_mismatch':
      return 'The server answered with a different fingerprint than the one you confirmed. Guildwise stopped. Check the address and start again.';
    case 'host_key_changed':
      return 'The server’s identity changed. This can mean it was reinstalled, or someone is in between. Guildwise will not connect. If you reinstalled it, remove the old entry with ssh-keygen -R <address> on this computer and check again.';
    case 'unreachable':
      return `This computer cannot reach the server${detail ? `: ${detail}` : ''}. Check the address and that the server is on.`;
    case 'timeout':
      return 'The server did not answer in time. Check the address and try again.';
    case 'copy_paste_needed':
      return 'This computer cannot type a password for you (its ssh program is too old). Use “My hosting panel has a place to paste a key” instead.';
    case 'key_not_accepted':
      return 'The server does not accept the Guildwise key yet. Make sure you pasted the whole line, saved it, and that it is for the user you named, then test again.';
    case 'install_failed':
      return `Signing in worked, but the key could not be added to the server${detail ? `: ${detail}` : ''}.`;
    case 'alias_not_reachable':
      return 'This computer cannot sign in to that server with its existing sign-in, so a key cannot be added through it.';
    case 'sealed_unreadable':
      return 'The sign-in could not be read by the computer. Enter it again.';
    case 'key_changed':
      return 'The computer’s key changed while you were typing. Reload the page and try again.';
    case 'no_ssh':
      return 'ssh is not installed on that computer.';
    case 'bad_request':
      return detail ? detail : 'That could not be started.';
  }
}

// ------------------------------------------------------------------------------------------------ revoke

/** `deploy.revoke`: remove one Guildwise-installed key (by its public key) from the server, through this computer's own sign-in. */
export const DeployRevokePayloadSchema = z.object({
  projectId: z.uuid(),
  targetId: z.uuid(),
  alias: SshAliasSchema,
  /** The public key line of the key to remove. */
  publicKey: z.string().min(40).max(600),
  fingerprint: FingerprintSchema,
  /**
   * "Remove this server": the key may be this computer's OWN key (it is used once more to take itself off the server), and
   * this computer deletes its key material for the target afterwards, whether or not the server could be reached
   * (capability `deploy-setup:2`).
   */
  forget: z.boolean().optional(),
});
export type DeployRevokePayload = z.infer<typeof DeployRevokePayloadSchema>;

export const REVOKE_ERRORS = [
  'not_ours',
  'own_key',
  'unreachable',
  'timeout',
  'failed',
  'bad_request',
] as const;
export const DeployRevokeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    /** Lines removed from authorized_keys (0: it was not there any more). */
    removed: z.number().int().min(0),
    backup: z.string().max(300).optional(),
    /** `forget` was asked and this computer's key material for the target is gone. */
    forgotten: z.boolean().optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(REVOKE_ERRORS),
    detail: z.string().max(300).optional(),
    forgotten: z.boolean().optional(),
  }),
]);
export type DeployRevokeResult = z.infer<typeof DeployRevokeResultSchema>;

export function revokeErrorText(error: (typeof REVOKE_ERRORS)[number], detail?: string): string {
  switch (error) {
    case 'not_ours':
      return 'That key was not added by Guildwise, so Guildwise will not remove it.';
    case 'own_key':
      return 'This computer signs in with that key itself. Remove another computer’s key instead.';
    case 'unreachable':
      return 'This computer cannot sign in to the server right now, so it cannot remove the key. Reconnect first.';
    case 'timeout':
      return 'The server did not answer in time.';
    case 'failed':
      return `The key could not be removed${detail ? `: ${detail}` : ''}.`;
    case 'bad_request':
      return 'That could not be started.';
  }
}

// ------------------------------------------------------------------------------------------------ prepare

/** The only files `write_compose` handles: `docker-compose.yml`, `compose.yaml`, `docker-compose.prod.yml`... */
export const COMPOSE_FILE_NAME = /^(?:docker-)?compose(?:[._-][A-Za-z0-9_-]+)*\.ya?ml$/;
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));

const RepoComposePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'a path inside the project like deploy/docker-compose.yml')
  .refine((p) => !p.split('/').includes('..'), 'a path cannot contain ..')
  .refine((p) => COMPOSE_FILE_NAME.test(baseName(p)), 'a compose file like deploy/docker-compose.yml');

const PrepareDir = z.object({
  kind: z.literal('create_dir'),
  path: z.union([RemotePathSchema, LocalPathSchema]),
});

export const PrepareActionSchema = z.discriminatedUnion('kind', [
  /** Install Docker with the distribution's own packages (Debian and Ubuntu; needs root or passwordless sudo). */
  z.object({ kind: z.literal('install_docker') }),
  /** A folder (and its parents), with mode 755. Nothing is changed when it exists. */
  PrepareDir,
  /** Write a compose file taken from the project's repository; never over an existing file. */
  z.object({
    kind: z.literal('write_compose'),
    /** Where it goes (absolute on the server; absolute or `~/` on this computer). Always a compose file name. */
    path: z
      .union([RemotePathSchema, LocalPathSchema])
      .refine((p) => COMPOSE_FILE_NAME.test(baseName(p)), 'a compose file like docker-compose.yml'),
    /** The file inside the project's repository on the computer, relative (no `..`). */
    repoPath: RepoComposePathSchema,
    repoName: z.string().min(1).max(120).optional(),
    /** The repository's normalized remote address: filled in by the server (the computer looks the folder up by it). */
    remote: z.string().min(1).max(500).optional(),
  }),
  /** HTTPS for one domain with Caddy: append a site to the Caddyfile that is there (dated backup, validated), or start Caddy. */
  z.object({
    kind: z.literal('caddy_site'),
    domain: DomainSchema,
    /** The port of the app on the server (published by the compose file). */
    upstreamPort: z.number().int().min(1).max(65535),
  }),
  /** Start the services of a compose project that are not running, except the named ones (used for a new copy). */
  z.object({
    kind: z.literal('start_services'),
    composeFile: z.union([RemotePathSchema, LocalPathSchema]),
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    /** The app service: built and started by the first deploy, not here. */
    except: z.array(ServiceNameSchema).max(10).default([]),
  }),
]);
export type PrepareAction = z.infer<typeof PrepareActionSchema>;
export type PrepareActionKind = PrepareAction['kind'];

export const DeployPreparePayloadSchema = z.object({
  projectId: z.uuid(),
  targetId: z.uuid().optional(),
  hosting: z.enum(['ssh', 'this_computer']),
  /** `ssh`: the server's name (the target's host). */
  alias: SshAliasSchema.optional(),
  actions: z.array(PrepareActionSchema).min(1).max(12),
  /** Report what would be done and change nothing. */
  dryRun: z.boolean().default(false),
});
export type DeployPreparePayload = z.infer<typeof DeployPreparePayloadSchema>;

export const PrepareStepResultSchema = z.object({
  kind: z.string().max(40),
  outcome: z.enum(['done', 'skipped', 'would', 'failed']),
  detail: z.string().max(400).default(''),
});
export type PrepareStepResult = z.infer<typeof PrepareStepResultSchema>;

export const PREPARE_ERRORS = [
  'unreachable',
  'timeout',
  'needs_root',
  'unsupported_os',
  'port_in_use',
  'repo_file_missing',
  'failed',
  'bad_request',
] as const;
export const DeployPrepareResultSchema = z.object({
  ok: z.boolean(),
  error: z.enum(PREPARE_ERRORS).optional(),
  detail: z.string().max(400).optional(),
  steps: z.array(PrepareStepResultSchema).max(12),
});
export type DeployPrepareResult = z.infer<typeof DeployPrepareResultSchema>;

/** One sentence per action, for the confirmation screen and the audit. */
export function describePrepareAction(a: PrepareAction, where: 'server' | 'computer' = 'server'): string {
  const on = where === 'server' ? 'on the server' : 'on this computer';
  switch (a.kind) {
    case 'install_docker':
      return `Install Docker ${on} with the system’s own packages (skipped if it is already installed).`;
    case 'create_dir':
      return `Create the folder ${a.path} ${on} (skipped if it exists).`;
    case 'write_compose':
      return `Put the project’s ${a.repoPath} in ${a.path} ${on} (never over a file that is already there).`;
    case 'caddy_site':
      return `Set up HTTPS for ${a.domain} with Caddy ${on}, sending visitors to the app on port ${a.upstreamPort}. Other sites and settings stay as they are.`;
    case 'start_services':
      return `Start the supporting parts of ${a.project} (everything except ${a.except.join(', ') || 'nothing'}) ${on}.`;
  }
}

export interface PrepareInputs {
  hosting: 'ssh' | 'this_computer';
  /** The app folder (`/opt/shop`, or a folder on this computer for a new copy). */
  appDir?: string | undefined;
  /** The domain to serve over HTTPS (server only). */
  domain?: string | undefined;
  /** The port the app is published on. */
  upstreamPort?: number | undefined;
  /** A compose file in the project's repository to use when the folder has none. */
  composeFromRepo?: { repoPath: string; repoName?: string | undefined } | undefined;
  /** A new copy on this computer: the compose project name and the app service (started by the first deploy). */
  project?: string | undefined;
  appService?: string | undefined;
}

/**
 * Problems that make a list of actions unsafe whatever produced it: a compose file written anywhere but the app folder, a folder
 * of this computer's own dot-folders (`~/.ssh`), a compose project that is not the app's.
 */
export function prepareActionProblems(
  actions: readonly PrepareAction[],
  hosting: 'ssh' | 'this_computer',
  /** The app folder being set up (from the inputs, or the target's folder in the setup). */
  appDir?: string,
): string[] {
  const out: string[] = [];
  const dirs = [
    ...(appDir ? [appDir] : []),
    ...actions.filter((a) => a.kind === 'create_dir').map((a) => (a as { path: string }).path),
  ];
  for (const a of actions) {
    if (a.kind === 'write_compose') {
      const dir = dirName(a.path);
      if (!COMPOSE_FILE_NAME.test(baseName(a.path))) out.push(`${a.path} is not a compose file name`);
      if (
        !dirs.includes(dir) &&
        !actions.some((x) => x.kind === 'start_services' && dirName(x.composeFile) === dir)
      )
        out.push(`the compose file goes to ${dir}, which is not the app folder being set up`);
    }
    if (hosting === 'this_computer') {
      const paths = [
        ...(a.kind === 'create_dir' ? [a.path] : []),
        ...(a.kind === 'write_compose' ? [a.path] : []),
        ...(a.kind === 'start_services' ? [a.composeFile] : []),
      ];
      for (const p of paths) {
        if (p.startsWith('~/') && p.slice(2).split('/')[0]?.startsWith('.'))
          out.push(`${p} is in a hidden folder of this computer`);
      }
    }
  }
  return out;
}

export interface PreparePlan {
  actions: PrepareAction[];
  /** What was found and will be reused as it is. */
  reuse: string[];
  /** Why nothing can be done (needs a person), in plain words. */
  blockers: string[];
}

/**
 * Detect first, change what is missing only (design section 7.4): the actions that bring a server (or a folder on this
 * computer) to a state the guided deploy can adopt. Pure: the same on the web (the confirmation list) and on the server.
 */
export function planPrepare(report: ProbeReport | null, inp: PrepareInputs): PreparePlan {
  const actions: PrepareAction[] = [];
  const reuse: string[] = [];
  const blockers: string[] = [];
  const server = inp.hosting === 'ssh';
  const where = server ? 'the server' : 'this computer';
  const dockerOk = report?.docker?.installed && report.docker.usable;
  if (server) {
    if (!report) blockers.push('Look at the server first.');
    else if (!report.docker?.installed) actions.push({ kind: 'install_docker' });
    else if (!report.docker.usable)
      blockers.push(
        'Docker is installed on the server, but this user is not allowed to use it. Ask your host to add the user to the docker group (or sign in as root).',
      );
    else reuse.push(`Docker ${report.docker.version ?? ''} is installed and works`.replace('  ', ' ').trim());
  } else if (!dockerOk) {
    blockers.push(
      report?.docker?.installed
        ? 'Docker is installed but this user is not allowed to use it.'
        : 'Docker is not installed on this computer. Install Docker, then check again.',
    );
  } else reuse.push('Docker works on this computer');

  if (inp.appDir) {
    const f = report?.folders.find((x) => x.path === inp.appDir);
    const hasCompose = !!report?.composeFiles.some(
      (c) => c.path.startsWith(`${inp.appDir}/`) && !c.unreadable && c.services.length > 0,
    );
    if (f?.exists) reuse.push(`The folder ${inp.appDir} exists and is kept as it is`);
    else actions.push({ kind: 'create_dir', path: inp.appDir } as PrepareAction);
    const backups = `${inp.appDir}/backups`;
    if (!report?.backups.some((b) => b.dir === backups) && !f?.entries.includes('backups'))
      actions.push({ kind: 'create_dir', path: backups } as PrepareAction);
    if (hasCompose) reuse.push(`A compose file is already in ${inp.appDir} and is kept`);
    else if (inp.composeFromRepo)
      actions.push({
        kind: 'write_compose',
        path: `${inp.appDir}/docker-compose.yml`,
        repoPath: inp.composeFromRepo.repoPath,
        ...(inp.composeFromRepo.repoName ? { repoName: inp.composeFromRepo.repoName } : {}),
      } as PrepareAction);
    else if (!hasCompose && inp.hosting === 'this_computer')
      blockers.push('The project has no compose file to start a new copy from.');
  }

  if (server && inp.domain && inp.upstreamPort) {
    const served = report?.proxies.find((p) => p.sites.some((s) => s === inp.domain));
    if (served) reuse.push(`${inp.domain} is already served by ${served.kind} and is kept as it is`);
    else {
      const caddy = report?.proxies.find((p) => p.kind === 'caddy');
      const other = report?.proxies.find((p) => p.kind !== 'caddy');
      const busy = (report?.listeners ?? []).length > 0;
      if (caddy) actions.push({ kind: 'caddy_site', domain: inp.domain, upstreamPort: inp.upstreamPort });
      else if (other)
        blockers.push(
          `${other.kind} already answers on the web ports of ${where}. Guildwise only sets up HTTPS with Caddy and will not change ${other.kind}: add ${inp.domain} there yourself, or use the address with the port.`,
        );
      else if (busy)
        blockers.push(
          `Something already uses ports 80 or 443 on ${where}. Guildwise will not touch it. Free the ports or serve ${inp.domain} yourself.`,
        );
      else actions.push({ kind: 'caddy_site', domain: inp.domain, upstreamPort: inp.upstreamPort });
    }
  }

  if (!server && inp.appDir && inp.project) {
    actions.push({
      kind: 'start_services',
      composeFile: `${inp.appDir}/docker-compose.yml`,
      project: inp.project,
      except: inp.appService ? [inp.appService] : [],
    } as PrepareAction);
  }
  return { actions, reuse, blockers };
}

// ------------------------------------------------------------------------------------------------ API + DTOs

export const DEPLOY_KEY_STATES = ['active', 'revoked'] as const;
/** One workstation's dedicated key for a target, as the server knows it (public parts only). */
export const DeployKeyDtoSchema = z.object({
  targetId: z.uuid(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  fingerprint: FingerprintSchema,
  state: z.enum(DEPLOY_KEY_STATES),
  alias: z.string(),
  address: z.string().nullable(),
  user: z.string().nullable(),
  port: z.number().int().nullable(),
  hostKeyFingerprint: z.string().nullable(),
  addedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type DeployKeyDto = z.infer<typeof DeployKeyDtoSchema>;

export const OP_KINDS = ['hostkey', 'key', 'connect', 'revoke', 'prepare', 'check'] as const;
export const OpKindSchema = z.enum(OP_KINDS);
export type OpKind = z.infer<typeof OpKindSchema>;

/** The state of one requested operation (`GET .../delivery/ops/:id`). `result` is the runner's answer, nothing secret. */
export const OpStatusDtoSchema = z.object({
  id: z.string(),
  kind: OpKindSchema,
  state: z.enum(['pending', 'done', 'failed', 'expired']),
  ok: z.boolean().nullable(),
  /** The runner's result object (host keys, public key, steps...). */
  result: z.unknown().nullable(),
  /** A sentence for a failure. */
  errorText: z.string().nullable(),
  at: z.iso.datetime().nullable(),
});
export type OpStatusDto = z.infer<typeof OpStatusDtoSchema>;

export const OpStartedDtoSchema = z.object({ commandId: z.string(), workstationId: z.uuid() });
export type OpStartedDto = z.infer<typeof OpStartedDtoSchema>;

export const HostKeyScanRequestSchema = z.object({
  workstationId: z.uuid(),
  address: ServerAddressSchema,
  port: SshPortSchema.default(DEFAULT_SSH_PORT),
});
export type HostKeyScanRequest = z.infer<typeof HostKeyScanRequestSchema>;

export const KeyCreateRequestSchema = z
  .object({
    workstationId: z.uuid(),
    targetId: z.uuid().optional(),
    keyRef: KeyRefSchema.optional(),
  })
  .refine((p) => !!p.targetId !== !!p.keyRef, 'name a target or a key reference, not both');
export type KeyCreateRequest = z.infer<typeof KeyCreateRequestSchema>;

export const ConnectRequestSchema = z
  .object({
    workstationId: z.uuid(),
    /** The target to connect. Absent: the server makes a new server target from `newTarget`. */
    targetId: z.uuid().optional(),
    newTarget: z
      .object({
        name: z.string().min(1).max(80),
        production: z.boolean().default(false),
      })
      .optional(),
    keyRef: KeyRefSchema.optional(),
    method: ConnectMethodSchema,
    /** The ssh alias to adopt (`alias`), or the name for a new server (suggested when absent). */
    alias: SshAliasSchema.optional(),
    address: ServerAddressSchema.optional(),
    user: SshUserSchema.optional(),
    port: SshPortSchema.default(DEFAULT_SSH_PORT),
    hostKeyFingerprint: FingerprintSchema.optional(),
    keyId: z.string().min(1).max(100).optional(),
    ciphertext: z.string().min(1).max(40_000).optional(),
  })
  .refine((r) => !!r.targetId !== !!r.newTarget, 'name a target, or describe a new one');
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

export const ConnectStartedDtoSchema = OpStartedDtoSchema.extend({ targetId: z.uuid(), alias: z.string() });
export type ConnectStartedDto = z.infer<typeof ConnectStartedDtoSchema>;

export const RevokeKeyRequestSchema = z.object({
  /** The computer that signs in to remove the key (the target’s deploying computer). */
  workstationId: z.uuid(),
  /** The fingerprint of the key to remove. */
  fingerprint: FingerprintSchema,
});
export type RevokeKeyRequest = z.infer<typeof RevokeKeyRequestSchema>;

export const PrepareInputsSchema = z.object({
  hosting: z.enum(['ssh', 'this_computer']),
  appDir: z.union([RemotePathSchema, LocalPathSchema]).optional(),
  domain: DomainSchema.optional(),
  upstreamPort: z.number().int().min(1).max(65535).optional(),
  composeFromRepo: z
    .object({
      repoPath: RepoComposePathSchema,
      repoName: z.string().max(120).optional(),
    })
    .optional(),
  project: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
    .optional(),
  appService: ServiceNameSchema.optional(),
});

export const PrepareRequestSchema = z
  .object({
    workstationId: z.uuid(),
    targetId: z.uuid().optional(),
    hosting: z.enum(['ssh', 'this_computer']),
    /**
     * What the person chose. The server computes the actions from these and the latest look at the server (the list below is
     * what an older page sends, and what the page showed): a server that knows `inputs` ignores `actions`.
     */
    inputs: PrepareInputsSchema.optional(),
    actions: z.array(PrepareActionSchema).min(1).max(12).optional(),
    dryRun: z.boolean().default(false),
    /** The person saw the list and pressed the button. */
    confirmed: z.boolean(),
  })
  .refine((r) => !!r.inputs || !!r.actions, 'name what to set up');
export type PrepareRequest = z.infer<typeof PrepareRequestSchema>;

/** The reachability chip of a target card. */
export const ReachabilityDtoSchema = z.object({
  state: ConnectionStateSchema,
  at: z.iso.datetime(),
  detail: z.string().nullable(),
  method: z.enum(['existing_alias', 'deploy_key']),
  workstationId: z.uuid(),
});
export type ReachabilityDto = z.infer<typeof ReachabilityDtoSchema>;

/** Plain words for a reachability state ("Can sign in", ...). */
export const REACHABILITY_TEXT: Record<
  z.infer<typeof ConnectionStateSchema> | 'never',
  { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  reachable: { text: 'Can sign in', tone: 'success' },
  asks_password: { text: 'Needs a sign-in', tone: 'warning' },
  unreachable: { text: 'Cannot reach the server', tone: 'danger' },
  host_key_unknown: { text: 'Server not trusted yet', tone: 'warning' },
  host_key_changed: { text: 'Server identity changed', tone: 'danger' },
  unchecked: { text: 'Not checked', tone: 'neutral' },
  never: { text: 'Never checked', tone: 'neutral' },
};

// ------------------------------------------------------------------------------------------------ sealing (browser -> runner)

/**
 * Seals a value of any length for the runner (a password, or a key file the host gave): a fresh AES-256-GCM key encrypts the
 * text and RSA-OAEP (SHA-256) with the runner's public key wraps that key. Format `h1.<wrapped key>.<iv>.<ciphertext+tag>`, all
 * base64. Works in the browser and in Node (WebCrypto). The runner opens it with `RunnerKeys.decryptAny`.
 */
export async function sealLarge(publicKeyB64: string, text: string, aad?: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const b64 = (u: Uint8Array) => {
    let bin = '';
    for (const b of u) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  const der = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  const rsa = await subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt(
      aad ? { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) } : { name: 'AES-GCM', iv },
      aes,
      new TextEncoder().encode(text),
    ),
  );
  const raw = new Uint8Array(await subtle.exportKey('raw', aes));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, rsa, raw));
  return `${aad ? 'h2' : 'h1'}.${b64(wrapped)}.${b64(iv)}.${b64(ct)}`;
}
