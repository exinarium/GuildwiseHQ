import { z } from 'zod';

/**
 * The CEO agent's authority (docs/design/ceo-agent-v2.md section 3): every management action belongs to a class, the
 * owner's policy gives each class a mode, and the SERVER (never the prompt) decides. `evaluatePolicy` is a pure
 * function: the gateway supplies the facts it looked up (evidence found, limit counters) and gets a verdict.
 */

export const CEO_ROLE_KEY = 'ceo';
export const CEO_DEPARTMENT = 'management';
/** The desk item that shows an owner one decision the CEO took on its own, to acknowledge or correct. */
export const CEO_DECISION_SUBKIND = 'ceo_decision';

export const CeoMode = z.enum(['decide', 'recommend', 'never']);
export type CeoMode = z.infer<typeof CeoMode>;

export const ACTION_CLASSES = [
  'desk.answer_question',
  'desk.triage',
  'desk.resolve_notice',
  'card.release',
  'card.release_backoff',
  'card.reassign',
  'card.move',
  'card.raise_model',
  'card.reprioritise',
  'card.cancel',
  'card.create_via_ba',
  'card.specify',
  'backlog.manage',
  'shift.stop',
  'agent.pause',
  'agent.resume',
  'agent.change_model',
  'agent.change_seniority',
  'agent.allow_list',
  'agent.hire',
  'agent.bench',
  'agent.retire',
  'agent.scale',
  'hr.apply_recommendation',
  'devops.request',
  'devops.approve',
  'deploy.run',
  'order.invoke',
  'standing_order.propose',
  'standing_order.activate',
  'standing_order.retire',
  'message.agent',
  'notify.owner',
  'memory.write',
] as const;
export const ActionClass = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof ActionClass>;

/** Staffing and model changes (formerly forced to `recommend` during the removed training period). */
export const STAFFING_CLASSES: readonly ActionClass[] = [
  'agent.hire',
  'agent.bench',
  'agent.retire',
  'agent.scale',
  'agent.change_model',
  'agent.change_seniority',
  'agent.allow_list',
];
export const isStaffingClass = (c: string): boolean => (STAFFING_CLASSES as readonly string[]).includes(c);

export const CLASS_LABEL: Record<ActionClass, string> = {
  'desk.answer_question': 'Answer agent questions',
  'desk.triage': 'Triage alerts',
  'desk.resolve_notice': 'Acknowledge cleared notices',
  'card.release': 'Release or re-queue a card',
  'card.release_backoff': 'End a card back-off',
  'card.reassign': 'Reassign a card',
  'card.move': 'Move a card to another stage',
  'card.raise_model': 'Raise the model or effort for one card',
  'card.reprioritise': 'Change card priority',
  'card.cancel': 'Cancel a card',
  'card.create_via_ba': 'Ask the BA to draft cards',
  'card.specify': 'Specify a draft card (the BA completes what is missing)',
  'backlog.manage': 'Keep the project backlog: add, edit, flag, drop',
  'shift.stop': 'Stop a shift or its running command',
  'agent.pause': 'Pause an agent',
  'agent.resume': 'Resume an agent',
  'agent.change_model': 'Change an agent model',
  'agent.change_seniority': 'Promote or demote an agent',
  'agent.allow_list': 'Change where an agent works',
  'agent.hire': 'Hire an agent',
  'agent.bench': 'Bench an agent',
  'agent.retire': 'Retire (fire) an agent',
  'agent.scale': 'Scale a role up or down',
  'hr.apply_recommendation': 'Apply an HR recommendation',
  'devops.request': 'Ask DevOps (non-destructive)',
  'devops.approve': 'Approve DevOps actions',
  'deploy.run': 'Run a deploy through a delivery recipe',
  'order.invoke': 'Start a full-power turn for an owner-authorized standing order',
  'standing_order.propose': 'Propose a standing order',
  'standing_order.activate': 'Activate a standing order',
  'standing_order.retire': 'Retire a ledger entry',
  'message.agent': 'Message an agent',
  'notify.owner': 'Notify the owner',
  'memory.write': 'Remember an owner rule',
};

