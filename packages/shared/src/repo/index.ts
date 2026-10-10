import { z } from 'zod';
import { createFullNameError, ForgeKindSchema } from '../forge/index.ts';

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

/** What `aom repo create` sends (`repo.create` rpc). */
export const RepoCreateParamsSchema = z.object({
  name: RepoNameSchema,
  visibility: RepoVisibilitySchema,
  project: z.string().min(1),
  description: RepoDescriptionSchema.optional(),
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
