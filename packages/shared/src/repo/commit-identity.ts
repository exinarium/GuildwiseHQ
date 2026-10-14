import { z } from 'zod';

/**
 * "Commit as" (backlog #65, invisible organisation): the name and e-mail every commit of a project carries. Not a secret.
 * Resolution order on the workstation: this project setting, else the clone's own `git config` (repository level), else
 * the workstation user's global git config, else the runner refuses to commit (never an agent or product name).
 */
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export const CommitAsSchema = z.object({
  name: z.string().trim().min(1, 'a name is needed').max(120),
  email: z
    .string()
    .trim()
    .max(200)
    .refine((v) => EMAIL.test(v), 'that does not look like an e-mail address'),
});
export type CommitAs = z.infer<typeof CommitAsSchema>;

/** `null` clears the setting (the runner then uses the repository or workstation git identity). */
export const SetCommitAsRequestSchema = z.object({ commitAs: CommitAsSchema.nullable() });
export type SetCommitAsRequest = z.infer<typeof SetCommitAsRequestSchema>;

export const COMMIT_IDENTITY_SOURCES = ['project', 'repo', 'global', 'system'] as const;
export const CommitIdentitySourceSchema = z.enum(COMMIT_IDENTITY_SOURCES);
export type CommitIdentitySource = z.infer<typeof CommitIdentitySourceSchema>;

/** What the runner reports per repository: the identity its commits would carry there (without the project setting). */
export const RepoIdentityFactSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(200),
  source: CommitIdentitySourceSchema,
});
export type RepoIdentityFact = z.infer<typeof RepoIdentityFactSchema>;

/** Where the identity comes from, in the owner's words. */
export const COMMIT_IDENTITY_SOURCE_LABEL: Record<CommitIdentitySource, string> = {
  project: "this project's Commit as setting",
  repo: "the repository's own git config",
  global: "the workstation's global git config",
  system: "the workstation's system git config",
};

/** The message when no identity is set anywhere; names the three places to set it. */
export const NO_COMMIT_IDENTITY_MESSAGE =
  'No commit identity is set, so nothing was committed. Set it in one of three places: Project settings > Commit as, ' +
  '`git config user.name` / `user.email` in the repository, or `git config --global user.name` / `user.email` on the workstation.';

/** The settings response: the setting and, per workstation clone, the identity commits would carry there. */
export const CommitAsResponseSchema = z.object({
  commitAs: CommitAsSchema.nullable(),
  /** One row per workstation clone of a project repository, from the runner's repo report. */
  clones: z.array(
    z.object({
      repoId: z.uuid(),
      repoName: z.string(),
      workstationId: z.uuid(),
      workstationName: z.string(),
      /** What the clone's git config gives (project setting excluded); null: none set, commits are refused there. */
      identity: RepoIdentityFactSchema.nullable(),
    }),
  ),
});
export type CommitAsResponse = z.infer<typeof CommitAsResponseSchema>;

/** Error code so callers can tell a refused commit from other failures. */
export const NO_COMMIT_IDENTITY_CODE = 'no_commit_identity';
