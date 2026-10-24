import { z } from 'zod';
import {
  PackAdapterSchema,
  PackCredentialKindSchema,
  PackDiffSchema,
  PackNameSchema,
  PackRefSchema,
  PackScopeSchema,
  PackShaSchema,
  PackSnapshotSchema,
  PackSourceSchema,
  PackUrlSchema,
  PackVisibilitySchema,
  PrivatePackUrlSchema,
} from '../capabilities/packs.ts';
import { CapabilityKindSchema, RegistryMetaSchema } from '../capabilities/parse.ts';
import { PackProvenanceSchema } from '../capabilities/provenance.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';

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
export const UnusableReasonSchema = z.enum(['untrusted', 'integrity', 'pending', 'unreviewed', 'changed']);
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
      /** R3a: `private` is a pack of the asking user's own workstation; nobody else is ever sent one. */
      visibility: PackVisibilitySchema.optional(),
    }),
  ),
  /** Vault files that did not parse, so the owner can fix them. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  /** When a workstation last reported the organization vault's index; null: never. */
  indexedAt: z.iso.datetime().nullable(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

// ------------------------------------------------------------------------------------------------ project skills review

export const PROJECT_SKILL_STATUSES = ['unreviewed', 'reviewed', 'changed', 'blocked'] as const;
/** `changed`: reviewed once, but the file's content hash is not the reviewed one any more. */
export const ProjectSkillStatusSchema = z.enum(PROJECT_SKILL_STATUSES);

/** A capability found in a project's own repository, with where it lives and what the owner decided. */
export const ProjectSkillDtoSchema = z.object({
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  kind: CapabilityKindSchema,
  key: z.string(),
  name: z.string(),
  description: z.string(),
  hash: z.string(),
  /** The project's repository the capability was read from (null when the project has none known). */
  repo: z.string().nullable(),
  /** Its folder or file in that repository (null: reported by an older runner). */
  path: z.string().nullable(),
  status: ProjectSkillStatusSchema,
  reviewedHash: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  indexedAt: z.iso.datetime(),
});
export type ProjectSkillDto = z.infer<typeof ProjectSkillDtoSchema>;
export const ProjectSkillsResponseSchema = z.object({ items: z.array(ProjectSkillDtoSchema) });
export type ProjectSkillsResponse = z.infer<typeof ProjectSkillsResponseSchema>;

export const ReviewProjectSkillRequestSchema = z.object({
  projectId: z.uuid(),
  kind: CapabilityKindSchema,
  key: z.string().min(1).max(130),
  /** The hash the owner looked at; refused when the file changed since. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['reviewed', 'blocked', 'unreviewed']),
});
export type ReviewProjectSkillRequest = z.infer<typeof ReviewProjectSkillRequestSchema>;

// ------------------------------------------------------------------------------------------------------- packs

/** `POST /api/packs`: add a pack by git URL and ref. The name is the namespace; a preset fills in the rest. */
/**
 * A deploy key (`ssh`) or an https token, sealed in the browser (hybrid RSA+AES, `sealLarge`) separately to each chosen
 * workstation's runner key. The server relays the ciphertexts and never opens them.
 */
export const PackCredentialSharesSchema = z.object({
  kind: PackCredentialKindSchema,
  /** The ssh public half or key fingerprint is not secret; a token's user name (default `x-access-token`) is not either. */
  username: z.string().max(100).optional(),
  shares: z
    .array(
      z.object({
        workstationId: z.uuid(),
        keyId: z.string().max(100),
        ciphertext: z.string().min(20).max(60_000),
      }),
    )
    .min(1)
    .max(20),
});
export type PackCredentialShares = z.infer<typeof PackCredentialSharesSchema>;

export const AddPackRequestSchema = z.object({
  /**
   * The pack's id, chosen by the browser so a deploy key or token can be sealed bound to it before the pack exists. Omitted: the
   * server makes one (a pack without a credential).
   */
  id: z.uuid().optional(),
  name: PackNameSchema.optional(),
  url: z.union([PackUrlSchema, PrivatePackUrlSchema]),
  /** R3a: a private repository. The URL may then be ssh; every chosen workstation needs a share. */
  credential: PackCredentialSharesSchema.optional(),
  ref: PackRefSchema,
  adapter: PackAdapterSchema.default('auto'),
  scope: PackScopeSchema.default('org'),
  projectId: z.uuid().optional(),
  preset: z.string().max(40).optional(),
  /**
   * The workstations that fetch and hold the pack. Omitted: the adding admin's own workstations. A chosen list must include
   * one of the admin's own (only those can pin the commit).
   */
  workstationIds: z.array(z.uuid()).max(20).optional(),
});
export type AddPackRequest = z.infer<typeof AddPackRequestSchema>;

export const PackStatusSchema = z.enum(['pending', 'ready', 'failed']);

/** One workstation that holds (or is asked to hold) a pack, with the member's opt-in and the state of its credential. */
export const PackHolderSchema = z.object({
  workstationId: z.uuid(),
  workstationName: z.string(),
  ownerName: z.string(),
  mine: z.boolean(),
  /** `pending`: the member has not accepted yet, nothing is cloned. `declined` rows are removed, so it is not listed. */
  assignment: z.enum(['accepted', 'pending']),
  credential: z.enum(['stored', 'pending', 'failed']).nullable(),
  credentialError: z.string().nullable().default(null),
  hostKeyPinned: z.boolean().default(false),
  /** The workstation reported the pack at the pinned commit. */
  hasContent: z.boolean().default(false),
});
export type PackHolder = z.infer<typeof PackHolderSchema>;

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
  /** The workstations chosen to hold the pack; empty: the adding admin's own. */
  workstationIds: z.array(z.uuid()).default([]),
  update: z
    .object({ sha: PackShaSchema, ref: z.string(), diff: PackDiffSchema, foundAt: z.iso.datetime() })
    .nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  addedAt: z.iso.datetime(),
  attribution: z.string().nullable(),
  /** R3a (all additive). */
  source: PackSourceSchema.default('git'),
  visibility: PackVisibilitySchema.default('org'),
  ownerUserId: z.uuid().nullable().default(null),
  ownerName: z.string().nullable().default(null),
  description: z.string().default(''),
  credentialKind: PackCredentialKindSchema.nullable().default(null),
  /** Of an ssh deploy key, so the admin can compare it with the key on the git host. */
  credentialFingerprint: z.string().nullable().default(null),
  /** An authored pack's revision number (the `v<N>` of its ref). */
  revision: z.number().int().default(0),
  holders: z.array(PackHolderSchema).default([]),
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
  /** Workstations that can hold packs, for the picker when adding one. `mine`: the caller's own. */
  workstations: z
    .array(z.object({ id: z.uuid(), name: z.string(), mine: z.boolean(), online: z.boolean() }))
    .default([]),
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

// ------------------------------------------------------------------------------------------ private packs and opt-in

/** `PUT /api/packs/:id/workstations`: the admin changes who holds the pack (new holders of other members wait for their opt-in). */
export const SetPackWorkstationsRequestSchema = z.object({
  workstationIds: z.array(z.uuid()).min(1).max(20),
  /** A private repository: a share for each workstation added that has no credential yet. */
  credential: PackCredentialSharesSchema.optional(),
});
export type SetPackWorkstationsRequest = z.infer<typeof SetPackWorkstationsRequestSchema>;

/** `PUT /api/packs/:id/credential`: replace the deploy key or token (rotation). */
export const SetPackCredentialRequestSchema = PackCredentialSharesSchema;

/** A pack assigned to one of my workstations, waiting for my answer (`GET /api/pack-assignments`; also a desk item). */
export const PackAssignmentDtoSchema = z.object({
  packId: z.uuid(),
  packName: z.string(),
  url: z.string(),
  ref: z.string(),
  private: z.boolean(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  requestedByName: z.string().nullable(),
  deskItemId: z.uuid().nullable(),
  requestedAt: z.iso.datetime(),
});
export type PackAssignmentDto = z.infer<typeof PackAssignmentDtoSchema>;
export const PackAssignmentsResponseSchema = z.object({ items: z.array(PackAssignmentDtoSchema) });
export const DecidePackAssignmentRequestSchema = z.object({ workstationId: z.uuid(), accept: z.boolean() });

// ------------------------------------------------------------------------------------------ my capabilities (authored)

export const AUTHORED_PACK_STATES = ['draft', 'private', 'in_review', 'trusted'] as const;
/**
 * `draft`: nothing saved yet. `private`: only on my workstation, usable at once. `in_review`: organization-visible and waiting
 * for an Owner or Admin to approve it (their own packs are approved when they save). `trusted`: listed for the organization.
 */
export const AuthoredPackStateSchema = z.enum(AUTHORED_PACK_STATES);

export const MyPackDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  visibility: PackVisibilitySchema,
  state: AuthoredPackStateSchema,
  workstationId: z.uuid(),
  workstationName: z.string(),
  workstationOnline: z.boolean(),
  /** The author's workstation can author packs (`pack-authoring:1`). */
  supported: z.boolean(),
  revision: z.number().int(),
  pinnedSha: PackShaSchema.nullable(),
  status: PackStatusSchema,
  error: z.string().nullable(),
  /** What the last save contained, metadata only. */
  items: z.array(
    z.object({
      kind: z.enum(['skill', 'persona', 'playbook']),
      key: z.string(),
      name: z.string(),
      description: z.string(),
    }),
  ),
  hasScripts: z.boolean(),
  /** A save is on its way to the workstation or being indexed. */
  saving: z.boolean(),
  update: PackDtoSchema.shape.update,
  /** I may approve my own save (Owner or Admin). */
  mayApprove: z.boolean(),
  holders: z.array(PackHolderSchema).default([]),
  createdAt: z.iso.datetime(),
  /** Which of my agents may use a private pack. */
  grantedAgentIds: z.array(z.uuid()).default([]),
});
export type MyPackDto = z.infer<typeof MyPackDtoSchema>;
export const MyPacksResponseSchema = z.object({
  packs: z.array(MyPackDtoSchema),
  /** My workstations, for the picker; `supported` false: update the runner. */
  workstations: z.array(
    z.object({ id: z.uuid(), name: z.string(), online: z.boolean(), supported: z.boolean() }),
  ),
});
export type MyPacksResponse = z.infer<typeof MyPacksResponseSchema>;

export const CreateMyPackRequestSchema = z.object({
  name: PackNameSchema,
  description: z.string().max(500).default(''),
  visibility: PackVisibilitySchema,
  workstationId: z.uuid(),
});
export type CreateMyPackRequest = z.infer<typeof CreateMyPackRequestSchema>;

export const SaveMyPackRequestSchema = z.object({
  /** The runner key the files were sealed with (so a changed key is refused instead of lost). */
  keyId: z.string().max(100),
  /** `sealLarge` of `{ tree }`: the server relays it to the author's workstation and never opens it. */
  ciphertext: z.string().min(20).max(4_000_000),
  /** Owners and Admins approving their own save of an organization pack. */
  approve: z.boolean().default(false),
});
export type SaveMyPackRequest = z.infer<typeof SaveMyPackRequestSchema>;

export const ReadMyPackRequestSchema = z.object({
  replyKey: z.string().min(20).max(2000),
  /** Also read the approved revision, for the diff against it (R3c). */
  withPinned: z.boolean().optional(),
});
/** What a sealed read opens to: the newest save, and (when asked and different) the revision the organization approved. */
export const PackReadContentSchema = z.object({
  tree: z.record(z.string(), z.string()),
  sha: z.string().optional(),
  pinned: z.object({ tree: z.record(z.string(), z.string()), sha: z.string() }).optional(),
});
export type PackReadContent = z.infer<typeof PackReadContentSchema>;
export const ReadMyPackResultSchema = z.object({
  status: z.enum(['pending', 'ready', 'failed']),
  ciphertext: z.string().optional(),
  error: z.string().optional(),
});
export type ReadMyPackResult = z.infer<typeof ReadMyPackResultSchema>;

export const SetPackVisibilityRequestSchema = z.object({ visibility: PackVisibilitySchema });
export const GrantPackAgentRequestSchema = z.object({ agentId: z.uuid(), granted: z.boolean() });

// ------------------------------------------------------------------------------------------ hire from pack

/** A persona of a pack as the hire dialog shows it: what role and permissions the hire would get for the caller. */
export const PackPersonaDtoSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  declaredTools: z.array(z.string()),
  permissions: AgentPermissionsSchema,
  /** What the persona declared that the caller may not grant. */
  withheld: z.array(z.string()),
  provenanceLabel: z.string(),
  roleKey: z.string(),
  /** A role made from this persona already exists: the version and whether the pack has changed it since. */
  role: z.object({ version: z.number().int(), upToDate: z.boolean() }).nullable(),
  hiredAgentIds: z.array(z.uuid()),
});
export type PackPersonaDto = z.infer<typeof PackPersonaDtoSchema>;
export const PackPersonasResponseSchema = z.object({
  packId: z.uuid(),
  packName: z.string(),
  trusted: z.boolean(),
  /** A hire needs the pack's files to be reachable on an online workstation. */
  readableNow: z.boolean(),
  personas: z.array(PackPersonaDtoSchema),
});
export type PackPersonasResponse = z.infer<typeof PackPersonasResponseSchema>;

