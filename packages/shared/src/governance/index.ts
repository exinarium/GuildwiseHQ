import { z } from 'zod';

/**
 * S-B1 Governance (docs/design/discovery-boardroom-registry.md, "S-B1 as built"): approve from the notification, the
 * per-agent "What it may do" screen with approval gates, pack scopes, audit export and offboarding.
 */

// ---------------------------------------------------------------------------------------------------- notification actions

/** A desk push carries at most this many buttons (most push services show two; the rest is the notification's own link). */
export const MAX_PUSH_ACTIONS = 2;
/** A one-tap link lives this long, and works once. */
export const DESK_ACTION_TOKEN_TTL_MS = 15 * 60_000;

export const DeskActionKindSchema = z.string().regex(/^(approve|reject|option:[A-Za-z0-9_-]{1,40})$/);
export type DeskActionKind = z.infer<typeof DeskActionKindSchema>;
export const optionAction = (optionId: string): DeskActionKind => `option:${optionId}`;

/** `GET /api/m/desk/:token`: what the confirm page shows. Nothing is applied by this call. */
export const DeskActionPreviewSchema = z.object({
  state: z.enum(['ready', 'used', 'expired', 'resolved']),
  deskItemId: z.uuid(),
  title: z.string(),
  body: z.string(),
  orgName: z.string(),
  /** What the button does ("Approve", "Reject", or the option's label). */
  actionLabel: z.string(),
  action: DeskActionKindSchema,
  expiresAt: z.iso.datetime(),
});
export type DeskActionPreview = z.infer<typeof DeskActionPreviewSchema>;

export const DeskActionAppliedSchema = z.object({
  deskItemId: z.uuid(),
  outcome: z.enum(['approved', 'rejected', 'answered']),
  actionLabel: z.string(),
});
export type DeskActionApplied = z.infer<typeof DeskActionAppliedSchema>;

// ---------------------------------------------------------------------------------------------------- approval gates

/**
 * The side-effecting action classes an agent may be gated on. A gated action pauses and raises a desk item; the agent
 * continues (retries) after the approval. `enforcement` says where the server enforces it today.
 */
export const GATE_CLASSES = [
  'merge_push',
  'deploy',
  'outbound_mail',
  'pack_scripts',
  'delegation',
  'playbook_run',
] as const;
export const GateClassSchema = z.enum(GATE_CLASSES);
export type GateClass = z.infer<typeof GateClassSchema>;

export const GATE_INFO: Record<
  GateClass,
  { label: string; description: string; enforcement: 'opt_in' | 'always' | 'not_enforced'; note: string }
> = {
  merge_push: {
    label: 'Merge and push',
    description: 'Landing the agent’s work: a merge, a pushed branch or a pull request.',
    enforcement: 'opt_in',
    note: 'Gated, every finalize of a card this agent built waits for an approval on your Desk. Large and high-risk merges always wait.',
  },
  deploy: {
    label: 'Deploy',
    description: 'Asking for a deploy (the DevOps engineer’s `aom deploy run`).',
    enforcement: 'opt_in',
    note: 'The CEO’s deploys keep the CEO policy; release gates of a project apply on top.',
  },
  outbound_mail: {
    label: 'Outbound mail and ticket updates',
    description: 'Anything an agent drafts to go out of the company (ticket comments, mail).',
    enforcement: 'always',
    note: 'Always asks: every outbound draft waits for the manager’s approval, nothing is sent before.',
  },
  pack_scripts: {
    label: 'Pack scripts',
    description: 'Running scripts that ship with a capability pack.',
    enforcement: 'opt_in',
    note: 'Gated, each script file of a pack is handed to the agent only after an approval (single use). Scripts also stay off until an Owner enables them for the pack. Needs runner 0.1.60 or newer.',
  },
  delegation: {
    label: 'Delegation',
    description: 'Starting a delegate (`aom delegate`) on a persona or another agent.',
    enforcement: 'opt_in',
    note: 'Gated, each delegation waits for an approval, on top of the delegation grant.',
  },
  playbook_run: {
    label: 'Playbook run',
    description: 'Starting a guided playbook session (`aom playbook run`).',
    enforcement: 'opt_in',
    note: 'Gated, each run waits for an approval, on top of the playbook grant.',
  },
};

