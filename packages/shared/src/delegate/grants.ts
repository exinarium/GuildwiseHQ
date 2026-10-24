import { z } from 'zod';
import { personaToolSet } from '../capabilities/authoring.ts';
import { ModelChoiceSchema } from '../models/choices.ts';
import type { AgentPermissions } from '../roles/schema.ts';

/**
 * Explicit delegation (revision R3b, docs/ARCHITECTURE.md section 38.9). Nobody delegates by default: an agent, or the
 * facilitator and Chair of one session, delegates only to the targets (personas or hired agents) somebody granted. A target runs
 * on its own model, with its own tool profile clamped to the caller's.
 */

// ------------------------------------------------------------------------------------------------------- tool profile

/** What a child run may do. `web` and MCP tools are never part of a delegate's profile. */
export const DELEGATE_PROFILES = ['read_only', 'edit', 'shell'] as const;
export const DelegateProfileSchema = z.enum(DELEGATE_PROFILES);
export type DelegateProfile = z.infer<typeof DelegateProfileSchema>;

const RANK: Record<DelegateProfile, number> = { read_only: 0, edit: 1, shell: 2 };
export const profileRank = (p: DelegateProfile): number => RANK[p];

/** The narrower of two profiles (the intersection of two ladders). */
export function narrowerProfile(a: DelegateProfile, b: DelegateProfile): DelegateProfile {
  return RANK[a] <= RANK[b] ? a : b;
}

/** `edit` and `shell` of a role's permissions as a profile: shell wins, then edit, else read only. */
export function profileOfPermissions(p: Pick<AgentPermissions, 'allowedTools'>): DelegateProfile {
  const t = new Set(p.allowedTools);
  if (t.has('shell') || t.has('bash')) return 'shell';
  if (t.has('edit')) return 'edit';
  return 'read_only';
}

/** A persona's declared `tools` (frontmatter) as a profile; nothing declared means read only. */
export function profileOfPersonaTools(tools: readonly string[] | undefined): DelegateProfile {
  const set = personaToolSet(tools);
  if (set.includes('shell')) return 'shell';
  if (set.includes('edit')) return 'edit';
  return 'read_only';
}

/** The tool names of a profile in the provider-neutral vocabulary of `AgentPermissions.allowedTools`. */
export function toolsOfProfile(p: DelegateProfile): Array<'read' | 'edit' | 'shell'> {
  return p === 'shell' ? ['read', 'edit', 'shell'] : p === 'edit' ? ['read', 'edit'] : ['read'];
}

const intersect = <T>(a: readonly T[], b: readonly T[]): T[] => a.filter((x) => b.includes(x));

/**
 * The permissions of a child run: what the target is allowed, narrowed to the effective profile and to the parent's
 * permissions, so a child never exceeds its parent. `web`, MCP tools, browsers and organization-wide repository reads are
 * not delegated. Writable globs: the parent's when the target has no list of its own, else the globs both name. Denied shell
 * patterns add up. Committing needs both.
 */
export function childPermissions(
  target: AgentPermissions,
  parent: AgentPermissions,
  profile: DelegateProfile,
): AgentPermissions {
  const effective = narrowerProfile(
    narrowerProfile(profile, profileOfPermissions(target)),
    profileOfPermissions(parent),
  );
  const tools = intersect(toolsOfProfile(effective), parent.allowedTools);
  const globs: string[] | null =
    parent.writableGlobs === null
      ? target.writableGlobs
      : target.writableGlobs === null
        ? parent.writableGlobs
        : intersect(target.writableGlobs, parent.writableGlobs);
  return {
    allowedTools: tools.length ? tools : ['read'],
    deniedShellPatterns: [...new Set([...parent.deniedShellPatterns, ...target.deniedShellPatterns])],
    writableGlobs: tools.includes('edit') ? globs : [],
    mayCommit: target.mayCommit && parent.mayCommit && tools.includes('shell'),
    browser: false,
    riskTiers: intersect(target.riskTiers, parent.riskTiers),
    readOrgRepos: target.readOrgRepos && parent.readOrgRepos,
    repoIds:
      parent.repoIds === null
        ? target.repoIds
        : target.repoIds === null
          ? parent.repoIds
          : intersect(target.repoIds, parent.repoIds),
  };
}

