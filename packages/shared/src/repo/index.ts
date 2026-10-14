import { z } from 'zod';
import { CONNECTABLE_FORGES, createFullNameError, ForgeKindSchema } from '../forge/index.ts';
import { CommitAsSchema } from './commit-identity.ts';

export * from './commit-identity.ts';

/**
 * Approved repository setup (docs/SPEC.md, "External systems boundary"): an agent asks, the project owner approves on
 * the desk, and the owner's own runner creates the GitHub repository with their local `gh` login. Agents never hold
 * the credentials and never run `gh repo create` themselves.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/repo` with GitHub's character set; refuses `.`/`..`, a leading `-` and a `.git` suffix. */
export function repoNameError(name: string): string | null {
  const parts = name.split('/');
  if (parts.length !== 2) return 'the repository name must be <owner>/<repo>';
  const [owner, repo] = parts as [string, string];
  if (!OWNER.test(owner)) return 'the owner may only contain letters, digits and "-" (at most 39 characters)';
  if (!REPO.test(repo) || repo === '.' || repo === '..' || repo.startsWith('-') || repo.endsWith('.git'))
    return 'the repository name may only contain letters, digits, ".", "_" and "-" (at most 100 characters, no ".git" suffix)';
  return null;
}

export const RepoNameSchema = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const err = repoNameError(v);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  });

export const RepoVisibilitySchema = z.enum(['private', 'public']);
export type RepoVisibility = z.infer<typeof RepoVisibilitySchema>;

export const RepoDescriptionSchema = z
  .string()
  .max(350)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), {
    message: 'the description must be a single line of text',
  });

/** Git hosts a repository can be created on (the connectable ones). */
export const RepoProviderSchema = z.enum(CONNECTABLE_FORGES);
export type RepoProvider = z.infer<typeof RepoProviderSchema>;

/** A host name for a GitHub Enterprise Server or self-managed GitLab. */
export const RepoHostSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]{0,198}[A-Za-z0-9])?$/, {
    message: 'the host must be a plain host name such as gitlab.example.com',
  });

/** The name shape each provider takes, in plain words (for usage text and errors). */
export const REPO_NAME_SHAPE: Record<RepoProvider, string> = {
  github: '<owner>/<repo>',
  gitlab: '<group>[/<subgroup>...]/<project>',
  'azure-devops': '<organization>/<project>/<repo>',
  'bitbucket-cloud': '<workspace>/<repo>',
};

/** Null when `name` is a valid new-repository name for `provider`, else the reason (names the shape). */
export function repoNameErrorFor(provider: RepoProvider, name: string): string | null {
  const err = provider === 'github' ? repoNameError(name) : createFullNameError(provider, name);
  return err ? `${err} (${provider} names look like ${REPO_NAME_SHAPE[provider]})` : null;
}

/**
 * What `aom repo create` sends (`repo.create` rpc). `provider` defaults to GitHub; the name takes the provider's shape:
 * `owner/repo` (GitHub), `group/subgroup/project` (GitLab), `organization/project/repo` (Azure DevOps),
 * `workspace/repo` (Bitbucket Cloud).
 */
export const RepoCreateParamsSchema = z
  .object({
    name: z.string().trim().min(3).max(400),
    provider: RepoProviderSchema.default('github'),
    /** Only for GitHub Enterprise Server and self-managed GitLab. */
    host: RepoHostSchema.optional(),
    visibility: RepoVisibilitySchema,
    project: z.string().min(1),
    description: RepoDescriptionSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const err = repoNameErrorFor(v.provider, v.name);
    if (err) ctx.addIssue({ code: 'custom', path: ['name'], message: err });
    if (v.host && v.provider !== 'github' && v.provider !== 'gitlab')
      ctx.addIssue({ code: 'custom', path: ['host'], message: `${v.provider} has no custom host` });
  });
export type RepoCreateParams = z.infer<typeof RepoCreateParamsSchema>;

export const REPO_REQUEST_STATUS = ['pending', 'approved', 'rejected', 'created', 'failed'] as const;
export type RepoRequestStatus = (typeof REPO_REQUEST_STATUS)[number];

/** Payload of the `repo.create` runner command. */
export const RepoCreatePayloadSchema = z
  .object({
    requestId: z.uuid(),
    /** `owner/repo` for GitHub; `group/sub/project` (GitLab), `workspace/repo`, `org/project/repo` for the others. */
    name: z.string().min(3).max(400),
    /** The git provider the repository is made on (absent: GitHub, the original behaviour). */
    provider: ForgeKindSchema.optional(),
    /** Host of a self-managed GitLab or a GitHub Enterprise Server (absent: the public host). */
    host: z.string().max(200).optional(),
    visibility: RepoVisibilitySchema,
    description: RepoDescriptionSchema.optional(),
    projectKey: z.string(),
    projectName: z.string(),
    /** The branch the initial commit goes to (the project's working branch). */
    branch: z.string().default('main'),
    /** The project's "Commit as" setting for the initial commit (absent: the workstation's git identity). */
    commitAs: CommitAsSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const err =
      (v.provider ?? 'github') === 'github'
        ? repoNameError(v.name)
        : createFullNameError(v.provider as never, v.name);
    if (err) ctx.addIssue({ code: 'custom', path: ['name'], message: err });
  });
export type RepoCreatePayload = z.infer<typeof RepoCreatePayloadSchema>;

/** The runner's `command.result` for `repo.create`. */
export const RepoCreateResultSchema = z.object({
  ok: z.boolean(),
  /** The remote URL the project will use (what `git remote get-url origin` says in the new clone). */
  remoteUrl: z.string().optional(),
  localPath: z.string().optional(),
  /** The repository (or its clone) already existed and was reused, nothing new was created. */
  existing: z.boolean().optional(),
  error: z.string().optional(),
});
export type RepoCreateResult = z.infer<typeof RepoCreateResultSchema>;