/** Announced in `hello.capabilities` by runners that ask the server before they hand a pack script to a gated agent (runner 0.1.60). */
export const PACK_SCRIPT_GATE_CAPABILITY = 'pack-script-gate:1';
/** Announced by runners that can run an @mention with the work tools the server grants it (runner 0.1.60). */
export const MENTION_WORK_CAPABILITY = 'mention-work:1';

/** How long an approved gated action may be used by the agent's retry. */
export const GATE_APPROVAL_TTL_MS = 2 * 3600_000;
export const GATE_DESK_SUBKIND = 'agent_gate';

export const GatedActionStatusSchema = z.enum(['pending', 'approved', 'rejected', 'used', 'expired']);

export const AgentGateSchema = z.object({
  actionClass: GateClassSchema,
  label: z.string(),
  description: z.string(),
  enforcement: z.enum(['opt_in', 'always', 'not_enforced']),
  note: z.string(),
  gated: z.boolean(),
  /** Open requests waiting for an approval. */
  pending: z.number().int().nonnegative(),
});
export type AgentGate = z.infer<typeof AgentGateSchema>;

export const SetAgentGateRequestSchema = z.object({ actionClass: GateClassSchema, gated: z.boolean() });
export type SetAgentGateRequest = z.infer<typeof SetAgentGateRequestSchema>;

// ---------------------------------------------------------------------------------------------------- pack scopes

/**
 * Scopes a pack capability declares it needs (manifest `scopes:`, SKILL frontmatter `metadata.scopes`, persona and playbook
 * frontmatter `scopes:`). A scope an agent lacks is warned about when the capability is granted.
 */
export const KNOWN_SCOPES = {
  read: 'Read files',
  edit: 'Edit files',
  shell: 'Run shell commands',
  web: 'Use the web',
  mcp: 'Use external tools (MCP)',
  commit: 'Commit to git',
  browser: 'Run a browser',
  'org-repos': 'Read every repository of the organization',
  scripts: 'Run the pack’s scripts',
  delegate: 'Delegate to other agents',
} as const;
export type KnownScope = keyof typeof KNOWN_SCOPES;

/** Scopes from a list or a comma/space separated string: lowercase, unique, at most 20, each `[a-z0-9._:-]{1,40}`. */
export function normalizeScopes(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const s = p.trim().toLowerCase();
    if (/^[a-z0-9._:-]{1,40}$/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

export const ScopeCheckSchema = z.object({
  scope: z.string(),
  label: z.string(),
  known: z.boolean(),
  /** The agent has it. Unknown scopes are shown and never block (nothing to compare them with). */
  has: z.boolean(),
});
export type ScopeCheck = z.infer<typeof ScopeCheckSchema>;

export interface AgentScopeFacts {
  allowedTools: readonly string[];
  mayCommit: boolean;
  browser: boolean;
  readOrgRepos: boolean;
  /** The agent holds at least one delegation grant. */
  hasDelegation: boolean;
  /** Scripts of the pack are switched on. */
  scriptsEnabled: boolean;
}

export function checkScopes(scopes: readonly string[], f: AgentScopeFacts): ScopeCheck[] {
  const has = (s: string): boolean | null => {
    switch (s) {
      case 'read':
      case 'edit':
      case 'shell':
      case 'web':
        return f.allowedTools.includes(s);
      case 'mcp':
        return f.allowedTools.some((t) => t.startsWith('mcp:'));
      case 'commit':
        return f.mayCommit;
      case 'browser':
        return f.browser;
      case 'org-repos':
        return f.readOrgRepos;
      case 'scripts':
        return f.scriptsEnabled;
      case 'delegate':
        return f.hasDelegation;
      default:
        return null;
    }
  };
  return scopes.map((scope) => {
    const h = has(scope);
    return {
      scope,
      label: (KNOWN_SCOPES as Record<string, string>)[scope] ?? scope,
      known: h !== null,
      has: h ?? true,
    };
  });
}

/** What a grant of a capability tells the granter, and what they must confirm. */
export const ScopeWarningSchema = z.object({
  /** The capability asks for these. */
  required: z.array(ScopeCheckSchema),
  /** Of `required`, the known scopes this agent lacks: granting needs `confirmScopes`. */
  missing: z.array(z.string()),
});
export type ScopeWarning = z.infer<typeof ScopeWarningSchema>;

// ---------------------------------------------------------------------------------------------------- What it may do

export const MayDoGrantSchema = z.object({
  kind: z.enum(['persona', 'agent']),
  name: z.string(),
  handle: z.string(),
  /** From the agent's role (every agent of the role). */
  inherited: z.boolean(),
  /** An Owner or Admin excluded this agent from a target its role grants. */
  excluded: z.boolean(),
  maxCalls: z.number().int(),
  maxProfile: z.string().nullable(),
});

export const AgentMayDoSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  tools: z.object({
    allowedTools: z.array(z.string()),
    deniedShellPatterns: z.array(z.string()),
    writableGlobs: z.array(z.string()).nullable(),
    mayCommit: z.boolean(),
    browser: z.boolean(),
    riskTiers: z.array(z.string()),
  }),
  repos: z.object({
    readOrgRepos: z.boolean(),
    /** null: every repository of its projects. */
    repos: z.array(z.object({ id: z.uuid(), name: z.string() })).nullable(),
  }),
  data: z.object({
    /** null: any project of the organization. */
    projects: z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string() })).nullable(),
    mcpServers: z.array(z.string()),
  }),
  provider: z.object({
    runtime: z.string(),
    model: z.string(),
    effort: z.string().nullable(),
    workstation: z.string().nullable(),
    /** Which key pays: the organization's (with its monthly cap) or the owner’s own/subscription login. */
    keySource: z.enum(['org', 'workstation', 'login', 'unknown']),
  }),
  delegation: z.array(MayDoGrantSchema),
  playbooks: z.array(z.object({ key: z.string(), name: z.string() })),
  skills: z.array(z.object({ key: z.string(), scopes: z.array(z.string()) })),
  packs: z.array(z.object({ packId: z.uuid(), name: z.string(), scopes: z.array(z.string()) })),
  spend: z
    .object({
      currency: z.string(),
      monthMicros: z.number(),
      totalMicros: z.number(),
      /** The tightest budget in force: a project’s monthly budget it may work on, or the organization key’s cap. */
      budgets: z.array(z.object({ label: z.string(), capMicros: z.number(), usedMicros: z.number() })),
    })
    .nullable(),
  gates: z.array(AgentGateSchema),
  /** The viewer may turn a gate on (whoever manages the agent) / off (Owner and Admins). */
  canGate: z.boolean(),
  canUngate: z.boolean(),
});
export type AgentMayDo = z.infer<typeof AgentMayDoSchema>;

