import { z } from 'zod';
import { OfficeHoursSchema } from '../cloud/hours.ts';
import { IsoTime } from './common.ts';

/**
 * Cloud workstations (docs/design/cloud-workstations-and-forges.md part 1, decisions C1 to C8): a machine somewhere
 * else that runs our runner: any VPS over SSH, or a GitHub Codespace. The user pays their own provider. The server
 * never stores a Claude credential, an SSH password or an SSH key.
 */
export const CloudProviderSchema = z.enum(['ssh', 'codespaces']);
export type CloudProvider = z.infer<typeof CloudProviderSchema>;

export const CloudStateSchema = z.enum([
  'installing',
  'running',
  'stopped',
  'starting',
  'stopping',
  /** The install or a start failed; `stateDetail` says why. */
  'failed',
  /** Needs the user: GitHub credits ran out, the token expired, ... */
  'needs_attention',
]);
export type CloudState = z.infer<typeof CloudStateSchema>;

/** `individual_use`: the user signed in with a Claude subscription (allowed, with a warning). */
export const CloudAuthModeSchema = z.enum(['api_key', 'subscription']);
export type CloudAuthMode = z.infer<typeof CloudAuthModeSchema>;

export const CloudWorkstationSchema = z.object({
  id: z.uuid(),
  provider: CloudProviderSchema,
  name: z.string(),
  /** Null: one for the whole organization (the default). */
  projectId: z.uuid().nullable(),
  state: CloudStateSchema,
  stateDetail: z.string(),
  /** The paired workstation, once the runner has paired. */
  workstationId: z.uuid().nullable(),
  connected: z.boolean(),
  idleMinutes: z.number().int(),
  officeHours: OfficeHoursSchema.nullable(),
  authMode: CloudAuthModeSchema,
  /** Where it runs, for display: `host:port` or `owner/repo (machine)`. */
  location: z.string(),
  /** A VPS has no start/stop we know: waking and stopping are manual. */
  manualPower: z.boolean(),
  /** Codespaces cannot run Docker deploys: the user still needs a workstation or VPS for that. */
  canDeployDocker: z.boolean(),
  monthlyEstimateUsd: z.number(),
  estimateBasis: z.string(),
  lastActivityAt: IsoTime.nullable(),
  createdAt: IsoTime,
});
export type CloudWorkstation = z.infer<typeof CloudWorkstationSchema>;

export const CloudWorkstationListSchema = z.object({
  cloudWorkstations: z.array(CloudWorkstationSchema),
  /** Is there a workstation or VPS that can deploy Docker images? Drives the Codespaces notice. */
  hasDockerCapableWorkstation: z.boolean(),
});

const HostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, 'host name or IP address');

export const CreateVpsRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    host: HostSchema,
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().trim().min(1).max(64).regex(/^[a-z_][a-z0-9_-]*$/i, 'a Linux user name'),
    /** Sent once to install, never stored. */
    password: z.string().min(1).max(512).optional(),
    privateKey: z.string().min(1).max(20000).optional(),
    passphrase: z.string().max(512).optional(),
    /** The host key fingerprint (SHA256:...) the user checked; omitted: trust on first use, the fingerprint is shown. */
    hostFingerprint: z.string().max(120).optional(),
    projectId: z.uuid().nullable().default(null),
    authMode: CloudAuthModeSchema.default('api_key'),
    /** What the VPS costs a month, for the estimate. */
    monthlyPriceUsd: z.number().min(0).max(100000).nullable().default(null),
  })
  .refine((v) => !!v.password !== !!v.privateKey, {
    message: 'give either a password or a private key',
    path: ['password'],
  });
export type CreateVpsRequest = z.infer<typeof CreateVpsRequestSchema>;

export const PatchCloudWorkstationRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  idleMinutes: z.number().int().min(5).max(240).optional(),
  officeHours: OfficeHoursSchema.nullable().optional(),
  monthlyPriceUsd: z.number().min(0).max(100000).nullable().optional(),
});
export type PatchCloudWorkstationRequest = z.infer<typeof PatchCloudWorkstationRequestSchema>;

/** `POST /api/cloud-workstations/github/connect`: a token with the `codespace` scope; kept encrypted, per user. */
export const ConnectGithubRequestSchema = z.object({ token: z.string().trim().min(10).max(500) });
export const GithubConnectionSchema = z.object({
  connected: z.boolean(),
  login: z.string().nullable(),
});
export type GithubConnection = z.infer<typeof GithubConnectionSchema>;

export const CreateCodespaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** `owner/name`. */
  repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/),
  machine: z.string().min(1).max(64),
  ref: z.string().trim().max(200).optional(),
  devcontainerPath: z.string().trim().max(200).default('.devcontainer/guildwise/devcontainer.json'),
  projectId: z.uuid().nullable().default(null),
  authMode: CloudAuthModeSchema.default('api_key'),
});
export type CreateCodespaceRequest = z.infer<typeof CreateCodespaceRequestSchema>;

export const DevcontainerQuerySchema = z.object({
  /** Comma-separated stack ids from the runner's detection (`node,python`). */
  stacks: z.string().max(200).default(''),
  name: z.string().max(80).default('Guildwise workstation'),
});

/** `POST /api/runner/enroll` (unauthenticated: the codespace name and the codespace's own GitHub token are the proof). */
export const RunnerEnrollRequestSchema = z.object({
  codespaceName: z.string().min(1).max(100),
  githubToken: z.string().min(10).max(500),
  name: z.string().min(1).max(80),
  platform: z.string(),
  hostname: z.string(),
  runnerVersion: z.string(),
});
export type RunnerEnrollRequest = z.infer<typeof RunnerEnrollRequestSchema>;
