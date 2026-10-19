import { z } from 'zod';
import { GraphFailReasonSchema, OrgLinkEndpointSchema, OrgLinkKindSchema } from '../graph/index.ts';
import { IsoTime } from './common.ts';

/**
 * `GET /api/projects/:id/graph`: the STATUS of a project's code graph (docs/design/project-graphs.md owner decision 5).
 * There is no graph view and nothing derived from code: only the indexed commit, counts, the indexer version and timings.
 */
export const ProjectGraphRepoStatusSchema = z.object({
  repoId: z.uuid(),
  repoName: z.string(),
  status: z.enum(['none', 'requested', 'indexed', 'failed']),
  commit: z.string().nullable(),
  files: z.number().int(),
  nodes: z.number().int(),
  edges: z.number().int(),
  modules: z.number().int(),
  indexerVersion: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  indexedAt: IsoTime.nullable(),
  failReason: GraphFailReasonSchema.nullable(),
});
export type ProjectGraphRepoStatus = z.infer<typeof ProjectGraphRepoStatusSchema>;

export const ProjectGraphStatusSchema = z.object({
  /** `projectGraphs.enabled` of this server. */
  enabled: z.boolean(),
  /** Where the graph is kept: the project vault (`local`: a folder on one workstation, not synced; `git`: synced). */
  vault: z.object({ storage: z.enum(['git', 'local']), kind: z.enum(['org', 'project']) }).nullable(),
  repos: z.array(ProjectGraphRepoStatusSchema),
});
export type ProjectGraphStatus = z.infer<typeof ProjectGraphStatusSchema>;

/**
 * `GET /api/value/graph`: the measured effect of the code graph (docs/design/project-graphs.md section 11): billed input
 * tokens per accepted card for each arm, the ratio with its interval, the quality guards and whether the claim is allowed.
 * Aggregates of numbers only.
 */
const ArmSummarySchema = z.object({
  cards: z.number().int(),
  median: z.number().nullable(),
  p25: z.number().nullable(),
  p75: z.number().nullable(),
});
const GuardsSchema = z.object({
  reworkRounds: z.number(),
  changesRequested: z.number(),
  testerFailures: z.number(),
  daysToDone: z.number(),
  costPerCardUsd: z.number(),
});
const DiscoverySchema = z.object({
  medianBytes: z.number().nullable(),
  medianCalls: z.number().nullable(),
  medianGraphCalls: z.number().nullable(),
});
export const GraphContextReportSchema = z.object({
  /** A holdout window is running (the arms are still being filled). */
  evaluating: z.boolean(),
  windowEndsAt: IsoTime.nullable(),
  on: ArmSummarySchema,
  off: ArmSummarySchema,
  interval: z.object({ ratio: z.number(), lo: z.number(), hi: z.number() }).nullable(),
  guards: z.object({ on: GuardsSchema.nullable(), off: GuardsSchema.nullable() }),
  discovery: z.object({ on: DiscoverySchema, off: DiscoverySchema }),
  claim: z.object({
    allowed: z.boolean(),
    reason: z.enum(['ok', 'not_enough_cards', 'interval_includes_one', 'no_saving', 'guard_worse']),
    savingPercent: z.number().int().nullable(),
    worseGuards: z.array(
      z.enum(['reworkRounds', 'changesRequested', 'testerFailures', 'daysToDone', 'costPerCardUsd']),
    ),
  }),
});
export type GraphContextReport = z.infer<typeof GraphContextReportSchema>;

// ---------------------------------------------------------------------------------- links the Owner asserted

/**
 * Links between projects that the Owner (or an Admin) asserted: project ids, or names they typed. The derived links (from
 * code) are not here and not on any server table: they stay in the organization vault on the workstation, and the CEO shows
 * them in chat (docs/design/project-graphs.md section 8).
 */
export const CreateOrgGraphLinkRequestSchema = z.object({
  from: OrgLinkEndpointSchema,
  to: OrgLinkEndpointSchema,
  kind: OrgLinkKindSchema.default('related'),
  note: z.string().trim().max(300).optional(),
  /** `accepted-draft`: the person confirmed a link the CEO showed them (both ends are then projects). */
  origin: z.enum(['owner', 'accepted-draft']).optional(),
});
export type CreateOrgGraphLinkRequest = z.infer<typeof CreateOrgGraphLinkRequestSchema>;

const LinkEndSchema = z.object({
  projectId: z.uuid().nullable(),
  /** The project key, or the name the person typed. */
  label: z.string(),
});
export const OrgGraphLinkDtoSchema = z.object({
  id: z.uuid(),
  from: LinkEndSchema,
  to: LinkEndSchema,
  kind: OrgLinkKindSchema,
  note: z.string().nullable(),
  origin: z.enum(['owner', 'accepted-draft']),
  assertedAt: IsoTime,
});
export type OrgGraphLinkDto = z.infer<typeof OrgGraphLinkDtoSchema>;
export const OrgGraphLinksResponseSchema = z.object({ links: z.array(OrgGraphLinkDtoSchema) });
export type OrgGraphLinksResponse = z.infer<typeof OrgGraphLinksResponseSchema>;
