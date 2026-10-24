import { z } from 'zod';
import {
  LegacyPackUrlSchema,
  PackAdapterSchema,
  PackCredentialKindSchema,
  PackDiffSchema,
  PackIssueSchema,
  PackNameSchema,
  PackRefSchema,
  PackScopeSchema,
  PackShaSchema,
  PackSnapshotSchema,
  PackSourceSchema,
  PackVisibilitySchema,
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
  /** R3a, all additive (an older runner is never sent a pack that needs them; see `PACK_AUTHORING_CAPABILITY`). */
  /** `authored`: made in the capability editor, held as a plain folder (no git) on the author's workstation; `url` is `authored:<packId>`. */
  source: PackSourceSchema.default('git'),
  /** `private`: files only on this workstation, served to its owner's sessions and to the agents the owner granted. */
  visibility: PackVisibilitySchema.default('org'),
  ownerUserId: z.uuid().nullable().default(null),
  /** The workstation of the author: the only one that pins an authored pack and the one the others fetch it from. */
  authorWorkstationId: z.uuid().nullable().default(null),
  /** A deploy key (`ssh`) or token (`token`) sealed to this workstation: the pack is cloned with it and with nothing else. */
  credentialKind: PackCredentialKindSchema.nullable().default(null),
  /** The ssh host key line pinned for the pack's host (`host keytype base64`), absent until the first fetch pinned it. */
  hostKey: z.string().max(2000).nullable().default(null),
  /** Member opt-in: false until the workstation's owner accepted the pack. A pack that is not accepted is not cloned. */
  accepted: z.boolean().default(true),
  /** Private packs: the agents (hired on this workstation) the owner granted the pack to. */
  grantedAgentIds: z.array(z.uuid()).max(200).default([]),
});
export type PackDesired = z.infer<typeof PackDesiredSchema>;
/** What a caller (a test, an older server's list) may give: the R3a fields default. */
export type PackDesiredInput = z.input<typeof PackDesiredSchema>;

/** A project-repository capability the owner blocked: the runner leaves it out of what an agent can use. */
export const BlockedProjectCapabilitySchema = z.object({
  projectId: z.uuid(),
  kind: z.enum(['skill', 'persona', 'playbook']),
  key: z.string().min(1).max(130),
});
export type BlockedProjectCapability = z.infer<typeof BlockedProjectCapabilitySchema>;

/** R3c (Q52): a project-repository capability an Owner or Admin reviewed, at exactly this content hash. */
export const ReviewedProjectCapabilitySchema = BlockedProjectCapabilitySchema.extend({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReviewedProjectCapability = z.infer<typeof ReviewedProjectCapabilitySchema>;

export const PacksSyncPayloadSchema = z.object({
  packs: z.array(PackDesiredSchema).max(100),
  /** Additive: absent from an older server. */
  blocked: z.array(BlockedProjectCapabilitySchema).max(1000).default([]),
  /**
   * R3c (Q52), additive: the project-repository capabilities that were reviewed (at that hash). When present, the runner
   * serves a capability read from a project's repository only if it is listed here; absent (an older server): all are served,
   * as before.
   */
  reviewed: z.array(ReviewedProjectCapabilitySchema).max(3000).optional(),
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
  /** R3a: the host key an ssh fetch recorded on first use (the runner then insists on it). */
  hostKey: z.object({ host: z.string().max(255), key: z.string().max(2000) }).optional(),
  /** R3a: the pack is on this workstation but waits (`opt_in`: the member has not accepted; `content`: an authored pack's files have not arrived). */
  waiting: z.enum(['opt_in', 'content', 'credential']).optional(),
});
export type PacksReport = z.infer<typeof PacksReportSchema>;

/** Project-repository capabilities (`.agents/skills`, `.claude/skills`, `.claude/agents`) a runner indexed in a project's checkout. */
export const ProjectCapabilitiesReportSchema = z.object({
  projectId: z.uuid(),
  items: z.array(RegistryMetaSchema.extend({ source: z.literal('project-repo') })).max(300),
  issues: z.array(PackIssueSchema).max(50).default([]),
});
export type ProjectCapabilitiesReport = z.infer<typeof ProjectCapabilitiesReportSchema>;

/** Announced in `hello.capabilities` by runners that hold authored and private packs, deploy keys and member opt-in. */
export const PACK_AUTHORING_CAPABILITY = 'pack-authoring:1';

/**
 * Announced by runners that open a pack's deploy key or token only when it is bound to the pack and the host of its git URL
 * (`h2`, see `packCredentialAad`) and use it for no other host. An older runner cannot open such a credential.
 */
export const PACK_CREDENTIALS_BOUND_CAPABILITY = 'pack-credentials:2';

/** A sealed (hybrid RSA+AES) credential or file set: the server relays it and never opens it. */
const SealedSchema = z.string().min(20).max(4_000_000);

/** `pack.credential.set`: the deploy key or token of one private git pack, for one workstation. */
export const PackCredentialSetPayloadSchema = z.object({
  packId: z.uuid(),
  keyId: z.string().max(100),
  kind: PackCredentialKindSchema,
  /** `sealProviderKey`-style `h2` of the key (ssh) or the token (https). For https a user name may travel in clear (it is not a secret). */
  ciphertext: SealedSchema,
  username: z.string().max(100).optional(),
  /** The host of the pack's git URL the credential is bound to (`packCredentialHost`); the runner uses it for no other host. */
  host: z.string().max(255).optional(),
});
export const PackCredentialClearPayloadSchema = z.object({ packId: z.uuid() });
export const PackCredentialResultSchema = z.object({
  stored: z.boolean(),
  error: z.string().max(300).optional(),
  /** ssh keys: `SHA256:…`, so the admin can compare it with the deploy key on the git host. */
  fingerprint: z.string().max(120).optional(),
});

/** `pack.author.save`: the files of an authored pack, sealed in the browser to the author's workstation. */
export const PackAuthorSavePayloadSchema = z.object({
  packId: z.uuid(),
  keyId: z.string().max(100),
  /** `sealLarge` of the JSON `{ tree: { path: text } }`. */
  ciphertext: SealedSchema,
  /** The author is an Owner or Admin approving their own save (org packs): the server then accepts and trusts the result. */
  approve: z.boolean().default(false),
});
export const PackAuthorSaveResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(500).optional(),
  issues: z
    .array(z.object({ path: z.string().max(300), message: z.string().max(500) }))
    .max(100)
    .default([]),
});

