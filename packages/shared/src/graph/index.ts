import { z } from 'zod';
import { VaultStorage } from '../events/vault.ts';
import { sha256Hex } from './sha256.ts';

export { sha256Hex } from './sha256.ts';
export * from './stats.ts';

/**
 * Project graphs (docs/design/project-graphs.md). The graph is a derived index of the code, built on the workstation and
 * kept in the project vault. Nothing code-derived is ever sent to the server: everything in this file that travels
 * (commands, results, events) carries ids, counts, commit ids and fixed reason codes only.
 */

/** Written into every shard and the manifest; bumped when the on-disk format changes. */
export const GRAPH_SCHEMA_VERSION = 1;

/**
 * The repository key of a graph: the first 12 hex digits of the SHA-256 of the normalized remote URL
 * (`normalizeRemoteUrl`). Stable across machines, never an absolute path, and the prefix of every node id.
 */
export function graphRepoKey(remoteUrlNormalized: string): string {
  return sha256Hex(remoteUrlNormalized.trim().toLowerCase()).slice(0, 12);
}

export const GraphRepoKeySchema = z.string().regex(/^[0-9a-f]{12}$/);

/** Why an index run did not produce a graph: fixed codes, because free text could carry a path or a symbol name. */
export const GraphFailReasonSchema = z.enum([
  'no_clone',
  'no_vault',
  'vault_unavailable',
  'no_commit',
  'usage_limit',
  'error',
]);
export type GraphFailReason = z.infer<typeof GraphFailReasonSchema>;

export const GraphVaultRefSchema = z.object({
  vaultId: z.string().min(1).max(64),
  storage: VaultStorage,
  kind: z.enum(['org', 'project']),
  /** `projects/<name>` inside the vault; the graph lives in `<folder>/graph/`. */
  folder: z.string().min(1).max(200),
});
export type GraphVaultRef = z.infer<typeof GraphVaultRefSchema>;

/** `graph.index` (a full index of one repository) and `graph.update` (the changes of a merge). */
export const GraphIndexPayloadSchema = z.object({
  projectId: z.uuid(),
  repoId: z.uuid(),
  repoKey: GraphRepoKeySchema,
  remoteUrlNormalized: z.string().min(1),
  repoName: z.string().min(1).max(200),
  projectKey: z.string().min(1).max(20),
  workingBranch: z.string().max(200).nullish(),
  vault: GraphVaultRefSchema,
  /** `graph.update`: the commit the manifest recorded, and the merge commit to bring the graph to. */
  fromCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  toCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /**
   * `graph.update`: the card that landed. The server owns these (the work layer); the runner records only the ref and the
   * title next to the modules the merge touched.
   */
  merge: z
    .object({
      ref: z.string().min(1).max(40),
      title: z.string().max(300),
      /** ISO time of the merge. */
      at: z.iso.datetime(),
    })
    .optional(),
});
export type GraphIndexPayload = z.infer<typeof GraphIndexPayloadSchema>;

/** What the runner answers to `graph.index` and `graph.update`. */
export const GraphIndexResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    commit: z.string(),
    files: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    modules: z.number().int().nonnegative(),
    indexerVersion: z.string(),
    durationMs: z.number().int().nonnegative(),
    /** `graph.update` only. */
    fromCommit: z.string().optional(),
    filesChanged: z.number().int().nonnegative().optional(),
    /** The update fell back to a full index (the old commit is not an ancestor, or there was no graph). */
    fullReindex: z.boolean().optional(),
  }),
  z.object({ ok: z.literal(false), reason: GraphFailReasonSchema }),
]);
export type GraphIndexResult = z.infer<typeof GraphIndexResultSchema>;

// ------------------------------------------------------------------------------------------------ measurement

/**
 * What a shift took to find its way in the code (docs/design/project-graphs.md section 11): numbers only, counted by the
 * runner from the runtime's tool stream and sent on `shift.ended`.
 */
