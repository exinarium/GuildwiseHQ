import { z } from 'zod';
import { ForgeKindSchema } from '../forge/index.ts';
import { CommitAsSchema } from '../repo/commit-identity.ts';
import { ComponentRuleSchema } from '../repo/component-rules.ts';
import { ReleasePrepChangelogPayloadSchema } from './changelog-entries.ts';

/** The change summary of 'Analyse changes' for one repository (stored per repo, capped to keep events small). */
export const ReleaseDocsPrepSummarySchema = z.object({
  repoName: z.string().max(200).default(''),
  branch: z.string().max(200),
  headSha: z.string().max(40),
  base: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tag'), tag: z.string().max(100), sha: z.string().max(40) }),
    z.object({ kind: z.literal('main'), branch: z.string().max(200), sha: z.string().max(40) }),
  ]),
  commitCount: z.number().int().nonnegative(),
  commits: z
    .array(
      z.object({
        sha: z.string().max(40),
        subject: z.string().max(300),
        author: z.string().max(200),
        date: z.string().max(40),
      }),
    )
    .max(300),
  commitsTruncated: z.boolean().default(false),
  merges: z
    .array(
      z.object({
        sha: z.string().max(40),
        subject: z.string().max(300),
        cardKeys: z.array(z.string().max(40)).max(20),
        prNumber: z.number().int().nullable(),
      }),
    )
    .max(300),
  cards: z.array(z.object({ key: z.string().max(40), title: z.string().max(300).nullable() })).max(500),
  areas: z
    .array(
      z.object({
        area: z.string().max(200),
        files: z.number().int().nonnegative(),
        added: z.number().int().nonnegative(),
        modified: z.number().int().nonnegative(),
        deleted: z.number().int().nonnegative(),
        paths: z.array(z.string().max(300)).max(50),
      }),
    )
    .max(100),
});
export type ReleaseDocsPrepSummary = z.infer<typeof ReleaseDocsPrepSummarySchema>;

/** Body of PUT /api/projects/:id/release-docs-prep/settings. Unknown step ids are refused by the server (400). */
export const ReleaseDocsPrepSettingsSchema = z.object({
  enabled: z.boolean(),
  steps: z.record(z.string().max(40), z.boolean()),
});

export const ReleaseDocsPrepSettingsDtoSchema = z.object({
  enabled: z.boolean(),
  steps: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      requires: z.array(z.string()).optional(),
    }),
  ),
  canEdit: z.boolean(),
});
export type ReleaseDocsPrepSettingsDto = z.infer<typeof ReleaseDocsPrepSettingsDtoSchema>;

const StepState = z.enum(['pending', 'running', 'passed', 'failed', 'skipped']);

export const ReleaseDocsPrepRunDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  releaseBranch: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'skipped']),
  trigger: z.enum(['manual', 'retry', 'skip']),
  retryOf: z.string().nullable(),
  startedBy: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  failed: z
    .object({
      step: z.string(),
      repoId: z.string().nullable(),
      repoName: z.string().nullable(),
      error: z.string(),
    })
    .nullable(),
  skippedBy: z.string().nullable(),
  skippedAt: z.string().nullable(),
  steps: z.array(z.string()),
  repos: z.array(
    z.object({
      repoId: z.string(),
      repoName: z.string(),
      branch: z.string(),
      state: StepState,
      baseTag: z.string().nullable(),
      headSha: z.string().nullable(),
      commitSha: z.string().nullable(),
      pushed: z.boolean(),
      summary: ReleaseDocsPrepSummarySchema.nullable(),
      steps: z.array(
        z.object({
          step: z.string(),
          phase: z.string(),
          state: StepState,
          startedAt: z.string().nullable(),
          finishedAt: z.string().nullable(),
          error: z.string().nullable(),
          files: z.array(z.string()),
          /** What the step reports (per step id; 'changelog': ReleaseChangelogOutput). */
          output: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
export type ReleaseDocsPrepRunDto = z.infer<typeof ReleaseDocsPrepRunDtoSchema>;

export const ReleaseDocsPrepOverviewItemSchema = z.object({
  projectId: z.string(),
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  releaseBranch: z.string().nullable(),
  state: z.enum(['off', 'not_run', 'running', 'passed', 'failed', 'skipped']),
  canAct: z.boolean(),
  run: ReleaseDocsPrepRunDtoSchema.nullable(),
});
export type ReleaseDocsPrepOverviewItem = z.infer<typeof ReleaseDocsPrepOverviewItemSchema>;

/** Shown on the Ship release item and the repo row, only when the switch is on. */
export const ReleaseDocsPrepGateViewSchema = z.object({
  blocked: z.boolean(),
  message: z.string().optional(),
  link: z.string(),
});
export type ReleaseDocsPrepGateView = z.infer<typeof ReleaseDocsPrepGateViewSchema>;

export const releaseDocsPrepLink = (projectId: string): string =>
  `/releases?tab=prep#release-docs-prep-${projectId}`;

/** The payload of `release.docs_prep` (one step in one repository). */
export const ReleaseDocsPrepPayloadSchema = z.object({
  runId: z.uuid(),
  projectId: z.uuid(),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string().min(1).max(500),
  forge: ForgeKindSchema.optional(),
  releaseBranch: z.string().min(1).max(200),
  mainBranch: z.string().max(200).optional(),
  step: z.string().min(1).max(40),
  phase: z.enum(['prepare', 'push']).optional(),
  components: z.array(ComponentRuleSchema).max(20).default([]),
  projectKey: z.string().max(40).default(''),
  summary: ReleaseDocsPrepSummarySchema.optional(),
  base: z.object({ sha: z.string().max(40), tag: z.string().max(100).nullable() }).optional(),
  message: z.string().max(500).optional(),
  commitAs: CommitAsSchema.nullable().optional(),
  signOff: z.boolean().optional(),
  /** Step 'changelog': the checked entries to merge into Unreleased. */
  changelog: ReleasePrepChangelogPayloadSchema.optional(),
});

export type ReleaseDocsPrepPayload = z.infer<typeof ReleaseDocsPrepPayloadSchema>;

/** The answer of `release.docs_prep`. */
export const ReleaseDocsPrepResultSchema = z.object({
  ok: z.boolean(),
  state: z.enum(['passed', 'failed', 'skipped']),
  error: z.string().max(4000).optional(),
  summary: ReleaseDocsPrepSummarySchema.optional(),
  baseTag: z.string().max(100).nullable().optional(),
  baseSha: z.string().max(40).optional(),
  headSha: z.string().max(40).optional(),
  files: z.array(z.string().max(300)).max(500).default([]),
  commit: z.string().max(40).optional(),
  pushed: z.boolean().optional(),
  alreadyPushed: z.boolean().optional(),
  notices: z.array(z.string().max(500)).default([]),
  /** A content step's report (shown on the Releases page; the server checks the size and the step's schema). */
  output: z.unknown().optional(),
});
export type ReleaseDocsPrepResult = z.infer<typeof ReleaseDocsPrepResultSchema>;

export const RELEASE_DOCS_PREP_CAPABILITY = 'release-docs-prep:1';
/** The runner can apply the entries of the step 'changelog'. */
export const RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY = 'release-docs-prep-changelog:1';

/** The largest step output stored (serialised JSON). */
export const RELEASE_DOCS_PREP_OUTPUT_MAX_BYTES = 64 * 1024;
