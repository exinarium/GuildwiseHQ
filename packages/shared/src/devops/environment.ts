import { z } from 'zod';
import { DevOpsAccessSchema } from '../events/devops.ts';

/**
 * Workstation preparation by the DevOps engineer (docs/RUNNER.md "Repository setup, toolchain and rights"):
 * cloning a repository added to a project, making the toolchain ready before build work, verifying the rights the
 * manager ticked and keeping the sudo password. The runner does the work with plain code (no agent); these are the
 * commands the server sends and the answers it gets.
 */

// ------------------------------------------------------------------------------------------ repository clone

export const REPO_CLONE_STATES = ['cloning', 'cloned', 'created', 'failed', 'needs_manager'] as const;
export const RepoCloneStateSchema = z.enum(REPO_CLONE_STATES);
export type RepoCloneState = z.infer<typeof RepoCloneStateSchema>;

/** `repo.clone`: put the project repository on this workstation (clone it, or create it first when the manager chose so). */
export const RepoClonePayloadSchema = z.object({
  requestId: z.uuid(),
  repoId: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  /** Directory name for the clone under the first repository root (default: the last segment of the URL). */
  name: z.string().min(1).max(200),
  remoteUrl: z.string().min(1).max(2000),
  /** The project's working branch when the manager named one; used for the initial commit of a created repository. */
  workingBranch: z.string().optional(),
  /** Set when the manager chose "create new": the repository is created (with `gh`) if it does not exist. */
  create: z
    .object({
      /** `owner/repo` */
      name: z.string(),
      visibility: z.enum(['private', 'public']).default('private'),
      description: z.string().max(350).optional(),
    })
    .optional(),
});
export type RepoClonePayload = z.infer<typeof RepoClonePayloadSchema>;

export const RepoCloneResultSchema = z.object({
  ok: z.boolean(),
  state: RepoCloneStateSchema,
  localPath: z.string().optional(),
  /** What happened, one line, for the Repositories tab ("Cloned", "Already cloned", "Created and cloned"). */
  detail: z.string().max(2000).optional(),
  error: z.string().max(2000).optional(),
  /** The directory existed already as a clone of this repository: nothing was cloned. */
  existing: z.boolean().optional(),
});
export type RepoCloneResult = z.infer<typeof RepoCloneResultSchema>;

// ---------------------------------------------------------------------------------------------- environment

export const ENV_STATES = ['preparing', 'ready', 'failed', 'needs_access'] as const;
export const EnvStateSchema = z.enum(ENV_STATES);
export type EnvState = z.infer<typeof EnvStateSchema>;

export const ToolStatusSchema = z.enum(['ok', 'installed', 'missing', 'failed', 'needs_access', 'skipped']);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const ToolReportSchema = z.object({
  /** The stack that needs it (`dotnet-maui`, `node`, ...). */
  stack: z.string(),
  tool: z.string(),
  status: ToolStatusSchema,
  version: z.string().optional(),
  /** Why it is missing or failed, or what was done to install it. */
  detail: z.string().max(1000).optional(),
  /** What the manager can do (grant install access, run a command). */
  fix: z.string().max(1000).optional(),
});
export type ToolReport = z.infer<typeof ToolReportSchema>;

export const EnvironmentReportSchema = z.object({
  state: EnvStateSchema,
  /** The stacks found in the project's repositories. */
  stacks: z.array(z.object({ id: z.string(), name: z.string(), repo: z.string().optional() })).default([]),
  tools: z.array(ToolReportSchema).default([]),
  /** One line for the card and the settings: what is wrong, or "Ready: ...". */
  summary: z.string().max(2000),
  /** Last lines of the install log (the full log is in `logs/env/` on the workstation). */
  logTail: z.array(z.string().max(500)).max(80).default([]),
});
export type EnvironmentReport = z.infer<typeof EnvironmentReportSchema>;

/** `env.ensure`: detect the stacks of these repositories, verify their tools and install what is missing. */
export const EnvEnsurePayloadSchema = z.object({
  requestId: z.uuid(),
  projectId: z.uuid(),
  repos: z.array(z.object({ repoId: z.uuid(), name: z.string(), remoteUrlNormalized: z.string() })).min(1),
  access: DevOpsAccessSchema,
});
export type EnvEnsurePayload = z.infer<typeof EnvEnsurePayloadSchema>;

// ------------------------------------------------------------------------------------------------- rights

export const RIGHT_KEYS = ['docker', 'sudo', 'install', 'paths'] as const;
export type RightKey = (typeof RIGHT_KEYS)[number];
export const RightStatusSchema = z.enum(['verified', 'failed']);

export const RightCheckSchema = z.object({
  status: RightStatusSchema,
  /** What the check found ("docker info works", "permission denied while connecting to the Docker socket"). */
  reason: z.string().max(1000),
  /** How to fix a failed check. */
  fix: z.string().max(1000).optional(),
});
export type RightCheck = z.infer<typeof RightCheckSchema>;

/** Only the rights the manager ticked are checked; a right that is off has no entry. */
export const RightsReportSchema = z.object({
  checkedAt: z.iso.datetime(),
  platform: z.string(),
  checks: z.record(z.string(), RightCheckSchema),
  /** A stored sudo password exists on the runner (never the password itself). */
  sudoPasswordStored: z.boolean().default(false),
});
export type RightsReport = z.infer<typeof RightsReportSchema>;

export const RightsVerifyPayloadSchema = z.object({ access: DevOpsAccessSchema });

// -------------------------------------------------------------------------------------------- sudo password

/** The runner's public key for the sudo password (RSA-OAEP, SHA-256), announced in `hello`. */
export const SudoKeySchema = z.object({
  /** First 16 hex digits of the SHA-256 of the SPKI key: shown in the UI and by `aom-runner doctor` to compare. */
  keyId: z.string(),
  /** Base64 of the DER SPKI public key. */
  publicKey: z.string(),
});
export type SudoKey = z.infer<typeof SudoKeySchema>;

export const SudoSetPayloadSchema = z.object({
  /** Base64 RSA-OAEP ciphertext of the password, encrypted in the browser with the runner's public key. */
  ciphertext: z.string().min(1).max(2000),
  keyId: z.string(),
});
export type SudoSetPayload = z.infer<typeof SudoSetPayloadSchema>;

export const SudoSetResultSchema = z.object({
  /** The password was decrypted and stored. */
  stored: z.boolean(),
  /** `sudo -S -v` accepted it. */
  works: z.boolean().optional(),
  error: z.string().max(500).optional(),
});
export type SudoSetResult = z.infer<typeof SudoSetResultSchema>;
