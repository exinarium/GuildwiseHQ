import { z } from 'zod';
import { AvatarSeedSchema, AvatarStyleSchema } from '../avatars/index.ts';
import { PackProvenanceSchema } from '../capabilities/provenance.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';
import { defineEvent, Id } from './define.ts';

export const AgentChangesSchema = z
  .object({
    model: z.string(),
    effort: z.string().nullable(),
    runtime: z.string(),
    roleKey: z.string(),
    roleVersion: z.number().int().min(1),
    seniority: Seniority,
    skills: z.array(z.string()),
    permissions: AgentPermissionsSchema,
    capacity: z.number().int().min(1).max(8),
  })
  .partial();
export type AgentChanges = z.infer<typeof AgentChangesSchema>;

/** Who accepted, and when, that the agent runs on a runtime with no OS sandbox. */
export const UnsandboxedAckSchema = z.object({ by: Id, at: z.iso.datetime() });
export type UnsandboxedAck = z.infer<typeof UnsandboxedAckSchema>;

/** An agent can prefer at most this many projects. */
export const MAX_FOCUS_PROJECTS = 10;

export const agentEvents = [
  defineEvent(
    'AgentHired',
    z.object({
      agentId: Id,
      orgId: Id,
      /** The project the agent was hired for, kept as history only: it never limits where the agent works. */
      projectId: Id.optional(),
      /**
       * Where the agent may work: a list of projects, or null for any project of the organization. Hires from before
       * allow-lists have no field: they get `[projectId]` when they were project-scoped, otherwise any project.
       */
      allowedProjectIds: z.array(Id).max(500).nullable().optional(),
      /** Projects the agent prefers inside its allow-list (soft preference for the dispatcher's ordering). */
      focusProjectIds: z.array(Id).max(MAX_FOCUS_PROJECTS).optional(),
      hiredByUserId: Id,
      /** Null for the built-in CEO of an organization whose Owner has no workstation yet (bound at his first pairing). */
      workstationId: Id.nullable(),
      name: z.string().min(1),
      roleKey: z.string().min(1),
      roleVersion: z.number().int().min(1),
      seniority: Seniority,
      runtime: z.string().min(1),
      model: z.string().min(1),
      effort: z.string().optional(),
      skills: z.array(z.string()),
      permissions: AgentPermissionsSchema,
      capacity: z.number().int().min(1).max(8),
      isDevops: z.boolean(),
      /** Built in, free of limits and not removable: the DevOps engineer and the CEO. Older hires derive it from `isDevops`/`roleKey`. */
      isBuiltin: z.boolean().optional(),
      unsandboxedAck: UnsandboxedAckSchema.optional(),
      /** The generated face; an agent hired before faces existed gets one seeded from its id. */
      avatarSeed: AvatarSeedSchema.optional(),
      avatarStyle: AvatarStyleSchema.optional(),
      /** R3a: hired from a pack persona; shown as a tag on the HR board, the agent page and chats. */
      provenance: PackProvenanceSchema.optional(),
    }),
  ),
  defineEvent(
    'AgentChanged',
    z.object({ agentId: Id, changes: AgentChangesSchema, unsandboxedAck: UnsandboxedAckSchema.optional() }),
  ),
  /** The manager set where the agent may work: a project list, or null for any project of the organization. */
  defineEvent(
    'AgentAllowedSet',
    z.object({ agentId: Id, projectIds: z.array(Id).max(500).nullable(), by: Id }),
  ),
  /** The manager set the projects the agent prefers (a soft preference inside the allow-list). */
  defineEvent(
    'AgentFocusSet',
    z.object({ agentId: Id, projectIds: z.array(Id).max(MAX_FOCUS_PROJECTS), by: Id }),
  ),
  /**
   * The agent's role moved to a new version and the agent follows it: its permissions are re-derived as the new
   * version's permissions plus the agent's own deviations (kept from `previous`). Written by the server at boot and when
   * an organization role version is approved, so projections rebuild to the same permissions.
   */
  defineEvent(
    'AgentPermissionsRebased',
    z.object({
      agentId: Id,
      roleKey: z.string().min(1),
      fromRoleVersion: z.number().int().min(1),
      toRoleVersion: z.number().int().min(1),
      previous: AgentPermissionsSchema,
      permissions: AgentPermissionsSchema,
    }),
  ),
  defineEvent('AgentRetired', z.object({ agentId: Id, by: Id, releasedCardIds: z.array(Id) })),
  defineEvent('AgentReset', z.object({ agentId: Id })),
  /** The agent takes no new work (a running shift finishes). By the manager, or by the CEO on the owner's behalf. */
  defineEvent(
    'AgentPaused',
    z.object({
      agentId: Id,
      by: Id.optional(),
      reason: z.string().max(500).default(''),
      viaCeo: z.boolean().default(false),
    }),
  ),
  defineEvent(
    'AgentResumed',
    z.object({ agentId: Id, by: Id.optional(), viaCeo: z.boolean().default(false) }),
  ),
  /** "Re-roll face": a new seed (and optionally another style) for the agent's generated face. */
  defineEvent(
    'AgentAvatarRerolled',
    z.object({ agentId: Id, avatarSeed: AvatarSeedSchema, avatarStyle: AvatarStyleSchema, by: Id }),
  ),
  defineEvent(
    'AgentRehomed',
    z.object({
      agentId: Id,
      /** Null clears the home (the built-in CEO when the Owner changes and the new Owner has no workstation). */
      workstationId: Id.nullable(),
      runtime: z.string(),
      model: z.string(),
      unsandboxedAck: UnsandboxedAckSchema.optional(),
    }),
  ),
] as const;
