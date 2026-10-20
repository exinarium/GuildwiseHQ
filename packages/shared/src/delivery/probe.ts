import { z } from 'zod';
import { SshAliasSchema } from './setup.ts';

/**
 * The deploy probe (docs/design/deploy-run-ux-design.md section 6): fixed, read-only questions put to Docker on a computer or
 * to a server over ssh, answered with names and shapes only. Never a secret value, never a private key, never the text of a
 * file (a compose file is reduced to its structure on the workstation).
 */

/** Announced by a runner that answers `deploy.probe` and `recipe.write` (guided deploy setup). */
export const DEPLOY_SETUP_CAPABILITY = 'deploy-setup:1';

export const PROBE_SCOPES = ['local', 'ssh_hosts', 'ssh_target'] as const;
export const ProbeScopeSchema = z.enum(PROBE_SCOPES);
export type ProbeScope = z.infer<typeof ProbeScopeSchema>;

export const PROBE_ERRORS = [
  'docker_missing',
  'docker_permission',
  'ssh_auth',
  'ssh_unreachable',
  'ssh_host_key_changed',
  'ssh_host_key_unknown',
  'timeout',
  'unsupported_os',
  'bad_request',
] as const;
export const ProbeErrorSchema = z.enum(PROBE_ERRORS);
export type ProbeError = (typeof PROBE_ERRORS)[number];

export const DeployProbePayloadSchema = z.object({
  projectId: z.uuid(),
  targetId: z.uuid().optional(),
  scope: ProbeScopeSchema,
  /** `ssh_target`: the alias to look at. */
  host: SshAliasSchema.optional(),
  hints: z
    .object({
      composeFiles: z.array(z.string().max(300)).max(10).optional(),
      dirs: z.array(z.string().max(300)).max(10).optional(),
      urls: z.array(z.string().max(300)).max(10).optional(),
    })
    .optional(),
});
export type DeployProbePayload = z.infer<typeof DeployProbePayloadSchema>;

const Name = z.string().max(200);

export const ProbePortSchema = z.object({
  host: z.number().int().nullable().optional(),
  container: z.number().int().nullable().optional(),
  bind: z.string().max(60).optional(),
});

export const ProbeContainerSchema = z.object({
  name: Name,
  project: Name.optional(),
  service: Name.optional(),
  image: Name,
  state: z.string().max(40),
  status: z.string().max(100).optional(),
  ports: z.array(ProbePortSchema).max(20).default([]),
  composeFile: z.string().max(300).optional(),
  workingDir: z.string().max(300).optional(),
});
export type ProbeContainer = z.infer<typeof ProbeContainerSchema>;

export const ProbeComposeServiceSchema = z.object({
  name: Name,
  image: Name.optional(),
  /** The build context as written in the file. */
  build: z.string().max(300).optional(),
  ports: z.array(z.string().max(60)).max(20).default([]),
  volumes: z.array(Name).max(20).default([]),
  envFiles: z.array(z.string().max(300)).max(10).default([]),
  /** Names of `${VARS}` the service refers to (never `environment:` values). */
  vars: z.array(z.string().max(80)).max(40).default([]),
  /** The service looks like a database (postgres, mysql, mariadb, mongo, redis image). */
  database: z.enum(['postgres', 'mysql', 'mongo', 'redis', 'other']).optional(),
});
export type ProbeComposeService = z.infer<typeof ProbeComposeServiceSchema>;

export const ProbeComposeFileSchema = z.object({
  path: z.string().max(300),
  project: Name.optional(),
  services: z.array(ProbeComposeServiceSchema).max(40),
  volumes: z.array(Name).max(40).default([]),
  /** The file could not be read as a compose file. */
  unreadable: z.string().max(200).optional(),
});
export type ProbeComposeFile = z.infer<typeof ProbeComposeFileSchema>;

export const ProbeFolderSchema = z.object({
  path: z.string().max(300),
  exists: z.boolean(),
  /** Entry names only (at most 40). */
  entries: z.array(z.string().max(120)).max(40).default([]),
  /** The `.env` in it: key names, plus the value of keys that name an image. */
  envKeys: z.array(z.string().max(80)).max(100).optional(),
  imageVars: z
    .array(z.object({ name: z.string().max(80), value: z.string().max(200) }))
    .max(10)
    .optional(),
});
export type ProbeFolder = z.infer<typeof ProbeFolderSchema>;

