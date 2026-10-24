import { z } from 'zod';
import {
  LegacyPackUrlSchema,
  PackAdapterSchema,
  PackDiffSchema,
  PackIssueSchema,
  PackNameSchema,
  PackRefSchema,
  PackScopeSchema,
  PackShaSchema,
  PackSnapshotSchema,
} from './packs.ts';
import { RegistryMetaSchema } from './parse.ts';

/** Announced in `hello.capabilities` by runners that clone, index and enforce capability packs. */
export const PACKS_CAPABILITY = 'packs:1';

/** What the owner approved: the commit and the content hash the runner re-checks before it serves any of the pack. */
export const PackTrustSchema = z.object({
  sha: PackShaSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PackTrust = z.infer<typeof PackTrustSchema>;

/** One pack as the server wants it on a workstation (`packs.sync`, a full list: a pack that is missing is removed). */
export const PackDesiredSchema = z.object({
  packId: z.uuid(),
  /** The organization the pack belongs to; packs of different organizations never share a namespace on a workstation. Absent: an older server. */
  orgId: z.uuid().optional(),
  name: PackNameSchema,
  url: LegacyPackUrlSchema,
  ref: PackRefSchema,
  adapter: PackAdapterSchema,
  scope: PackScopeSchema,
  projectId: z.uuid().nullable(),
  /** The commit the owner pinned; null: not pinned yet, the runner resolves `ref` and reports it. */
  pinnedSha: PackShaSchema.nullable(),
  trusted: PackTrustSchema.nullable(),
  scriptsEnabled: z.boolean(),
});
export type PackDesired = z.infer<typeof PackDesiredSchema>;

/** A project-repository capability the owner blocked: the runner leaves it out of what an agent can use. */
export const BlockedProjectCapabilitySchema = z.object({
  projectId: z.uuid(),
  kind: z.enum(['skill', 'persona', 'playbook']),
  key: z.string().min(1).max(130),
});
export type BlockedProjectCapability = z.infer<typeof BlockedProjectCapabilitySchema>;

export const PacksSyncPayloadSchema = z.object({
  packs: z.array(PackDesiredSchema).max(100),
  /** Additive: absent from an older server. */
  blocked: z.array(BlockedProjectCapabilitySchema).max(1000).default([]),
});
/** "Check for updates": fetch `ref` (default the pack's own) and report the commit it points to now. */
export const PackCheckPayloadSchema = z.object({ packId: z.uuid(), ref: PackRefSchema.optional() });

/**
 * A runner's report on one pack. `resolved`: the pinned commit (or the resolved ref when nothing was pinned yet) was indexed;
 * `update`: the checked ref points to another commit (a snapshot of it); `current`: the checked ref still points to the pin;
 * `failed`: git or indexing failed; `integrity`: files on disk no longer match the approved hash (the pack is disabled here).
 */
export const PacksReportSchema = z.object({
  packId: z.uuid(),
  state: z.enum(['resolved', 'update', 'current', 'failed', 'integrity']),
  snapshot: PackSnapshotSchema.optional(),
  /** `update` only: the changes against the pinned commit as this runner computed them (the server recomputes from snapshots). */
  diff: z.unknown().optional(),
  message: z.string().max(500).optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  sha: PackShaSchema.optional(),
});
export type PacksReport = z.infer<typeof PacksReportSchema>;

/** Project-repository capabilities (`.agents/skills`, `.claude/skills`, `.claude/agents`) a runner indexed in a project's checkout. */
export const ProjectCapabilitiesReportSchema = z.object({
  projectId: z.uuid(),
  items: z.array(RegistryMetaSchema.extend({ source: z.literal('project-repo') })).max(300),
  issues: z.array(PackIssueSchema).max(50).default([]),
});
export type ProjectCapabilitiesReport = z.infer<typeof ProjectCapabilitiesReportSchema>;