/** `pack.read`: the files of an authored pack for the editor, sealed to a key the browser made for this one read. */
export const PackReadPayloadSchema = z.object({
  packId: z.uuid(),
  requestId: z.uuid(),
  /** SPKI public key (base64) of the browser's one-time key pair. */
  replyKey: z.string().min(20).max(2000),
  /**
   * R3c (additive; an older runner ignores it): also return the revision the organization approved (`pinned`), so the author and
   * the reviewer can read what changed. The sealed answer is `{tree, sha, pinned?: {tree, sha}}`, `tree` being the newest save.
   */
  withPinned: z.boolean().optional(),
});
export const PackReadResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(300).optional(),
  ciphertext: SealedSchema.optional(),
});

/** `pack.persona.read`: the text of one persona for hiring, read from the pack as it is pinned. */
export const PackPersonaReadPayloadSchema = z.object({
  packId: z.uuid(),
  requestId: z.uuid(),
  /** The persona key inside the pack (without the `<pack>:` prefix). */
  key: z.string().min(1).max(64),
});
export const PackPersonaReadResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(300).optional(),
  text: z.string().max(600_000).optional(),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  sha: PackShaSchema.optional(),
});

/** `pack.bundle.request`: the author's workstation seals the pinned files to each target workstation (the server relays them). */
export const PackBundleRequestPayloadSchema = z.object({
  packId: z.uuid(),
  sha: PackShaSchema,
  targets: z
    .array(z.object({ workstationId: z.uuid(), keyId: z.string().max(100), publicKey: z.string().max(2000) }))
    .min(1)
    .max(50),
});
export const PackBundleRequestResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(300).optional(),
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  bundles: z
    .array(z.object({ workstationId: z.uuid(), ciphertext: SealedSchema }))
    .max(50)
    .default([]),
});
/** `pack.bundle.put`: a sealed bundle for this workstation, stored once its hash matches what the server pinned. */
export const PackBundlePutPayloadSchema = z.object({
  packId: z.uuid(),
  sha: PackShaSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  keyId: z.string().max(100),
  ciphertext: SealedSchema,
});
export const PackBundlePutResultSchema = z.object({
  stored: z.boolean(),
  error: z.string().max(300).optional(),
});

/** What a sealed pack file set looks like once opened. */
export const PackFileSetSchema = z.object({ tree: z.record(z.string().max(300), z.string()) });
export type PackFileSet = z.infer<typeof PackFileSetSchema>;
export type PackCredentialResult = z.infer<typeof PackCredentialResultSchema>;
export type PackAuthorSavePayload = z.infer<typeof PackAuthorSavePayloadSchema>;
export type PackAuthorSaveResult = z.infer<typeof PackAuthorSaveResultSchema>;
export type PackReadPayload = z.infer<typeof PackReadPayloadSchema>;
export type PackReadResult = z.infer<typeof PackReadResultSchema>;
export type PackPersonaReadPayload = z.infer<typeof PackPersonaReadPayloadSchema>;
export type PackPersonaReadResult = z.infer<typeof PackPersonaReadResultSchema>;
export type PackBundleRequestPayload = z.infer<typeof PackBundleRequestPayloadSchema>;
export type PackBundleRequestResult = z.infer<typeof PackBundleRequestResultSchema>;
export type PackBundlePutPayload = z.infer<typeof PackBundlePutPayloadSchema>;
export type PackBundlePutResult = z.infer<typeof PackBundlePutResultSchema>;
export type PackCredentialSetPayload = z.infer<typeof PackCredentialSetPayloadSchema>;
