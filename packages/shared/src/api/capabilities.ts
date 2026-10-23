import { z } from 'zod';
import {
  PackAdapterSchema,
  PackDiffSchema,
  PackNameSchema,
  PackRefSchema,
  PackScopeSchema,
  PackShaSchema,
  PackSnapshotSchema,
  PackUrlSchema,
} from '../capabilities/packs.ts';
import { CapabilityKindSchema, RegistryMetaSchema } from '../capabilities/parse.ts';

/**
 * `GET /api/capabilities`: the effective registry of the organization. Sources, lowest precedence first: built-in, organization
 * vault, project repository (with `projectId`), imported pack (namespaced keys, usable only when the pack is trusted).
 */
export const ListCapabilitiesQuerySchema = z.object({
  kind: CapabilityKindSchema.optional(),
  /** Also list the project-repository capabilities of this project (and the packs scoped to it). */
  projectId: z.uuid().optional(),
  /** Pickers ask for what can be used now: capabilities of an untrusted pack or one whose files changed are left out. */
  usable: z.enum(['true', 'false']).optional(),
});
export const UnusableReasonSchema = z.enum(['untrusted', 'integrity', 'pending']);
export const CapabilitiesResponseSchema = z.object({
  items: z.array(
    RegistryMetaSchema.extend({
      /** The lower-precedence entry (built-in, vault) this one replaces. */
      overrides: z.boolean(),
      /** False for a capability of a pack the owner has not approved, or whose files changed since (`unusableReason`). */
      usable: z.boolean().default(true),
      unusableReason: UnusableReasonSchema.optional(),
      packId: z.uuid().optional(),
      sha: PackShaSchema.optional(),
      projectId: z.uuid().optional(),
    }),
  ),
  /** Vault files that did not parse, so the owner can fix them. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  /** When a workstation last reported the organization vault's index; null: never. */
  indexedAt: z.iso.datetime().nullable(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

// ------------------------------------------------------------------------------------------------------- packs

/** `POST /api/packs`: add a pack by git URL and ref. The name is the namespace; a preset fills in the rest. */
export const AddPackRequestSchema = z.object({
  name: PackNameSchema.optional(),
  url: PackUrlSchema,
  ref: PackRefSchema,
  adapter: PackAdapterSchema.default('auto'),
  scope: PackScopeSchema.default('org'),
  projectId: z.uuid().optional(),
  preset: z.string().max(40).optional(),
});
export type AddPackRequest = z.infer<typeof AddPackRequestSchema>;

export const PackStatusSchema = z.enum(['pending', 'ready', 'failed']);

export const PackDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  ref: z.string(),
  adapter: PackAdapterSchema,
  scope: PackScopeSchema,
  projectId: z.uuid().nullable(),
  preset: z.string().nullable(),
  /** `pending`: no workstation has fetched it yet. */
  status: PackStatusSchema,
  error: z.string().nullable(),
  pinnedSha: PackShaSchema.nullable(),
  contentHash: z.string().nullable(),
  trusted: z.boolean(),
  trustedSha: PackShaSchema.nullable(),
  scriptsEnabled: z.boolean(),
  hasScripts: z.boolean(),
  license: z.string().nullable(),
  /** A workstation found the files changed from the approved hash. */
  integrityFailed: z.boolean(),
  itemCount: z.number().int(),
  update: z
    .object({ sha: PackShaSchema, ref: z.string(), diff: PackDiffSchema, foundAt: z.iso.datetime() })
    .nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  addedAt: z.iso.datetime(),
  attribution: z.string().nullable(),
});
export type PackDto = z.infer<typeof PackDtoSchema>;

export const PackDetailDtoSchema = PackDtoSchema.extend({
  /** What the owner reviews: capabilities with their files (scripts flagged), issues, adapter notes. */
  snapshot: PackSnapshotSchema.nullable(),
  /** The snapshot of the update on offer, for the diff view. */
  updateSnapshot: PackSnapshotSchema.nullable(),
});
export type PackDetailDto = z.infer<typeof PackDetailDtoSchema>;

export const PacksResponseSchema = z.object({
  packs: z.array(PackDtoSchema),
  /** Workstations of the owner that hold packs (`packs:1`); none: nothing can be fetched yet. */
  workstationsOnline: z.number().int(),
});
export type PacksResponse = z.infer<typeof PacksResponseSchema>;

export const CheckPackRequestSchema = z.object({ ref: PackRefSchema.optional() });
/** The owner accepts the update they saw: the commit is named so a newer one cannot slip in. */
export const AcceptPackUpdateRequestSchema = z.object({ sha: PackShaSchema });
/** Approving a pack names the commit and content hash the review showed. */
export const TrustPackRequestSchema = z.object({
  sha: PackShaSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const PackScriptsRequestSchema = z.object({ enabled: z.boolean() });