/** The effective profile of a child: the target's (as granted), narrowed to the parent's. */
export function effectiveProfile(
  target: DelegateProfile,
  parent: DelegateProfile,
  grantMax?: DelegateProfile | null,
): DelegateProfile {
  return narrowerProfile(narrowerProfile(target, parent), grantMax ?? 'shell');
}

// ------------------------------------------------------------------------------------------------------------ grants

export const DELEGATE_GRANT_LIMITS = {
  /** Targets one owner (an agent, or a session) may be granted. */
  maxGrantsPerOwner: 20,
  /** Calls to one target per caller turn or shift, unless the grant says otherwise. */
  defaultMaxCalls: 4,
  /** The most a grant may allow per caller. */
  maxCallsCap: 8,
  /** The time limit of one child run, in seconds. */
  defaultTimeoutSec: 110,
  minTimeoutSec: 10,
  /** Below the 10 minutes Claude Code allows a shell command, so the caller's own `aom delegate` call is not killed first. */
  maxTimeoutSec: 540,
} as const;

/**
 * Whose grant it is: one agent, one session (its facilitator and Chair), or a ROLE (R3c, Q61): a role's grants cover every agent
 * of the role, the future hires included, and a per-agent grant can add targets but never take one of the role's away.
 */
export const DelegateOwnerKindSchema = z.enum(['agent', 'session', 'role']);
export type DelegateOwnerKind = z.infer<typeof DelegateOwnerKindSchema>;
export const DelegateTargetKindSchema = z.enum(['persona', 'agent']);
export type DelegateTargetKind = z.infer<typeof DelegateTargetKindSchema>;

/** The settings of one grant. */
export const DelegateGrantSettingsSchema = z.object({
  /** Calls to this target per caller turn or shift. */
  maxCalls: z
    .number()
    .int()
    .min(1)
    .max(DELEGATE_GRANT_LIMITS.maxCallsCap)
    .default(DELEGATE_GRANT_LIMITS.defaultMaxCalls),
  /** Time limit of one child run. */
  timeoutSec: z
    .number()
    .int()
    .min(DELEGATE_GRANT_LIMITS.minTimeoutSec)
    .max(DELEGATE_GRANT_LIMITS.maxTimeoutSec)
    .default(DELEGATE_GRANT_LIMITS.defaultTimeoutSec),
  /** Narrow the target's own tool profile (absent: the target's own, clamped to the caller's). */
  maxProfile: DelegateProfileSchema.nullable().default(null),
  /**
   * R3c (Q62): the model the target runs on FOR THIS CALLER, instead of its own. Checked when the grant is made (a model the
   * product knows, a runtime that can take the target) and again at each call. The caller still cannot choose: `--model` stays
   * refused. Absent: the target's own model.
   */
  model: ModelChoiceSchema.nullable().default(null),
});
export type DelegateGrantSettings = z.infer<typeof DelegateGrantSettingsSchema>;

/** PUT body: grant (or change) a target; `grant: null` revokes it. */
export const SetDelegateGrantRequestSchema = z.object({
  targetKind: DelegateTargetKindSchema,
  /** A persona key (`devils-advocate`, `bmad:analyst`) or an agent id. */
  targetKey: z.string().trim().min(1).max(130),
  grant: DelegateGrantSettingsSchema.nullable(),
});
export type SetDelegateGrantRequest = z.infer<typeof SetDelegateGrantRequestSchema>;

/** PUT body (Q66): exclude one agent from a target its role grants it, or take the exclusion back. */
export const SetDelegateExclusionRequestSchema = z.object({
  targetKind: DelegateTargetKindSchema,
  targetKey: z.string().trim().min(1).max(130),
  excluded: z.boolean(),
});
export type SetDelegateExclusionRequest = z.infer<typeof SetDelegateExclusionRequestSchema>;

