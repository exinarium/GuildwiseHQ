import { z } from 'zod';
import { VaultFolderSchema } from '../safe.ts';
import { SECRET_NAME } from './recipe.ts';

/**
 * The wire between the server and a workstation for delivery recipes (docs/design/ceo-front-door.md sections 9.4 and 9.5):
 * durable commands `recipe.inspect`, `deploy.exec` and `deploy.secret.set`. Results travel in `command.result`; a refusal
 * or a failed deploy is an ANSWER (`ok:true`, `outcome` says which), never a blind retry of a deploy.
 */

/** Announced in `hello.capabilities` by a runner that can inspect recipes and run `deploy.exec`. */
export const DELIVERY_CAPABILITY = 'delivery:1';

export const DeployVaultRefSchema = z.object({
  vaultId: z.string().min(1).max(64),
  storage: z.enum(['git', 'local']),
  /** The project's folder in the vault: recipes live in `<folder>/delivery/`. */
  folder: VaultFolderSchema,
});
export type DeployVaultRef = z.infer<typeof DeployVaultRefSchema>;

export const RecipeFileInfoSchema = z.object({
  path: z.string().max(300),
  mode: z.enum(['755', '644']),
  sha256: z.string().length(64),
  /** What kind of secret the file seems to hold (never the secret). */
  secret: z.string().max(80).nullable().optional(),
});
export type RecipeFileInfo = z.infer<typeof RecipeFileInfoSchema>;

export const RecipeInspectPayloadSchema = z.object({
  projectId: z.uuid(),
  vault: DeployVaultRefSchema,
  /** Inspect the vault at this commit (default: the clone's HEAD; a local vault has no commits). */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
});
export type RecipeInspectPayload = z.infer<typeof RecipeInspectPayloadSchema>;

export const RecipeInspectResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    present: z.boolean(),
    vaultCommit: z.string().nullable(),
    hash: z.string().length(64),
    files: z.array(RecipeFileInfoSchema).max(500),
    /** The parsed, normalized recipe (no secret values exist in it); null when absent or unreadable. */
    recipe: z.unknown().nullable(),
    parseError: z.string().max(1000).optional(),
    /** The runner's own findings: secrets, a missing or non-executable script. The server adds the checks it can make. */
    lint: z.array(z.unknown()).max(100),
    /** `delivery/setup.json` when the bundle has a valid one (the guided setup): the server compiles it to find hand-edited scripts. */
    setup: z.unknown().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string().max(500) }),
]);
export type RecipeInspectResult = z.infer<typeof RecipeInspectResultSchema>;

/**
 * `recipe.write` (guided deploy setup): replace `<folder>/delivery/` of the project vault with generated files in one commit.
 * Not an envelope command: nothing in it is secret (the runner refuses a file the secret scan flags). `keep` names files of the
 * current `delivery/` that stay as they are (scripts of environments in custom mode). `expectedHash` is the content hash of
 * `files` that the preview showed; a mismatch refuses the write.
 */
export const RecipeWriteFileSchema = z.object({
  path: z.string().min(1).max(200),
  mode: z.enum(['755', '644']),
  content: z.string().max(200_000),
});
export const RecipeWritePayloadSchema = z.object({
  projectId: z.uuid(),
  vault: DeployVaultRefSchema,
  files: z.array(RecipeWriteFileSchema).min(1).max(40),
  keep: z.array(z.string().min(1).max(200)).max(20).default([]),
  commitMessage: z.string().min(1).max(200),
  expectedHash: z.string().length(64),
  setupHash: z.string().length(64),
});
export type RecipeWritePayload = z.infer<typeof RecipeWritePayloadSchema>;

export const RecipeWriteResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    committed: z.boolean(),
    pushed: z.boolean(),
    vaultCommit: z.string().nullable(),
    /** What `delivery/` holds now (inspected after the write). */
    inspected: RecipeInspectResultSchema,
  }),
  z.object({ ok: z.literal(false), error: z.string().max(500) }),
]);
export type RecipeWriteResult = z.infer<typeof RecipeWriteResultSchema>;

/** `aom deploy probe` (DevOps in a scan): the same fixed probe, answered on the workstation. */
export const DeployProbeParamsSchema = z.object({
  local: z.boolean().optional(),
  sshHosts: z.boolean().optional(),
  host: z.string().max(64).optional(),
  composeFile: z.array(z.string().max(300)).max(10).optional(),
  dir: z.array(z.string().max(300)).max(10).optional(),
  url: z.array(z.string().max(300)).max(10).optional(),
});

