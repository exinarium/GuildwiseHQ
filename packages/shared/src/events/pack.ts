import { z } from 'zod';
import {
  LegacyPackUrlSchema,
  PackAdapterSchema,
  PackDiffSchema,
  PackNameSchema,
  PackRefSchema,
  PackScopeSchema,
  PackShaSchema,
  PackSnapshotSchema,
} from '../capabilities/packs.ts';
import { RegistryMetaSchema } from '../capabilities/parse.ts';
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
      /** The preset it was added from (`bmad`), for attribution. */
      preset: z.string().max(40).nullable().default(null),
      addedBy: Id,
      /**
       * The workstations the adding admin chose to hold the pack. Empty: the admin's own workstations (whichever they have).
       * Packs added before this field existed behave the same.
       */
      workstationIds: z.array(Id).max(20).default([]),
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
      stage: z.enum(['fetch', 'check']),
      message: z.string().max(500),
    }),
  ),
  defineEvent('PackRemoved', z.object({ packId: Id, orgId: Id, removedBy: Id })),
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
] as const;