/** One grant as the pages show it. */
export const DelegateGrantDtoSchema = z.object({
  targetKind: DelegateTargetKindSchema,
  targetKey: z.string(),
  /** What the target is called (a persona's name, an agent's name); the key when it is not known any more. */
  targetName: z.string(),
  /** The name the caller types: the persona key, or `agent:<slug>`. */
  handle: z.string(),
  maxCalls: z.number().int(),
  timeoutSec: z.number().int(),
  maxProfile: DelegateProfileSchema.nullable(),
  /** The target's tool profile when the server knows it (hired agents); a persona's lives in the registry on the workstation. */
  profile: DelegateProfileSchema.nullable(),
  /** The model the target runs on (`claude-code:sonnet`), when the server knows it. */
  model: z.string().nullable(),
  /** The grant cannot be used now: the target is retired, or its runtime is not usable. */
  problem: z.string().nullable(),
  grantedAt: z.iso.datetime(),
  grantedBy: z.uuid().nullable(),
  /** R3c (Q62): the model the grant sets for this caller (`claude-code:haiku`), if any; `model` above is then not the one it runs on. */
  modelOverride: z.string().nullable().default(null),
  /** R3c (Q61): the grant comes from the agent's role, not from the agent: change it on the role. */
  inherited: z.boolean().default(false),
  /** R3c (Q66): this agent was excluded from the role's grant: it does not have the target (shown struck out, with a way back). */
  excluded: z.boolean().default(false),
});
export type DelegateGrantDto = z.infer<typeof DelegateGrantDtoSchema>;

export const DelegateGrantsDtoSchema = z.object({
  ownerKind: DelegateOwnerKindSchema,
  ownerId: z.uuid(),
  /** The viewer may add and remove grants. */
  canManage: z.boolean(),
  /** R3c (Q66): the viewer (an Owner or Admin) may exclude this agent from a target its role grants. */
  canExclude: z.boolean().default(false),
  /** R3c: an agent's role (whose grants it inherits) or, for a role, its key. */
  roleKey: z.string().nullable().default(null),
  grants: z.array(DelegateGrantDtoSchema),
});
export type DelegateGrantsDto = z.infer<typeof DelegateGrantsDtoSchema>;

/** What a grant picker offers: a persona of the registry, or a hired agent. */
export const DelegateTargetOptionSchema = z.object({
  targetKind: DelegateTargetKindSchema,
  targetKey: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.string().nullable(),
  profile: DelegateProfileSchema.nullable(),
  granted: z.boolean(),
});
export type DelegateTargetOption = z.infer<typeof DelegateTargetOptionSchema>;
export const DelegateTargetOptionsDtoSchema = z.object({ items: z.array(DelegateTargetOptionSchema) });

// -------------------------------------------------------------------------------- what the runner is told at a start

/**
 * A target as the runner is told about it when a shift, chat or session turn starts: enough to show the caller its options
 * and to expose native subagents. `delegate.begin` answers again, with the server's current word, before a child starts.
 */
export const DelegateTargetSpecSchema = z.object({
  kind: DelegateTargetKindSchema,
  /** What the caller types: the persona key, or `agent:<slug>`. */
  handle: z.string().min(1).max(140),
  /** A persona key, or an agent id. */
  key: z.string().min(1).max(130),
  name: z.string().max(200),
  description: z.string().max(1024).default(''),
  maxCalls: z.number().int().min(1).max(DELEGATE_GRANT_LIMITS.maxCallsCap),
  timeoutSec: z
    .number()
    .int()
    .min(DELEGATE_GRANT_LIMITS.minTimeoutSec)
    .max(DELEGATE_GRANT_LIMITS.maxTimeoutSec),
  maxProfile: DelegateProfileSchema.nullable().default(null),
  /** R3c (Q62): the grant sets the model for this caller; absent: the target's own. */
  modelOverride: z.object({ runtime: z.string().max(60), model: z.string().max(120) }).optional(),
  /** A hired agent: its runtime and model, and its tool profile (the role's permissions). */
  runtime: z.string().max(60).optional(),
  model: z.string().max(120).optional(),
  profile: DelegateProfileSchema.optional(),
  /** A hired agent: the role's instructions (a persona's text is read from the workstation's registry). */
  instructions: z.string().max(40_000).optional(),
  /** A hired agent's permissions: the child's are these narrowed to the caller's. */
  permissions: z
    .object({
      allowedTools: z.array(z.string()),
      deniedShellPatterns: z.array(z.string()),
      writableGlobs: z.array(z.string()).nullable(),
      mayCommit: z.boolean(),
      browser: z.boolean().default(false),
      riskTiers: z.array(z.enum(['small', 'large'])).default(['small', 'large']),
      readOrgRepos: z.boolean().default(false),
      repoIds: z.array(z.uuid()).nullable(),
    })
    .optional(),
});
export type DelegateTargetSpec = z.infer<typeof DelegateTargetSpecSchema>;

