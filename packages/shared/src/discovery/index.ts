import { z } from 'zod';
import { DocumentKindSchema, DocumentStatusSchema } from '../documents/index.ts';
import { ModelChoiceSchema } from '../models/choices.ts';
import { SessionTurnDtoSchema } from '../sessions/index.ts';

/**
 * Discovery Studio (docs/design/discovery-boardroom-registry.md, phase B): the facilitated session, its panel, its
 * questions and proposals. The server owns the state machine; the facilitator drives it with the `aom session ...` verbs.
 */

/** Runner capability: the runner lets a session turn call the `session.*` rpc methods (an older runner only talks). */
export const SESSION_VERBS_CAPABILITY = 'session-verbs:1';

export const DISCOVERY_STANCES = ['facilitator', 'partner', 'ideate_for_me'] as const;
export const DiscoveryStanceSchema = z.enum(DISCOVERY_STANCES);
export type DiscoveryStance = z.infer<typeof DiscoveryStanceSchema>;

export const DISCOVERY_PHASES = ['frame', 'diverge', 'converge', 'stress_test', 'capture'] as const;
export const DiscoveryPhaseSchema = z.enum(DISCOVERY_PHASES);
export type DiscoveryPhase = z.infer<typeof DiscoveryPhaseSchema>;

export const DISCOVERY_PHASE_LABEL: Record<DiscoveryPhase, string> = {
  frame: 'Frame',
  diverge: 'Diverge',
  converge: 'Converge',
  stress_test: 'Stress test',
  capture: 'Capture',
};

export const CEO_MODES = ['owner_only', 'joint', 'ceo_prep'] as const;
export const CeoModeSchema = z.enum(CEO_MODES);
export type DiscoveryCeoMode = z.infer<typeof CeoModeSchema>;

/** The playbooks a session can start from. */
export const DISCOVERY_PLAYBOOKS = ['brainstorm', 'advanced-elicitation', 'product-brief', 'prd'] as const;
export const DiscoveryPlaybookSchema = z.enum(DISCOVERY_PLAYBOOKS);
export type DiscoveryPlaybook = z.infer<typeof DiscoveryPlaybookSchema>;

export const PANEL_SECTIONS = ['ideas', 'assumptions', 'open_questions', 'decisions', 'parked'] as const;
export const PanelSectionSchema = z.enum(PANEL_SECTIONS);
export type PanelSection = z.infer<typeof PanelSectionSchema>;
export const PANEL_SECTION_LABEL: Record<PanelSection, string> = {
  ideas: 'Ideas',
  assumptions: 'Assumptions',
  open_questions: 'Open questions',
  decisions: 'Decisions',
  parked: 'Parked',
};

/** Most turns the CEO may take on its own in `ceo_prep` before the owner reviews. */
export const DISCOVERY_PREP_TURN_CAP = 12;
export const DISCOVERY_QUESTION_MAX_OPTIONS = 6;
/** Most characters of a PRD put in the BA's first message (the document stays linked in full). */
export const HANDOFF_NOTE_MAX_CHARS = 18_000;