/** Owner-reserved: always `recommend` unless delegated per key. A delegation names the risk and is confirmed. */
export const OWNER_RESERVED_KEYS = [
  'completion_action',
  'manual_qa',
  'finalize_merge',
  'outbound',
  'production_deploy',
  'devops_destructive',
  'budget_paused',
  'definition_approval',
  'taste_rules',
  'vault_conflict',
  'repo_create',
  'mass_cancel',
  'working_branch',
] as const;
export const OwnerReservedKey = z.enum(OWNER_RESERVED_KEYS);
export type OwnerReservedKey = z.infer<typeof OwnerReservedKey>;

export const OWNER_RESERVED_LABEL: Record<OwnerReservedKey, string> = {
  completion_action: 'Setting or changing a card completion action',
  manual_qa: 'Passing, skipping or sending back manual QA',
  finalize_merge: 'Finalize, large merge and pull request approvals',
  outbound: 'Posting to outside systems (tickets, comments)',
  production_deploy: 'Production deploys',
  devops_destructive: 'DevOps actions that destroy or change production',
  budget_paused: 'Raising or overriding a budget',
  definition_approval: 'Approving new roles and workflows',
  taste_rules: 'Taste rules',
  vault_conflict: 'Resolving knowledge vault conflicts',
  repo_create: 'Creating repositories',
  mass_cancel: 'Cancelling more than 3 cards at once',
  working_branch: 'Choosing which branch a repository works on (answering working-branch questions)',
};

/** Never delegable, whatever the policy says. The CEO has no action for them; a request for one is refused. */
export const HARD_NEVER = [
  'ceo.policy',
  'ceo.settings',
  'org.members',
  'org.security',
  'billing',
  'secrets',
  'agent.widen_permissions',
  'mcp.grant',
  'project.delete',
  'devops.fire',
  'budget.raise',
  'budget.override',
] as const;
export const isHardNever = (c: string): boolean => (HARD_NEVER as readonly string[]).includes(c);

export const CeoLimitsSchema = z.object({
  maxHiresPerDay: z.number().int().min(0).max(20).default(2),
  maxAgentsPerRolePerProject: z.number().int().min(1).max(20).default(3),
  maxCeoHiredActive: z.number().int().min(0).max(50).default(6),
  maxActionsPerHour: z.number().int().min(1).max(500).default(30),
  maxMessagesPerAgentPerDay: z.number().int().min(0).max(50).default(5),
  maxActionsPerSubjectPerDay: z.number().int().min(1).max(50).default(3),
  maxWakesPerHour: z.number().int().min(1).max(60).default(12),
  /** A hire or model-up is allowed only while the forecast month spend stays under this share of the budget. */
  budgetHeadroom: z.number().min(0.1).max(1).default(0.9),
});
export type CeoLimits = z.infer<typeof CeoLimitsSchema>;
export const DEFAULT_CEO_LIMITS: CeoLimits = CeoLimitsSchema.parse({});

export const CeoPolicySchema = z.object({
  version: z.number().int().min(0).default(1),
  classes: z.record(
    z.string(),
    z.object({ mode: CeoMode, delayMinutes: z.number().int().min(0).max(240).default(0) }),
  ),
  /** Desk item key (`kind:subkind`, `kind:*`) -> mode. */
  desk: z.record(z.string(), CeoMode),
  delegated: z.array(OwnerReservedKey).default([]),
  minConfidence: z.number().min(0).max(1).default(0.75),
  limits: CeoLimitsSchema.default(DEFAULT_CEO_LIMITS),
});
export type CeoPolicy = z.infer<typeof CeoPolicySchema>;

const decide = { mode: 'decide' as const, delayMinutes: 0 };
const recommend = { mode: 'recommend' as const, delayMinutes: 0 };