export const ProbeBackupsSchema = z.object({
  dir: z.string().max(300),
  count: z.number().int(),
  newestName: z.string().max(200).optional(),
  newestAt: z.string().max(40).optional(),
});

export const ProbeProxySchema = z.object({
  kind: z.enum(['caddy', 'nginx', 'traefik', 'other']),
  via: z.enum(['container', 'systemd']),
  name: Name,
  /** Site addresses only (Caddy site labels, nginx `server_name`). */
  sites: z.array(z.string().max(200)).max(30).default([]),
});

export const ProbeUrlSchema = z.object({
  url: z.string().max(300),
  status: z.number().int().nullable(),
});

export const ProbeSshHostSchema = z.object({
  alias: SshAliasSchema,
  hostname: z.string().max(200).optional(),
  user: z.string().max(80).optional(),
  port: z.number().int().optional(),
  /** An identity file is configured (yes/no; the path is never read or shown). */
  hasIdentity: z.boolean().default(false),
  state: z.enum([
    'reachable',
    'asks_password',
    'unreachable',
    'host_key_unknown',
    'host_key_changed',
    'unchecked',
  ]),
  detail: z.string().max(200).optional(),
});
export type ProbeSshHost = z.infer<typeof ProbeSshHostSchema>;

export const ProbeReportSchema = z.object({
  scope: ProbeScopeSchema,
  at: z.iso.datetime(),
  host: SshAliasSchema.optional(),
  os: z.string().max(80).optional(),
  docker: z
    .object({
      installed: z.boolean(),
      usable: z.boolean(),
      version: z.string().max(40).optional(),
      composeVersion: z.string().max(40).optional(),
    })
    .optional(),
  containers: z.array(ProbeContainerSchema).max(100).default([]),
  composeFiles: z.array(ProbeComposeFileSchema).max(10).default([]),
  volumes: z.array(Name).max(100).default([]),
  folders: z.array(ProbeFolderSchema).max(20).default([]),
  backups: z.array(ProbeBackupsSchema).max(10).default([]),
  proxies: z.array(ProbeProxySchema).max(10).default([]),
  urls: z.array(ProbeUrlSchema).max(10).default([]),
  /** Ports 80 and 443 that something listens on. */
  listeners: z.array(z.number().int()).max(10).default([]),
  freeDiskMb: z.number().int().optional(),
  sshHosts: z.array(ProbeSshHostSchema).max(30).optional(),
});
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

export const DeployProbeResultSchema = z.union([
  z.object({ ok: z.literal(true), report: ProbeReportSchema }),
  z.object({ ok: z.literal(false), error: ProbeErrorSchema, detail: z.string().max(300).optional() }),
]);
export type DeployProbeResult = z.infer<typeof DeployProbeResultSchema>;

/** The reachability of a target's server from one workstation, as stored and shown. */
export const CONNECTION_STATES = [
  'reachable',
  'asks_password',
  'unreachable',
  'host_key_unknown',
  'host_key_changed',
  'unchecked',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** A short sentence for an error, in plain words (the probe error codes of section 6.1). */
export function probeErrorText(error: ProbeError, host?: string): string {
  switch (error) {
    case 'docker_missing':
      return 'Docker is not installed on this computer. Install Docker, then check again.';
    case 'docker_permission':
      return 'Your user on this computer cannot use Docker. On Linux, an admin adds you to the docker group.';
    case 'ssh_auth':
      return `${host ?? 'The server'} asks for a password. This computer needs a sign-in that works without typing one (an ssh key).`;
    case 'ssh_unreachable':
      return `${host ?? 'The server'} cannot be reached from this computer.`;
    case 'ssh_host_key_changed':
      return `The identity of ${host ?? 'the server'} changed. This can mean it was reinstalled, or someone is in between. Guildwise will not connect. If you reinstalled it, remove the old entry with ssh-keygen -R ${host ?? '<host>'} and check again.`;
    case 'ssh_host_key_unknown':
      return `This computer has never connected to ${host ?? 'the server'}. Connect once with ssh and check the fingerprint, then check again.`;
    case 'timeout':
      return 'The check did not finish in 60 seconds.';
    case 'unsupported_os':
      return 'This computer cannot be checked from here.';
    case 'bad_request':
      return 'That check could not be started.';
  }
}