export const DelegationSpecSchema = z.object({
  targets: z.array(DelegateTargetSpecSchema).max(DELEGATE_GRANT_LIMITS.maxGrantsPerOwner),
});
export type DelegationSpec = z.infer<typeof DelegationSpecSchema>;

/** The handle a caller types for an agent target: `agent:<slug of the name>` (the server makes it unique per owner). */
export function agentHandle(name: string, taken: ReadonlySet<string> = new Set(), id = ''): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent';
  const base = `agent:${slug}`;
  return taken.has(base) ? `${base}-${id.slice(0, 4)}` : base;
}

// ------------------------------------------------------------------------------------------------- sub-steps on pages

/** A delegation shown on the card or session as a sub-step. */
export const DelegationStepDtoSchema = z.object({
  delegateId: z.uuid(),
  /** The caller's shift or turn. */
  callerId: z.uuid(),
  target: z.string(),
  targetName: z.string(),
  targetKind: DelegateTargetKindSchema.nullable(),
  model: z.string(),
  profile: DelegateProfileSchema.nullable(),
  outcome: z.string(),
  durationMs: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  costUnknown: z.boolean(),
  /** The first lines of the reply (or the failure). */
  summary: z.string().nullable(),
  /** Run by Claude Code's own subagent tool instead of `aom delegate`. */
  native: z.boolean(),
  /** R3c (Q63): the target's own profile when it ran with a narrower one (the caller's tools or the grant's ceiling allow less). */
  narrowedFrom: DelegateProfileSchema.nullable().default(null),
  at: z.iso.datetime(),
});
export type DelegationStepDto = z.infer<typeof DelegationStepDtoSchema>;

// ----------------------------------------------------------------------------------------- Claude Code native subagents

/** The Claude Code tool names of a profile, for a native subagent's `tools` list. */
export const NATIVE_SUBAGENT_TOOLS: Record<DelegateProfile, readonly string[]> = {
  read_only: ['Read', 'Grep', 'Glob'],
  edit: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  shell: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
};

/** A subagent name Claude Code accepts: lowercase letters, digits and hyphens (`bmad:analyst` -> `bmad-analyst`), unique in the list. */
export function nativeSubagentName(handle: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    handle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'delegate';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

const sameSet = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null ? a === b : a.length === b.length && a.every((x) => b.includes(x));

/**
 * May this target run as a native Claude Code subagent without being allowed more or less than its own profile? A native
 * subagent lives inside its parent's process: it gets the parent's permission rules and sandbox, and the `tools` list can only
 * narrow them. So the target's profile is honoured exactly when it asks for reading only, or for the parent's own edit paths and
 * shell denials (a persona has none of its own; a hired agent must have the same writable paths and at least the parent's
 * denials). A hired agent with narrower write paths or its own denials is run with `aom delegate` instead, where the child gets
 * the intersection as a separate sandboxed process.
 */
export function nativeHonoursProfile(
  target: { kind: DelegateTargetKind; profile: DelegateProfile; permissions?: AgentPermissions | undefined },
  parent: AgentPermissions,
): boolean {
  if (target.profile === 'read_only') return true;
  if (target.kind === 'persona' || !target.permissions) return true;
  const t = target.permissions;
  return (
    sameSet(t.writableGlobs, parent.writableGlobs) &&
    parent.deniedShellPatterns.every((p) => t.deniedShellPatterns.includes(p)) &&
    t.deniedShellPatterns.every((p) => parent.deniedShellPatterns.includes(p))
  );
}
