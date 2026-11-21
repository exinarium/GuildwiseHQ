import { z } from 'zod';
import { BlockKindSchema, SecuritySettingKeySchema } from '../security/index.ts';
import { defineEvent, Id } from './define.ts';
import { EventMetaSchema } from './org.ts';

const Scope = z.object({
  projectId: Id.nullable().default(null),
  workflowKey: z.string().max(80).nullable().default(null),
  stageId: z.string().max(80).nullable().default(null),
  workstationId: Id.nullable().default(null),
});

/** Platform team events (Lean Team v3): the designation, and pauses scoped to what a bug hits. */
export const platformEvents = [
  /** The super admin designated (or cleared, orgId null) the organisation and project that run the platform team. */
  defineEvent(
    'PlatformTeamDesignated',
    z.object({ orgId: Id.nullable(), projectId: Id.nullable(), by: Id.optional() }),
  ),
  /**
   * Work is paused for a scope (project, workflow, stage, workstation: all given fields must match). Automatic when a
   * critical bug hits, manual from the platform desk or API. The dispatcher skips cards inside the scope.
   */
  defineEvent(
    'PlatformPauseStarted',
    z.object({
      pauseId: Id,
      scope: Scope,
      reason: z.string().max(500),
      source: z.enum(['auto', 'manual']),
      severity: z.enum(['unrated', 'critical', 'degraded', 'minor']).default('critical'),
      bugSignature: z.string().max(200).optional(),
      bugCardId: Id.optional(),
      by: Id.optional(),
    }),
  ),
  /** The pause ended: the linked bug card was fixed (or closed as invalid), or somebody resumed it by hand. */
  defineEvent(
    'PlatformPauseEnded',
    z.object({
      pauseId: Id,
      reason: z.string().max(500),
      by: z.enum(['fix', 'manual', 'invalid']),
      byUserId: Id.optional(),
    }),
  ),
  // ---- platform security (1.10.0): stream `platform-security`, platform audit `always`
  /** The super admin added a block-list entry (R1): a domain (with its subdomains), an exact address, an IP or CIDR, or an allowed domain. */
  defineEvent(
    'PlatformBlockAdded',
    z.object({
      blockId: Id,
      kind: BlockKindSchema,
      /** Normalized: lower-case domain or address, canonical IP or CIDR. */
      value: z.string().min(1).max(320),
      note: z.string().max(500).default(''),
      by: Id,
      meta: EventMetaSchema,
    }),
  ),
  defineEvent(
    'PlatformBlockRemoved',
    z.object({
      blockId: Id,
      kind: BlockKindSchema,
      value: z.string().min(1).max(320),
      by: Id,
      meta: EventMetaSchema,
    }),
  ),
  /** A security setting changed (R27, R28): `requireSignedRunners` or `enforceTwoFactor`. Never for a locked key. */
  defineEvent(
    'SecuritySettingChanged',
    z.object({
      key: SecuritySettingKeySchema,
      value: z.boolean(),
      by: Id,
      /** Turning signed runners on: how many unsigned workstations the sweep unlinked in the same transaction. */
      unlinked: z.number().int().nonnegative().optional(),
      meta: EventMetaSchema,
    }),
  ),
] as const;