export const DeployExecPayloadSchema = z.object({
  runId: z.uuid(),
  orgId: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string().max(10),
  vault: DeployVaultRefSchema,
  /** The vault commit the recipe was approved at (null for a local vault: the folder's hash is what counts). */
  vaultCommit: z.string().nullable(),
  /** The approved content hash: the runner recomputes it from what it exports, and refuses on a mismatch. */
  hash: z.string().length(64),
  env: z.string().min(1).max(40),
  target: z.object({
    id: z.uuid().nullable(),
    name: z.string().max(80),
    kind: z.string().max(20),
    host: z.string().max(200).nullable(),
    appUrl: z.string().max(500).nullable(),
  }),
  /** The commit to deploy (null: the repository's working branch head, resolved on the workstation and reported). */
  commit: z.string().nullable(),
  repo: z
    .object({
      repoId: z.uuid(),
      name: z.string().max(120),
      remoteUrlNormalized: z.string().max(500),
      workingBranch: z.string().max(200).nullable(),
    })
    .nullable(),
  /** A trial of a recipe that is not approved yet (never production), or a production dry run. */
  trial: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  expiresAt: z.iso.datetime(),
});
export type DeployExecPayload = z.infer<typeof DeployExecPayloadSchema>;

export const DEPLOY_REFUSALS = [
  'hash_mismatch',
  'no_recipe',
  'bad_recipe',
  'unknown_env',
  'target_not_in_recipe',
  'vault_unavailable',
  'commit_unavailable',
  'no_checkout',
  'expired',
  'wrong_workstation',
] as const;

export const DeployExecResultSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'refused']),
  /** `hash_mismatch`, `missing_secret:NAME`, ... */
  refused: z.string().max(200).optional(),
  exitCode: z.number().int().nullable().optional(),
  health: z
    .object({ ok: z.boolean(), detail: z.string().max(300).optional() })
    .nullable()
    .optional(),
  smoke: z
    .object({ ok: z.boolean(), detail: z.string().max(300).optional() })
    .nullable()
    .optional(),
  /** What the script printed on its `AOM-DEPLOY {json}` line. */
  deployed: z
    .object({
      commit: z.string().max(64).optional(),
      url: z.string().max(500).optional(),
      version: z.string().max(80).optional(),
    })
    .optional(),
  deployedCommit: z.string().max(64).nullable().optional(),
  /** Redacted. */
  logTail: z.string().max(6000).default(''),
  durationMs: z.number().int().nonnegative().default(0),
  /** The hash the runner computed from what it exported. */
  hash: z.string().length(64).optional(),
  summary: z.string().max(500).default(''),
});
export type DeployExecResult = z.infer<typeof DeployExecResultSchema>;

/** `deploy.secret.set`: one sealed value for a project's recipe, kept only on the workstation. */
export const DeploySecretSetPayloadSchema = z.object({
  projectId: z.uuid(),
  name: z.string().regex(SECRET_NAME),
  keyId: z.string().min(1).max(100),
  ciphertext: z.string().min(1).max(4000),
});
export type DeploySecretSetPayload = z.infer<typeof DeploySecretSetPayloadSchema>;

// ------------------------------------------------------------------------------ IPC (aom deploy ..., aom recipe save)

export const DeployRunParamsSchema = z.object({
  env: z.string().min(1).max(40),
  project: z.string().min(2).max(10).optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  target: z.string().max(80).optional(),
  reason: z.string().max(500).optional(),
});
export const DeployTrialParamsSchema = z.object({
  env: z.string().min(1).max(40),
  project: z.string().min(2).max(10).optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  target: z.string().max(80).optional(),
});
export const DeployStatusParamsSchema = z.object({
  project: z.string().min(2).max(10).optional(),
  run: z.uuid().optional(),
  env: z.string().max(40).optional(),
});
/** `recipe.save` is two server calls: `begin` names the vault, `done` reports what the workstation wrote. */
export const RecipeSaveParamsSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('begin'), project: z.string().min(2).max(10) }),
  z.object({
    phase: z.literal('done'),
    project: z.string().min(2).max(10),
    inspected: RecipeInspectResultSchema,
  }),
]);
