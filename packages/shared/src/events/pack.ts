import { z } from 'zod';
import {
  LegacyPackUrlSchema,
  PackAdapterSchema,
  PackCredentialKindSchema,
  PackDiffSchema,
  PackNameSchema,
  PackRefSchema,
  PackScopeSchema,
  PackShaSchema,
  PackSnapshotSchema,
  PackSourceSchema,
  PackVisibilitySchema,
} from '../capabilities/packs.ts';
import { RegistryMetaSchema } from '../capabilities/parse.ts';
import { PackProvenanceSchema } from '../capabilities/provenance.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Capability packs (stream `pack-<packId>`, org scope; docs/ARCHITECTURE.md section 38.4). The server keeps metadata and the
 * owner's decisions; the files stay on the workstations. A pack is untrusted until `PackTrusted`; the pin only moves with
 * `PackUpdateAccepted`.
 */
export const packEvents = [
  defineEvent(
    'PackAdded',
    z.object({
      packId: Id,
      orgId: Id,
      name: PackNameSchema,
      url: LegacyPackUrlSchema,
      ref: PackRefSchema,
      adapter: PackAdapterSchema,
      scope: PackScopeSchema,
      projectId: Id.nullable().default(null),
      /** Retired: packs added from a one-click preset (before presets were removed) carry its id here. Nothing writes it any more. */
      preset: z.string().max(40).nullable().default(null),
      addedBy: Id,
      /**
       * The workstations the adding admin chose to hold the pack. Empty: the admin's own workstations (whichever they have).
       * Packs added before this field existed behave the same.
       */
      workstationIds: z.array(Id).max(20).default([]),
      /** R3a, all additive. `authored`: made in the capability editor (no git remote; `url` is `authored:<packId>`). */
      source: PackSourceSchema.default('git'),
      /** `private`: only `ownerUserId` sees it and only that user's workstation holds it; no trust review. */
      visibility: PackVisibilitySchema.default('org'),
      ownerUserId: Id.nullable().default(null),
      description: z.string().max(500).default(''),
      /** A private git pack: the kind of credential sealed to the workstations (the secret itself is never in an event). */
      credentialKind: PackCredentialKindSchema.nullable().default(null),
    }),
  ),
  /** A workstation resolved the ref to a commit and indexed it. The first one pins; later ones only matter if the pin is not set. */
  defineEvent(
    'PackRefResolved',
    z.object({ packId: Id, orgId: Id, workstationId: Id, snapshot: PackSnapshotSchema }),
  ),
  defineEvent(
    'PackUpdateAvailable',
    z.object({
      packId: Id,
      orgId: Id,
      workstationId: Id,
      snapshot: PackSnapshotSchema,
      diff: PackDiffSchema,
    }),
  ),
  /** A check found nothing new. */
  defineEvent(
    'PackUpToDate',
    z.object({ packId: Id, orgId: Id, workstationId: Id, sha: PackShaSchema, ref: PackRefSchema }),
  ),
  /** The owner accepted the update shown: the pin moves (and the ref with it). A trusted pack stays trusted at the new commit. */
  defineEvent(
    'PackUpdateAccepted',
    z.object({
      packId: Id,
      orgId: Id,
      sha: PackShaSchema,
      ref: PackRefSchema,
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
      acceptedBy: Id,
      keepTrust: z.boolean(),
      /** Script files were added or changed: scripts are switched off again. */
      scriptsReset: z.boolean().default(false),
    }),
  ),
  defineEvent(
    'PackTrusted',
    z.object({
      packId: Id,
      orgId: Id,
      sha: PackShaSchema,
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
      trustedBy: Id,
    }),
  ),
  defineEvent('PackTrustRevoked', z.object({ packId: Id, orgId: Id, revokedBy: Id })),
  defineEvent('PackScriptsChanged', z.object({ packId: Id, orgId: Id, enabled: z.boolean(), changedBy: Id })),
  /** A workstation's files no longer match the approved hash: the pack is disabled there until the files are restored. */
  defineEvent(
    'PackIntegrityFailed',
    z.object({
      packId: Id,
      orgId: Id,
      workstationId: Id,
      expected: z.string().max(80),
      actual: z.string().max(80),
    }),
  ),
  defineEvent(
    'PackFailed',
    z.object({
      packId: Id,
      orgId: Id,
      workstationId: Id,
      stage: z.enum(['fetch', 'check', 'save']),
      message: z.string().max(500),
    }),
  ),
  defineEvent('PackRemoved', z.object({ packId: Id, orgId: Id, removedBy: Id })),
  /**
   * The Owner or an Admin said which of the pack's skills are agents and which are playbooks (keys without the pack prefix).
   * Full lists: the last event wins, so the projection replays to the same state. Metadata only; the skills' text stays in the pack.
   */
  defineEvent(
    'PackItemsClassified',
    z.object({
      packId: Id,
      orgId: Id,
      agents: z.array(z.string().min(1).max(64)).max(300),
      playbooks: z.array(z.string().min(1).max(64)).max(300),
      by: Id,
    }),
  ),
  /**
   * Agents were hired from a pack onto roles (one call: one agent or the whole team). The agents carry their own `AgentHired`
   * events; this one ties them together for the HR board ("hired from <pack>").
   */
  defineEvent(
    'PackTeamHired',
    z.object({
      hireId: Id,
      packId: Id,
      orgId: Id,
      by: Id,
      mode: z.enum(['agents', 'team']),
      agents: z
        .array(
          z.object({
            agentId: Id,
            name: z.string().max(100),
            key: z.string().max(130),
            seat: z.string().max(80),
          }),
        )
        .max(300),
    }),
  ),
  /** The capabilities of a project's checkout, as a runner last saw them (metadata only). */
  defineEvent(
    'ProjectCapabilitiesReported',
    z.object({
      orgId: Id,
      projectId: Id,
      workstationId: Id,
      items: z.array(RegistryMetaSchema.extend({ source: z.literal('project-repo') })).max(300),
      issues: z
        .array(z.object({ path: z.string().max(300), message: z.string().max(500) }))
        .max(50)
        .default([]),
    }),
  ),
  /**
   * The owner reviewed a capability the project's own repository carries (`.claude/skills`, `.agents/skills`, `.claude/agents`):
   * `reviewed` at this content hash (a changed file needs a new review), `blocked` (unusable until cleared) or `unreviewed`
   * (back to the start). One decision per project, kind and key.
   */
  defineEvent(
    'ProjectCapabilityReviewed',
    z.object({
      orgId: Id,
      projectId: Id,
      kind: z.enum(['skill', 'persona', 'playbook']),
      key: z.string().min(1).max(130),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      status: z.enum(['reviewed', 'blocked', 'unreviewed']),
      by: Id,
    }),
  ),
  /** The admin changed which workstations hold the pack. A workstation of another member waits for that member's opt-in. */
  defineEvent(
    'PackWorkstationsChanged',
    z.object({ packId: Id, orgId: Id, workstationIds: z.array(Id).max(20), changedBy: Id }),
  ),
  /** A pack was assigned to a workstation of another member: they decide on their desk (`deskItemId`). */
  defineEvent(
    'PackAssignmentRequested',
    z.object({
      packId: Id,
      orgId: Id,
      workstationId: Id,
      userId: Id,
      deskItemId: Id,
      requestedBy: Id,
    }),
  ),
  /** The member accepted (the workstation may clone the pack) or declined (the assignment is removed). */
  defineEvent(
    'PackAssignmentDecided',
    z.object({ packId: Id, orgId: Id, workstationId: Id, userId: Id, accepted: z.boolean() }),
  ),
  /** A deploy key or token was sealed for these workstations (the secret is in no event; `fingerprint` is the public part of an ssh key). */
  defineEvent(
    'PackCredentialSet',
    z.object({
      packId: Id,
      orgId: Id,
      kind: PackCredentialKindSchema,
      workstationIds: z.array(Id).max(20),
      fingerprint: z.string().max(120).nullable().default(null),
      setBy: Id,
    }),
  ),
  defineEvent('PackCredentialCleared', z.object({ packId: Id, orgId: Id, clearedBy: Id })),
  /** A workstation's answer to storing the credential. */
  defineEvent(
    'PackCredentialStored',
    z.object({
      packId: Id,
      orgId: Id,
      workstationId: Id,
      stored: z.boolean(),
      error: z.string().max(300).nullable().default(null),
      fingerprint: z.string().max(120).nullable().default(null),
    }),
  ),
  /** The first ssh fetch recorded the host key of the pack's git host on this workstation (trust on first use, then pinned). */
  defineEvent(
    'PackHostKeyPinned',
    z.object({
      packId: Id,
      orgId: Id,
      workstationId: Id,
      host: z.string().max(255),
      hostKey: z.string().max(2000),
    }),
  ),
  /** The author saved the files of an authored pack (metadata only: the files are sealed to the author's workstation). */
  defineEvent(
    'PackAuthoredSaveRequested',
    z.object({ packId: Id, orgId: Id, workstationId: Id, requestedBy: Id, approve: z.boolean() }),
  ),
  defineEvent(
    'PackVisibilityChanged',
    z.object({ packId: Id, orgId: Id, visibility: PackVisibilitySchema, changedBy: Id }),
  ),
  /** The owner of a private pack lets one of their agents (hired on their workstation) use it. */
  defineEvent(
    'PackAgentGranted',
    z.object({ packId: Id, orgId: Id, agentId: Id, grantedBy: Id, granted: z.boolean() }),
  ),
  /** Hire from pack: asked, then done (a role version and an agent) or failed. */
  defineEvent(
    'PackHireRequested',
    z.object({
      requestId: Id,
      packId: Id,
      orgId: Id,
      requestedBy: Id,
      kind: z.enum(['hire', 'role_update']),
      /** The persona keys (without the pack prefix) and, per key, the agent to create. */
      items: z.array(z.object({ key: z.string().max(64), agentName: z.string().max(60).optional() })).max(60),
      workstationId: Id.nullable(),
    }),
  ),
  defineEvent(
    'PackHireResolved',
    z.object({
      requestId: Id,
      packId: Id,
      orgId: Id,
      status: z.enum(['done', 'failed']),
      error: z.string().max(500).nullable().default(null),
    }),
  ),
  /** A pack update changed a persona an agent was hired from: a new role version is on offer (never forced). */
  defineEvent(
    'RolePackUpdateOffered',
    z.object({
      orgId: Id,
      roleKey: z.string().max(80),
      fromVersion: z.number().int().min(1),
      packId: Id,
      capability: z.string().max(130),
      sha: z.string().max(64),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      provenance: PackProvenanceSchema,
    }),
  ),
  defineEvent(
    'RolePackUpdateResolved',
    z.object({ orgId: Id, roleKey: z.string().max(80), packId: Id, accepted: z.boolean(), by: Id }),
  ),
] as const;