/** The facilitation state kept in `threads.session_config` (merged key by key; `null` removes a key). */
export const DiscoveryConfigSchema = z.object({
  discovery: z.literal(true).default(true),
  stance: DiscoveryStanceSchema.default('facilitator'),
  phase: DiscoveryPhaseSchema.default('frame'),
  timeBoxMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .nullable()
    .default(null),
  ceoMode: CeoModeSchema.default('owner_only'),
  playbook: DiscoveryPlaybookSchema.default('brainstorm'),
  idea: z.string().max(4000).default(''),
  budgetUsd: z.number().positive().max(100_000).nullable().default(null),
  paused: z.boolean().default(false),
  /** The model the facilitator's turns run on (absent: the facilitator's own runtime and model). */
  model: ModelChoiceSchema.nullable().default(null),
  /** Active time before `activeSince` (a paused session keeps its clock). */
  elapsedMs: z.number().int().nonnegative().default(0),
  activeSince: z.iso.datetime().nullable().default(null),
  briefDocId: z.uuid().nullable().default(null),
  prdDocId: z.uuid().nullable().default(null),
  ceoPrep: z
    .object({
      state: z.enum(['running', 'review', 'done']),
      turns: z.number().int().nonnegative(),
      cap: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  /** Set when a turn was refused because the session budget is used up; cleared when the budget is raised. */
  budgetStopped: z.boolean().default(false),
  prdValidation: z
    .object({
      docId: z.uuid(),
      version: z.number().int(),
      summary: z.string(),
      at: z.iso.datetime(),
      items: z.array(
        z.object({ criterion: z.string(), status: z.enum(['pass', 'fail', 'n/a']), note: z.string() }),
      ),
    })
    .nullable()
    .default(null),
  /** An owner action that arrived while a turn was running or the session was paused; the next facilitator turn carries it. */
  pendingTrigger: z
    .object({ kind: z.string().max(30), detail: z.string().max(4000).optional() })
    .nullable()
    .default(null),
  /** The intake created by "Hand to BA". */
  intakeId: z.uuid().nullable().default(null),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/** The config of a session row, with defaults filled in. Never throws: a malformed key falls back to its default. */
export function parseDiscoveryConfig(raw: unknown): DiscoveryConfig {
  const r = DiscoveryConfigSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const k of Object.keys(DiscoveryConfigSchema.shape)) {
    const one = DiscoveryConfigSchema.shape[k as keyof typeof DiscoveryConfigSchema.shape].safeParse(o[k]);
    if (one.success) safe[k] = one.data;
  }
  return DiscoveryConfigSchema.parse(safe);
}

/** Active time of a session in ms at `now`. */
export function discoveryElapsedMs(c: Pick<DiscoveryConfig, 'elapsedMs' | 'activeSince'>, now: Date): number {
  return c.elapsedMs + (c.activeSince ? Math.max(0, now.getTime() - new Date(c.activeSince).getTime()) : 0);
}

export function discoveryProgress(
  c: Pick<DiscoveryConfig, 'elapsedMs' | 'activeSince' | 'timeBoxMinutes'>,
  now: Date,
): { elapsedMinutes: number; remainingMinutes: number | null; fraction: number | null } {
  const elapsed = discoveryElapsedMs(c, now);
  const elapsedMinutes = Math.floor(elapsed / 60_000);
  if (!c.timeBoxMinutes) return { elapsedMinutes, remainingMinutes: null, fraction: null };
  return {
    elapsedMinutes,
    remainingMinutes: Math.max(0, c.timeBoxMinutes - elapsedMinutes),
    fraction: Math.min(1, elapsed / (c.timeBoxMinutes * 60_000)),
  };
}

/** Phases from `from` onward are "ahead"; used for the stepper. */
export const phaseIndex = (p: DiscoveryPhase): number => DISCOVERY_PHASES.indexOf(p);

// ------------------------------------------------------------------------------------------------- questions

export const QuestionOptionSchema = z.object({
  id: z.string().min(1).max(20),
  label: z.string().min(1).max(300),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** `proposed`: the CEO answered in `ceo_prep` and the owner has not reviewed it yet. */
export const QUESTION_STATUSES = ['open', 'proposed', 'answered', 'skipped', 'parked', 'withdrawn'] as const;
export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const ANSWER_SOURCES = ['owner', 'ceo_confirmed', 'ceo_edited', 'owner_override'] as const;
export const AnswerSourceSchema = z.enum(ANSWER_SOURCES);
export type AnswerSource = z.infer<typeof AnswerSourceSchema>;

export const ProposedAnswerSchema = z.object({
  text: z.string(),
  optionId: z.string().nullable(),
  rationale: z.string().nullable(),
  byName: z.string(),
  mode: z.enum(['joint', 'ceo_prep']),
  at: z.iso.datetime(),
});
export type ProposedAnswer = z.infer<typeof ProposedAnswerSchema>;

export const QuestionDtoSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  seq: z.number().int(),
  question: z.string(),
  why: z.string().nullable(),
  options: z.array(QuestionOptionSchema),
  allowFreeText: z.boolean(),
  phase: z.string(),
  status: QuestionStatusSchema,
  askedByName: z.string(),
  answer: z
    .object({
      kind: z.enum(['pick', 'text', 'skip', 'park']),
      optionId: z.string().nullable(),
      text: z.string().nullable(),
      source: AnswerSourceSchema,
    })
    .nullable(),
  proposed: ProposedAnswerSchema.nullable(),
  askedAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),
});
export type QuestionDto = z.infer<typeof QuestionDtoSchema>;

export const AnswerQuestionRequestSchema = z.object({
  kind: z.enum(['pick', 'text', 'skip', 'park', 'confirm']),
  optionId: z.string().min(1).max(20).optional(),
  text: z.string().max(8000).optional(),
  /** With a CEO proposal: `confirm` the proposal as it is, `edit` it (text given) or answer something else (override). */
  edited: z.boolean().optional(),
});
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequestSchema>;

// ------------------------------------------------------------------------------------------------- panel notes

export const NoteDtoSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  section: PanelSectionSchema,
  text: z.string(),
  byKind: z.enum(['user', 'agent', 'persona', 'system']),
  byName: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NoteDto = z.infer<typeof NoteDtoSchema>;

export const AddNoteRequestSchema = z.object({
  section: PanelSectionSchema,
  text: z.string().min(1).max(2000),
});
export const PatchNoteRequestSchema = z
  .object({ section: PanelSectionSchema.optional(), text: z.string().min(1).max(2000).optional() })
  .refine((v) => v.section !== undefined || v.text !== undefined, 'nothing to change');

// ------------------------------------------------------------------------------------------------- proposals

export const PROPOSAL_STATUSES = ['open', 'applied', 'rejected', 'redirected'] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);

export const DiscoveryProposalDtoSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  seq: z.number().int(),
  title: z.string(),
  change: z.string(),
  rationale: z.string(),
  docId: z.uuid().nullable(),
  section: z.string().nullable(),
  status: ProposalStatusSchema,
  resolutionText: z.string().nullable(),
  askedByName: z.string(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type DiscoveryProposalDto = z.infer<typeof DiscoveryProposalDtoSchema>;

export const ResolveDiscoveryProposalRequestSchema = z.object({
  resolution: z.enum(['apply', 'reject', 'redirect']),
  /** Redirect: what the owner wants instead (sent to the facilitator). */
  text: z.string().max(4000).optional(),
});
export type ResolveDiscoveryProposalRequest = z.infer<typeof ResolveDiscoveryProposalRequestSchema>;

// ------------------------------------------------------------------------------------------------- the session

export const CreateDiscoveryRequestSchema = z.object({
  title: z.string().min(1).max(200),
  projectId: z.uuid().optional(),
  stance: DiscoveryStanceSchema.default('facilitator'),
  ceoMode: CeoModeSchema.default('owner_only'),
  timeBoxMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
  playbook: DiscoveryPlaybookSchema.default('brainstorm'),
  idea: z.string().max(4000).default(''),
  budgetUsd: z.number().positive().max(100_000).optional(),
  workstationId: z.uuid().optional(),
  /** The facilitator's model (any runtime the workstation offers, a direct provider included); absent: the facilitator's own. */
  model: ModelChoiceSchema.optional(),
});
export type CreateDiscoveryRequest = z.infer<typeof CreateDiscoveryRequestSchema>;

export const PatchDiscoveryRequestSchema = z.object({
  /** `null` removes the limit. */
  budgetUsd: z.number().positive().max(100_000).nullable().optional(),
  timeBoxMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .nullable()
    .optional(),
  stance: DiscoveryStanceSchema.optional(),
  /** `null` goes back to the facilitator's own model. */
  model: ModelChoiceSchema.nullable().optional(),
});
export type PatchDiscoveryRequest = z.infer<typeof PatchDiscoveryRequestSchema>;

export const SetPhaseRequestSchema = z.object({ phase: DiscoveryPhaseSchema });
export const DiscoveryParamsSchema = z.object({ id: z.uuid() });
export const DiscoveryQuestionParamsSchema = z.object({ id: z.uuid(), questionId: z.uuid() });
export const DiscoveryNoteParamsSchema = z.object({ id: z.uuid(), noteId: z.uuid() });
export const DiscoveryProposalParamsSchema = z.object({ id: z.uuid(), proposalId: z.uuid() });
export const SayRequestSchema = z.object({ body: z.string().min(1).max(8000) });

export const SessionCostSchema = z.object({
  costMicros: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  budgetUsd: z.number().nullable(),
  exceeded: z.boolean(),
});
export type SessionCost = z.infer<typeof SessionCostSchema>;

export const DiscoveryDocSchema = z.object({
  id: z.uuid(),
  kind: DocumentKindSchema,
  title: z.string(),
  status: DocumentStatusSchema,
  currentVersion: z.number().int(),
});
export type DiscoveryDoc = z.infer<typeof DiscoveryDocSchema>;

/** Everything the session page needs besides the messages. */
export const DiscoveryStateDtoSchema = z.object({
  threadId: z.uuid(),
  title: z.string(),
  projectId: z.uuid().nullable(),
  config: z.object({
    stance: DiscoveryStanceSchema,
    phase: DiscoveryPhaseSchema,
    ceoMode: CeoModeSchema,
    playbook: DiscoveryPlaybookSchema,
    idea: z.string(),
    timeBoxMinutes: z.number().nullable(),
    paused: z.boolean(),
    /** The facilitator's chosen model (null: its own). */
    model: ModelChoiceSchema.nullable(),
    budgetStopped: z.boolean(),
    ceoPrep: z
      .object({ state: z.enum(['running', 'review', 'done']), turns: z.number(), cap: z.number() })
      .nullable(),
    intakeId: z.uuid().nullable(),
    prdValidation: DiscoveryConfigSchema.shape.prdValidation,
  }),
  progress: z.object({
    elapsedMinutes: z.number(),
    remainingMinutes: z.number().nullable(),
    fraction: z.number().nullable(),
  }),
  cost: SessionCostSchema,
  /** Whether the organization has a CEO that can take part. */
  ceoAvailable: z.boolean(),
  facilitatorName: z.string(),
  ceoName: z.string().nullable(),
  workstationOnline: z.boolean(),
  questions: z.array(QuestionDtoSchema),
  notes: z.array(NoteDtoSchema),
  proposals: z.array(DiscoveryProposalDtoSchema),
  documents: z.array(DiscoveryDocSchema),
  turns: z.array(SessionTurnDtoSchema),
  /** True while a facilitator or CEO turn is queued or running. */
  busy: z.boolean(),
  /** What the owner must do next, for the banner. */
  waitingFor: z.enum(['owner', 'ceo', 'facilitator', 'review', 'paused', 'budget', 'nothing']),
  createdAt: z.iso.datetime(),
});
export type DiscoveryStateDto = z.infer<typeof DiscoveryStateDtoSchema>;

// ------------------------------------------------------------------------------------------------- aom session verbs

export const SESSION_RPC_METHODS = [
  'session.show',
  'session.ask',
  'session.answer',
  'session.note',
  'session.propose',
  'session.phase',
  'session.draft',
  'session.validate',
] as const;
export type SessionRpcMethod = (typeof SESSION_RPC_METHODS)[number];
export const isSessionRpc = (m: string): m is SessionRpcMethod =>
  (SESSION_RPC_METHODS as readonly string[]).includes(m);

export const SessionAskParamsSchema = z.object({
  question: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(300)).max(DISCOVERY_QUESTION_MAX_OPTIONS).default([]),
  allowFreeText: z.boolean().default(true),
  why: z.string().max(600).optional(),
});
export const SessionAnswerParamsSchema = z.object({
  /** Option id (`o1`, `o2`, ...) of the open question. */
  option: z.string().max(20).optional(),
  text: z.string().max(4000).optional(),
  why: z.string().max(1000).optional(),
});
export const SessionNoteParamsSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), section: PanelSectionSchema, text: z.string().min(1).max(2000) }),
  z.object({
    op: z.literal('update'),
    id: z.string().min(4).max(40),
    text: z.string().min(1).max(2000).optional(),
    section: PanelSectionSchema.optional(),
  }),
  z.object({ op: z.literal('remove'), id: z.string().min(4).max(40) }),
]);
export const SessionProposeParamsSchema = z.object({
  title: z.string().min(1).max(200),
  change: z.string().min(1).max(8000),
  rationale: z.string().min(1).max(2000),
  doc: z.uuid().optional(),
  section: z.string().min(1).max(200).optional(),
});
export const SessionPhaseParamsSchema = z.object({
  to: DiscoveryPhaseSchema,
  reason: z.string().max(400).optional(),
});
export const SessionDraftParamsSchema = z.object({
  kind: z.enum(['brief', 'prd']),
  content: z.string().min(1).max(200_000),
  title: z.string().min(1).max(200).optional(),
  note: z.string().max(500).optional(),
});
export const SessionValidateParamsSchema = z.object({
  summary: z.string().max(2000).default(''),
  /** Each `<criterion>|pass|fail|n/a|<note>`. */
  items: z.array(z.string().min(1).max(600)).min(1).max(80),
});

/** Parses `criterion|status|note` (the `aom session validate --check` form). Null when malformed. */
export function parseCheckItem(
  s: string,
): { criterion: string; status: 'pass' | 'fail' | 'n/a'; note: string } | null {
  const parts = s.split('|').map((x) => x.trim());
  const status = parts[1]?.toLowerCase();
  if (!parts[0] || (status !== 'pass' && status !== 'fail' && status !== 'n/a')) return null;
  return { criterion: parts[0], status, note: parts.slice(2).join('|') };
}

/** Short id shown to the facilitator for a note (`aom session note update <id>`): the first 8 characters of the uuid. */
export const shortId = (id: string): string => id.slice(0, 8);