// ---------------------------------------------------------------------------------------------------- audit export + offboarding

export const AUDIT_EXPORT_MAX_DAYS = 366;
export const AuditExportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  /** Inclusive start, as a date or a date-time; default: 30 days back. */
  from: z.string().min(8).max(40).optional(),
  /** Exclusive end; default: now. */
  to: z.string().min(8).max(40).optional(),
  /** Only events caused by this person. */
  actorUserId: z.uuid().optional(),
  /** Only this event type (exact). */
  type: z.string().min(1).max(80).optional(),
});
export type AuditExportQuery = z.infer<typeof AuditExportQuerySchema>;
export const AUDIT_COLUMNS = [
  'at',
  'type',
  'actor_kind',
  'actor_id',
  'actor_name',
  'stream',
  'project_id',
  'summary',
  'payload',
] as const;

export const OFFBOARDING_GRACE_DAYS = 30;

export const OffboardingStepSchema = z.object({
  key: z.enum([
    'sessions',
    'tokens',
    'workstations',
    'pack_credentials',
    'pack_assignments',
    'org_key_shares',
    'agents',
    'cards',
    'owned_sessions',
    'org_packs',
    'private_items',
    'push_devices',
  ]),
  label: z.string(),
  /** How many things this step touched (or would touch). */
  count: z.number().int().nonnegative(),
  status: z.enum(['done', 'nothing', 'kept', 'flagged']),
  detail: z.string(),
});
export type OffboardingStep = z.infer<typeof OffboardingStepSchema>;

export const OffboardingReportSchema = z.object({
  orgId: z.uuid(),
  userId: z.uuid(),
  userName: z.string(),
  transferredTo: z.uuid().nullable(),
  privatePurgeAfter: z.iso.datetime().nullable(),
  steps: z.array(OffboardingStepSchema),
  /** For the Owner: things the system cannot undo or must be done elsewhere (rotate a key they set, ...). */
  notes: z.array(z.string()),
});
export type OffboardingReport = z.infer<typeof OffboardingReportSchema>;