/** The packs a member can hire from on the HR page (R3c, Q60): approved organization packs and their own private packs with personas. */
export const HirablePacksResponseSchema = z.object({
  packs: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      personaCount: z.number().int(),
      visibility: PackVisibilitySchema,
    }),
  ),
});
export type HirablePacksResponse = z.infer<typeof HirablePacksResponseSchema>;

export const HireFromPackRequestSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        name: z.string().min(1).max(60),
        seniority: Seniority.optional(),
      }),
    )
    .min(1)
    .max(30),
  workstationId: z.uuid(),
  runtime: z.string().max(60).optional(),
  model: z.string().max(100).optional(),
  effort: z.string().max(40).optional(),
  capacity: z.number().int().min(1).max(8).default(1),
  allowedProjectIds: z.array(z.uuid()).max(500).nullable().optional(),
  acknowledgeUnsandboxed: z.boolean().optional(),
});
export type HireFromPackRequest = z.infer<typeof HireFromPackRequestSchema>;

export const PackHireStatusSchema = z.object({
  requestId: z.uuid(),
  status: z.enum(['pending', 'done', 'failed']),
  error: z.string().nullable(),
  agents: z.array(z.object({ agentId: z.uuid(), name: z.string(), roleKey: z.string() })),
});
export type PackHireStatus = z.infer<typeof PackHireStatusSchema>;