/** The policy once the training period is over (v2 section 3.1). */
export const DEFAULT_CEO_POLICY: CeoPolicy = {
  version: 1,
  classes: {
    'desk.answer_question': decide,
    'desk.triage': decide,
    'desk.resolve_notice': decide,
    'card.release': decide,
    'card.release_backoff': decide,
    'card.reassign': decide,
    'card.move': decide,
    'card.raise_model': decide,
    'card.reprioritise': decide,
    'card.cancel': recommend,
    'card.create_via_ba': decide,
    'card.specify': decide,
    'backlog.manage': decide,
    'shift.stop': decide,
    'agent.pause': decide,
    'agent.resume': decide,
    'agent.change_model': decide,
    'agent.change_seniority': decide,
    'agent.allow_list': decide,
    'agent.hire': decide,
    'agent.bench': decide,
    'agent.retire': recommend,
    'agent.scale': decide,
    'hr.apply_recommendation': decide,
    'devops.request': decide,
    'devops.approve': recommend,
    'deploy.run': decide,
    'order.invoke': decide,
    'standing_order.propose': decide,
    'standing_order.activate': recommend,
    'standing_order.retire': recommend,
    'message.agent': decide,
    'notify.owner': decide,
    'memory.write': decide,
  },
  desk: {
    'question:*': 'decide',
    'alert:*': 'decide',
    'approval:*': 'recommend',
    'escalation:*': 'recommend',
    // Loops and parks: the CEO already has the context, so it releases them without asking (owner decision 22 Oct).
    'escalation:loop_parked': 'decide',
    'escalation:repeat_question': 'decide',
    'escalation:stop_loss': 'decide',
    'escalation:loop_backoff': 'decide',
    'question:stop_loss': 'decide',
    'question:repeat_question': 'decide',
    'alert:loop_backoff': 'decide',
    'alert:loop_parked': 'decide',
    'alert:manual_qa': 'recommend',
    'alert:outbound': 'recommend',
    'alert:large_merge': 'recommend',
    'alert:budget_paused': 'recommend',
    'alert:vault_conflict': 'recommend',
    'alert:repo_create': 'recommend',
    'alert:standing_order': 'recommend',
    'alert:ceo_recommendation': 'recommend',
    // The Owner's own buttons: a recipe waiting for his approval, a release waiting in the queue.
    'alert:recipe_approval': 'recommend',
    'alert:deploy_release': 'recommend',
    'question:manual_qa': 'recommend',
    'question:unmapped_ticket': 'recommend',
  },
  // Working-branch questions are routine; the CEO decides them (and each decision shows on the desk for review).
  delegated: ['working_branch'],
  minConfidence: 0.75,
  limits: DEFAULT_CEO_LIMITS,
};

export const clonePolicy = (p: CeoPolicy): CeoPolicy => JSON.parse(JSON.stringify(p)) as CeoPolicy;

/** The mode the policy gives a desk item (most specific key wins: `kind:subkind`, then `kind:*`). */
export function deskMode(policy: CeoPolicy, kind: string, subkind: string | null | undefined): CeoMode {
  if (subkind) {
    const exact = policy.desk[`${kind}:${subkind}`];
    if (exact) return exact;
  }
  return policy.desk[`${kind}:*`] ?? 'recommend';
}

/** The reserved key a desk item belongs to (so a delegation of that key lifts the reservation). */
export function reservedKeyOfDesk(kind: string, subkind: string | null | undefined): OwnerReservedKey | null {
  switch (subkind) {
    case 'manual_qa':
      return 'manual_qa';
    case 'large_merge':
    case 'finalize_failed':
      return 'finalize_merge';
    case 'outbound':
      return 'outbound';
    case 'budget_paused':
      return 'budget_paused';
    case 'definition':
      return 'definition_approval';
    case 'vault_conflict':
      return 'vault_conflict';
    case 'repo_create':
      return 'repo_create';
    case 'working_branch':
      return 'working_branch';
    case 'devops':
      return kind === 'approval' ? 'devops_destructive' : null;
    default:
      return null;
  }
}

/** Where the call comes from (docs/design/ceo-front-door.md section 6.2). The server derives it, never the runner or the model. */
export interface PolicyOrigin {
  kind: 'owner' | 'order' | 'wake';
  /** `order` turns: the owner-reserved keys the authorization covers. */
  covers?: readonly string[];
}

export interface PolicyInput {
  /** Absent: a wake. */
  origin?: PolicyOrigin | undefined;
  confidence: number;
  /** The wake that led to the action was triggered by outside text (card, mail, ticket, agent output). */
  untrustedOrigin?: boolean;
  /** The reserved key the subject belongs to (if any). */
  reservedKey?: OwnerReservedKey | null;
  /** The class demands cited evidence (desk answers) and the gateway found none that exists. */
  evidenceMissing?: boolean;
  /** Desk mode for the item the action is about (answers, triage). */
  deskMode?: CeoMode | undefined;
  /** A limit of the policy is reached (text for the reason). */
  limitReached?: string | undefined;
}