export const ShiftContextMetricsSchema = z.object({
  /** `on`: the shift had the graph; `off`: the holdout; `none`: the project has no graph (not measured). */
  graphArm: z.enum(['on', 'off', 'none']),
  discoveryBytes: z.number().int().nonnegative(),
  discoveryCalls: z.number().int().nonnegative(),
  graphBytes: z.number().int().nonnegative(),
  graphCalls: z.number().int().nonnegative(),
  briefBytes: z.number().int().nonnegative(),
});
export type ShiftContextMetrics = z.infer<typeof ShiftContextMetricsSchema>;

/** How many weeks after the first index a project's cards are split into the two arms. */
export const GRAPH_EVALUATION_WEEKS = 4;

/**
 * The holdout: during the evaluation window one card in five runs without the graph. Stable per card (a card keeps its arm
 * over all its shifts and reworks), independent of the project and of the time.
 */
export function graphHoldout(cardId: string): boolean {
  return Number.parseInt(sha256Hex(cardId).slice(0, 8), 16) % 5 === 0;
}

/** The arm of a card at `now`: the holdout applies inside the evaluation window that began at `windowStart`. */
export function graphArmOf(
  cardId: string,
  windowStart: Date | null,
  now: Date,
  weeks: number = GRAPH_EVALUATION_WEEKS,
): 'on' | 'off' {
  if (!windowStart) return 'on';
  const end = windowStart.getTime() + weeks * 7 * 24 * 3600_000;
  return now.getTime() < end && graphHoldout(cardId) ? 'off' : 'on';
}

// -------------------------------------------------------------------------------------------- organization graph

/**
 * One end of a link the Owner asserted: a project of the organization (its id), or a name the Owner typed ("billing-api",
 * a system outside Guildwise). Never anything derived from code (docs/design/project-graphs.md section 8).
 */
export const OrgLinkEndpointSchema = z.union([
  z.object({ projectId: z.uuid() }),
  z.object({ name: z.string().trim().min(1).max(120) }),
]);
export type OrgLinkEndpoint = z.infer<typeof OrgLinkEndpointSchema>;

/** What a link says: one depends on the other, one uses the other's data or API, or they are related. */
export const OrgLinkKindSchema = z.enum(['depends_on', 'uses', 'related']);
export type OrgLinkKind = z.infer<typeof OrgLinkKindSchema>;

/** A link the Owner asserted, as the server sends it to the workstation that builds the organization graph. */
export const OrgLinkAssertionSchema = z.object({
  linkId: z.uuid(),
  from: OrgLinkEndpointSchema,
  to: OrgLinkEndpointSchema,
  kind: OrgLinkKindSchema,
  note: z.string().max(300).optional(),
});
export type OrgLinkAssertion = z.infer<typeof OrgLinkAssertionSchema>;

/**
 * `graph.org`: build the organization graph from the project graphs this workstation can read (docs/design/project-graphs.md
 * section 8). The graph is written to `org/graph/` of the organization vault; the answer to the server is counts only.
 */
export const GraphOrgPayloadSchema = z.object({
  orgId: z.uuid(),
  /** The organization vault (git, or the local folder of the Owner's workstation). */
  vault: z.object({ vaultId: z.string().min(1).max(64), storage: VaultStorage }),
  projects: z.array(
    z.object({
      projectId: z.uuid(),
      key: z.string().min(1).max(20),
      name: z.string().min(1).max(200),
      /** Archived or deleted projects are never routed to. */
      retired: z.boolean(),
      /** Where the project's own graph is: the vault and folder; absent when it has none. */
      graph: z.object({ vaultId: z.string().min(1).max(64), folder: z.string().min(1).max(200) }).optional(),
    }),
  ),
  assertions: z.array(OrgLinkAssertionSchema).max(2000),
});
export type GraphOrgPayload = z.infer<typeof GraphOrgPayloadSchema>;

export const GraphOrgResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    projects: z.number().int().nonnegative(),
    withGraph: z.number().int().nonnegative(),
    drafts: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), reason: GraphFailReasonSchema }),
]);
export type GraphOrgResult = z.infer<typeof GraphOrgResultSchema>;

/** Where the CEO's shift or chat finds the organization graph: the organization vault (`org/graph/`). */
export const OrgGraphScopeSchema = z.object({ vaultId: z.string().min(1).max(64) });
export type OrgGraphScope = z.infer<typeof OrgGraphScopeSchema>;
