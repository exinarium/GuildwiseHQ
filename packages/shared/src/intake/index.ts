import { z } from 'zod';
import { CardType, RiskTier, StoredCompletionAction, StoredFinalizeAction } from '../cards/types.ts';
import { ExternalSystem } from '../events/intake.ts';

/**
 * M7 contract shared by the server, the runner and the web: BA intake, the escalation chain and BA finalize
 * (docs/ARCHITECTURE.md sections 14, 15, 16.5; docs/PLAN.md M7).
 */

/** Desk `subkind` of the mapping question an unmapped ticket becomes. */
export const UNMAPPED_TICKET_SUBKIND = 'unmapped_ticket';

/** The role that answers and finalizes: one identity, two queues (interactive intake, background finalize). */
export const BA_ROLE_KEY = 'ba';

/**
 * Data of the `finalized` outcome (`aom finalize`): empty. The action that runs is the card's own completion action; an agent never chooses
 * it (the server refuses `pr` and `merge` here). `none` (no git step) is only accepted for investigation-only cards
 * whose report lives in the vault, and the server derives it.
 */
export const FinalizeReportDataSchema = z.object({ action: StoredFinalizeAction.optional() });
export type FinalizeReportData = z.infer<typeof FinalizeReportDataSchema>;

// ------------------------------------------------------------------- card drafting (chat-scoped RPCs)

/** The card fields the BA fills in (the code field set); everything else a workflow may carry stays free-form. */
export const CardDraftFieldsSchema = z
  .object({
    context: z.string().optional(),
    requirements: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    affectedAreas: z.string().optional(),
    constraints: z.string().optional(),
    testPlan: z.string().optional(),
    externalRef: z.string().optional(),
  })
  .catchall(z.unknown());

/** `aom card create --file draft.json`. */
export const CardDraftSchema = z.object({
  /** Project key. Defaults to the project the intake is mapped to. */
  project: z.string().optional(),
  title: z.string().min(1).max(300),
  cardType: CardType.default('feature'),
  /** One of the project's enabled workflows; absent: the project's default for the card type. */
  workflowKey: z.string().min(1).optional(),
  /** Agents may not set it (the server refuses a draft that names it); kept in the schema so the refusal can teach. */
  completionAction: StoredCompletionAction.optional(),
  docsNeeded: z.boolean().optional(),
  /** Run Investigate & design (architect) before build; absent: the project's setting. */
  designNeeded: z.boolean().optional(),
  /** An investigation-only card (comparison, spike): no build, the report is the result. */
  investigationOnly: z.boolean().optional(),
  /** Merge the latest main branch first: only set to false for a reason (e.g. a hotfix on the working branch). */
  mergeMainFirst: z.boolean().nullable().optional(),
  priority: z.number().int().min(1).max(9).optional(),
  riskTier: RiskTier.optional(),
  /** Repository name or id; optional when the project has exactly one. */
  repo: z.string().optional(),
  /** Card refs (`TOY-3`) this card depends on. */
  dependencies: z.array(z.string()).optional(),
  /** A phase of the project (`WEB-P2`, or its name): the card is proposed for it; the manager confirms. */
  phase: z.string().max(200).optional(),
  /** The ticket key; copied into `fields.externalRef`. */
  externalRef: z.string().optional(),
  fields: CardDraftFieldsSchema.default({}),
});
export type CardDraft = z.infer<typeof CardDraftSchema>;

/** `aom card update <ref> --file patch.json`: any subset of a draft. */
export const CardDraftPatchSchema = CardDraftSchema.omit({ workflowKey: true }).partial().extend({
  fields: CardDraftFieldsSchema.optional(),
});
export type CardDraftPatch = z.infer<typeof CardDraftPatchSchema>;

export const IntakeMapParamsSchema = z.object({ project: z.string().min(1) });
export const IntakeUnmappedParamsSchema = z.object({
  /** Why the ticket does not map to a project (shown to the manager). */
  note: z.string().min(1).max(5000),
});

// ------------------------------------------------------------------------- chat context of an intake

export const IntakeProjectSchema = z.object({
  key: z.string(),
  name: z.string(),
  repos: z.array(z.string()).default([]),
});

/** What the BA's intake chat knows (server -> runner `chat.start` context; rendered into the instructions). */
export const IntakeContextSchema = z.object({
  intakeId: z.uuid(),
  externalSystem: ExternalSystem.optional(),
  externalKey: z.string().optional(),
  /** Project key once mapped. */
  mappedProjectKey: z.string().optional(),
  /** The organization vault: its `skills/jira.md` (if any) replaces the built-in Jira skill text. */
  orgVaultId: z.string().optional(),
  /** The intake was started lazily from a desk chat (no ticket): the chat keeps its normal instructions. */
  fromChat: z.boolean().optional(),
  projects: z.array(IntakeProjectSchema),
  cards: z.array(z.object({ ref: z.string(), title: z.string(), status: z.string() })).default([]),
});
export type IntakeContext = z.infer<typeof IntakeContextSchema>;

// -------------------------------------------------------------------------- question shifts (section 15)

/** One step of the escalation trail of a desk item. */
export const EscalationStepSchema = z.object({
  at: z.iso.datetime(),
  /** `asked` is the agent's question; `answered` closes the trail; `merged` marks a duplicate attached to an open question. */
  step: z.enum(['asked', 'peer', 'ba', 'desk', 'answered', 'merged']),
  agentId: z.uuid().optional(),
  agentName: z.string().optional(),
  role: z.string().optional(),
  note: z.string().optional(),
});
export type EscalationStep = z.infer<typeof EscalationStepSchema>;

/** The question a `question` shift answers or escalates (`shift.start.question`). */
export const QuestionShiftSchema = z.object({
  deskItemId: z.uuid(),
  level: z.enum(['peer', 'ba']),
  text: z.string(),
  doing: z.string().default(''),
  options: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  recommendation: z.string().optional(),
  blocking: z.boolean(),
  askedBy: z.object({ name: z.string(), role: z.string().optional() }),
  /** Who has already looked at it (names), oldest first. */
  trail: z.array(z.string()).default([]),
  ledgerMatches: z
    .array(
      z.object({
        id: z.string(),
        scope: z.enum(['feature', 'decision', 'standing_order']),
        title: z.string(),
        body: z.string(),
      }),
    )
    .default([]),
});
export type QuestionShift = z.infer<typeof QuestionShiftSchema>;

/** `aom answer --item <id> --text ...`. */
export const AnswerReportSchema = z.object({
  kind: z.literal('answer'),
  itemId: z.uuid(),
  text: z.string().min(1).max(20000),
  /** One of the item's option ids (`o1`, ...), when the answer picks an option. */
  optionId: z.string().min(1).optional(),
});
/** `aom escalate --item <id> --note ...`. */
export const EscalateReportSchema = z.object({
  kind: z.literal('escalate'),
  itemId: z.uuid(),
  note: z.string().min(1).max(20000),
});
export * from './batch.ts';