export interface PolicyVerdict {
  verdict: 'allow' | 'recommend' | 'deny';
  reason: string;
  cause?: 'mode' | 'reserved' | 'confidence' | 'evidence' | 'limit' | 'untrusted' | 'desk' | 'never';
  /** An owner turn: this recommendation is an inline confirmation card in the chat, answered by the Owner's session. */
  inline?: boolean;
}

/** Causes that an owner turn turns into an inline confirmation (the owner is in the conversation). */
const INLINE_CAUSES: ReadonlyArray<NonNullable<PolicyVerdict['cause']>> = [
  'mode',
  'reserved',
  'confidence',
  'desk',
];

const UNTRUSTED_RECOMMEND: readonly string[] = [
  'agent.hire',
  'agent.scale',
  'agent.change_model',
  'agent.change_seniority',
  'agent.allow_list',
  'standing_order.propose',
  'standing_order.activate',
  'standing_order.retire',
  'memory.write',
  'deploy.run',
  'order.invoke',
];

export function evaluatePolicy(policy: CeoPolicy, cls: string, input: PolicyInput): PolicyVerdict {
  const v = evaluateBase(policy, cls, input);
  if (
    input.origin?.kind === 'owner' &&
    v.verdict === 'recommend' &&
    v.cause &&
    INLINE_CAUSES.includes(v.cause)
  )
    return { ...v, inline: true };
  return v;
}

function evaluateBase(policy: CeoPolicy, cls: string, input: PolicyInput): PolicyVerdict {
  if (isHardNever(cls))
    return { verdict: 'deny', reason: `${cls} is never delegated to the CEO`, cause: 'never' };
  if (!(ACTION_CLASSES as readonly string[]).includes(cls))
    return { verdict: 'deny', reason: `unknown action class ${cls}`, cause: 'never' };
  const mode = policy.classes[cls]?.mode ?? 'recommend';
  if (mode === 'never')
    return { verdict: 'deny', reason: 'the owner set this action to never', cause: 'never' };
  if (input.deskMode === 'never')
    return { verdict: 'deny', reason: 'the owner set this kind of item to never', cause: 'never' };
  if (mode === 'recommend')
    return {
      verdict: 'recommend',
      reason: 'the policy gives this action as a recommendation',
      cause: 'mode',
    };
  if (input.deskMode === 'recommend')
    return {
      verdict: 'recommend',
      reason: 'the policy asks for a recommendation on this kind of item',
      cause: 'desk',
    };
  // An order turn may act on the owner-reserved keys its authorization covers (the owner ticked them when he marked it).
  const coveredByOrder =
    input.origin?.kind === 'order' &&
    !!input.reservedKey &&
    !!input.origin.covers?.includes(input.reservedKey);
  if (input.reservedKey && !coveredByOrder && !policy.delegated.includes(input.reservedKey))
    return {
      verdict: 'recommend',
      reason: `owner-reserved: ${OWNER_RESERVED_LABEL[input.reservedKey]}`,
      cause: 'reserved',
    };
  if (input.untrustedOrigin && UNTRUSTED_RECOMMEND.includes(cls))
    return {
      verdict: 'recommend',
      reason: 'triggered by outside text: recommended, not decided',
      cause: 'untrusted',
    };
  if (input.confidence < policy.minConfidence)
    return {
      verdict: 'recommend',
      reason: `confidence ${input.confidence.toFixed(2)} is below the threshold ${policy.minConfidence.toFixed(2)}`,
      cause: 'confidence',
    };
  if (input.evidenceMissing)
    return {
      verdict: 'recommend',
      reason: 'no cited ledger entry or owner rule backs this decision',
      cause: 'evidence',
    };
  if (input.limitReached)
    return { verdict: 'recommend', reason: `limit reached: ${input.limitReached}`, cause: 'limit' };
  return { verdict: 'allow', reason: 'within the CEO policy' };
}

/** Delegating an owner-reserved key needs the owner's confirmation; the policy editor calls this. */
export function withDelegation(policy: CeoPolicy, key: OwnerReservedKey, on: boolean): CeoPolicy {
  const next = clonePolicy(policy);
  const set = new Set(next.delegated);
  if (on) set.add(key);
  else set.delete(key);
  next.delegated = [...set];
  return next;
}
