import { z } from 'zod';
import { ComponentRuleSchema } from '../repo/component-rules.ts';

export const BumpLevelSchema = z.enum(['patch', 'minor', 'major']);

export const ComponentBumpSchema = z.object({
  name: z.string(),
  level: BumpLevelSchema,
  state: z.enum(['bump', 'already_set', 'unchanged', 'missing']),
  from: z.string().nullable(),
  to: z.string().nullable(),
  changedCount: z.number().int().nonnegative(),
  under: z.string(),
  versionFile: z.string(),
  message: z.string().optional(),
});

/** What the runner read from the repository (`repo.release_facts` answer, stored per repository). */
export const ReleaseFactsSchema = z.object({
  base: z.string().optional(),
  headSha: z.string(),
  baseSha: z.string().optional(),
  ahead: z.number().int().nonnegative(),
  lastTag: z.object({ name: z.string(), sha: z.string() }).nullable(),
  existingTags: z.array(z.string()).max(500).default([]),
  commits: z
    .array(z.object({ sha: z.string().max(40), subject: z.string().max(300), breakingFooter: z.boolean() }))
    .max(1000)
    .default([]),
  commitsTruncated: z.boolean().default(false),
  changedTotal: z.number().int().nonnegative().default(0),
  components: z
    .array(
      z.object({
        name: z.string(),
        changedCount: z.number().int().nonnegative(),
        contentAtHead: z.string().max(262_144).nullable(),
        contentAtTag: z.string().max(262_144).nullable(),
      }),
    )
    .default([]),
  changelog: z.string().max(1_048_576).nullable().default(null),
});
export type ReleaseFacts = z.infer<typeof ReleaseFactsSchema>;

/** The desk item's live view of a release proposal. */
export const ReleaseProposalViewSchema = z.object({
  proposalId: z.uuid(),
  projectId: z.uuid(),
  repoId: z.uuid(),
  repoName: z.string(),
  state: z.enum(['proposed', 'approved', 'dismissed', 'released', 'closed']),
  lastTag: z.string().nullable(),
  base: z.string(),
  recommended: z.object({ version: z.string(), level: BumpLevelSchema, reason: z.string() }),
  headSha: z.string(),
  factsAt: z.string().nullable(),
  factsState: z.enum(['pending', 'ready', 'failed']),
  factsMessage: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  commitsTruncated: z.boolean(),
  today: z.string(),
  changelog: z.object({ present: z.boolean(), empty: z.boolean(), intro: z.string(), body: z.string() }).nullable(),
  notes: z.string(),
  notesEditable: z.boolean(),
  components: z.array(ComponentBumpSchema),
  /** The bumps of every rule at each level, so the desk item can preview a raised level without asking the server. */
  componentVariants: z.object({
    patch: z.array(ComponentBumpSchema),
    minor: z.array(ComponentBumpSchema),
    major: z.array(ComponentBumpSchema),
  }),
  rules: z.array(ComponentRuleSchema.pick({ name: true, paths: true, versionFile: true })),
  existingTags: z.array(z.string()),
});
export type ReleaseProposalView = z.infer<typeof ReleaseProposalViewSchema>;

/** `release` on `POST /api/desk/:id/resolve` when approving a Ship release item. */
export const ShipReleaseApprovalSchema = z.object({
  version: z.string().trim().min(1).max(60),
  components: z.array(z.object({ name: z.string(), level: BumpLevelSchema })).max(20).default([]),
  notes: z.string().max(20_000).optional(),
  factsHeadSha: z.string().max(40),
});
export type ShipReleaseApproval = z.infer<typeof ShipReleaseApprovalSchema>;