/** A new version of a persona an agent was hired from, on offer to the Owner/Admin (never applied by itself). */
export const RoleOfferDtoSchema = z.object({
  roleKey: z.string(),
  roleName: z.string(),
  fromVersion: z.number().int(),
  packId: z.uuid(),
  packName: z.string(),
  capability: z.string(),
  provenance: PackProvenanceSchema,
  newLabel: z.string(),
  offeredAt: z.iso.datetime(),
  agentCount: z.number().int(),
});
export type RoleOfferDto = z.infer<typeof RoleOfferDtoSchema>;
export const RoleOffersResponseSchema = z.object({ items: z.array(RoleOfferDtoSchema) });
export type RoleOffersResponse = z.infer<typeof RoleOffersResponseSchema>;
export const RoleOfferReviewSchema = z.object({
  requestId: z.uuid(),
  status: z.enum(['pending', 'ready', 'failed']),
  error: z.string().nullable(),
  /** The instructions of the current role version and the new persona text, for the diff. */
  current: z.string().nullable(),
  proposed: z.string().nullable(),
});
export type RoleOfferReview = z.infer<typeof RoleOfferReviewSchema>;

/** Agents and roles whose pack is no longer trusted (or was removed): they keep their role version and show a warning. */
export const PackWarningSchema = z.enum(['revoked', 'removed', 'private_gone']);
export type PackWarning = z.infer<typeof PackWarningSchema>;

// ------------------------------------------------------------------------------------------ persona chat

export const StartPersonaChatRequestSchema = z.object({
  /** `persona:<key>` is resolved against the registry; a pack persona is `<pack>:<key>`. */
  personaKey: z.string().min(1).max(130),
  /** The model to talk to; default: the persona's own, else the cheap default of the workstation. */
  runtime: z.string().max(60).optional(),
  model: z.string().max(100).optional(),
  effort: z.string().max(40).optional(),
  workstationId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  /** R3c: an optional budget in USD (the session cost limit: a new message is refused once the chat has cost this much). */
  budgetUsd: z.number().positive().max(10_000).optional(),
  /** R3c: an optional time limit in minutes from the start of the chat (a new message is refused after it). */
  timeLimitMinutes: z.number().int().min(5).max(1440).optional(),
});
export type StartPersonaChatRequest = z.infer<typeof StartPersonaChatRequestSchema>;
