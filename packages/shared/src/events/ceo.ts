import { z } from 'zod';
import { CeoPolicySchema } from '../ceo/policy.ts';
import { FixCardSchema } from '../ceo/review.ts';
import { CeoSettingsSchema, CeoTrainingSchema, NotifyKind, RecommendationResponse } from '../ceo/settings.ts';
import { CeoPermissionDecision, CeoTurnMode, RepeatSuggestion, ToolCountsSchema } from '../ceo/turns.ts';
import { ModelChoiceSchema } from '../models/choices.ts';
import { defineEvent, Id, IsoDate } from './define.ts';

/**
 * The CEO agent (docs/design/ceo-agent-v2.md section 9). Streams `ceo-<orgId>` (settings, policy, actions, tasks,
 * memories) and `ceo-task-<id>`; audience `org`. Memory TEXT never travels in an event (an append-only store could not
 * forget it): the events carry ids, kind, scope and a hash; the text lives in an operational table.
 */

export const CeoActionMode = z.enum(['decided', 'recommended', 'refused']);
export type CeoActionMode = z.infer<typeof CeoActionMode>;

/** How to take an action back. `kind: 'compensating'` is labelled as such in the activity log. */
export const CeoInverseSchema = z.object({
  kind: z.enum(['inverse', 'compensating']),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  /** What must still be true for the undo to run (checked by the server): `{ field: expectedValue }`. */
  preconditions: z.record(z.string(), z.unknown()).default({}),
  label: z.string().max(200).default(''),
});
export type CeoInverse = z.infer<typeof CeoInverseSchema>;

export const CeoTaskStatus = z.enum([
  'open',
  'in_progress',
  'waiting_owner',
  'waiting_work',
  'done',
  'failed',
  'cancelled',
]);
export type CeoTaskStatus = z.infer<typeof CeoTaskStatus>;

export const CeoTaskWatch = z.object({
  kind: z.enum(['card', 'devops', 'desk', 'agent']),
  id: z.string().min(1),
});

export const CeoMemoryKind = z.enum(['rule', 'preference', 'decision_pattern', 'fact', 'correction']);
export type CeoMemoryKind = z.infer<typeof CeoMemoryKind>;
export const CeoMemoryStatus = z.enum(['active', 'candidate', 'retired']);
export type CeoMemoryStatus = z.infer<typeof CeoMemoryStatus>;
export const CeoMemorySource = z.enum([
  'owner_statement',
  'owner_desk_answer',
  'owner_override',
  'owner_undo',
  'owner_edit',
  'owner_training',
  /** "You did X, I'd rather Y" (front door, section 7). */
  'owner_correction',
]);
export type CeoMemorySource = z.infer<typeof CeoMemorySource>;

export const ceoEvents = [
  /** The built-in CEO of the organization was created: its settings and default policy (older events also start a training period). */
  defineEvent(
    'CeoEnabled',
    z.object({
      orgId: Id,
      agentId: Id,
      by: Id,
      policy: CeoPolicySchema,
      settings: CeoSettingsSchema,
      /** Built-in CEOs have no training period: absent means graduated. Older events carry it and replay unchanged. */
      training: CeoTrainingSchema.optional(),
    }),
  ),
  /** The CEO was disabled (the agent is retired; a new one can be hired). */
  defineEvent('CeoDisabled', z.object({ orgId: Id, agentId: Id, by: Id })),
  defineEvent('CeoPaused', z.object({ orgId: Id, by: Id, reason: z.string().max(500).optional() })),
  defineEvent('CeoResumed', z.object({ orgId: Id, by: Id })),
  defineEvent(
    'CeoPolicyChanged',
    z.object({
      orgId: Id,
      version: z.number().int().min(1),
      previousVersion: z.number().int().min(0),
      policy: CeoPolicySchema,
      by: Id,
      note: z.string().max(500).optional(),
    }),
  ),
  defineEvent('CeoSettingsChanged', z.object({ orgId: Id, settings: CeoSettingsSchema, by: Id })),
  /** Graduate (training off), extend or restart the training period. */
  defineEvent(
    'CeoTrainingChanged',
    z.object({
      orgId: Id,
      action: z.enum(['graduate', 'extend', 'restart']),
      training: CeoTrainingSchema,
      by: Id,
      /** Why (the built-in CEO migration graduates every CEO: "built-in CEO, no training"). */
      reason: z.string().max(200).optional(),
      /** Agreement scores at that moment, shown in the confirmation (class, agreed, total). */
      scores: z
        .array(z.object({ class: z.string(), agreed: z.number().int(), total: z.number().int() }))
        .default([]),
    }),
  ),
  /** The standing chat thread of the owner with the CEO. */
  defineEvent('CeoChatLinked', z.object({ orgId: Id, threadId: Id })),
  /** One audited management action: decided, recommended or refused. */
  defineEvent(
    'CeoActionTaken',
    z.object({
      actionId: Id,
      orgId: Id,
      /** Policy class, e.g. `card.release`. */
      class: z.string().min(1),
      /** The CLI action name, e.g. `release`. */
      action: z.string().min(1),
      mode: CeoActionMode,
      subjectKind: z.string().max(40).default(''),
      subjectId: z.string().max(100).default(''),
      subjectLabel: z.string().max(300).default(''),
      params: z.record(z.string(), z.unknown()).default({}),
      reason: z.string().max(2000),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string()).default([]),
      policyVersion: z.number().int().min(0),
      /** Why the policy gave this mode (the audit shows it). */
      verdictReason: z.string().max(500).default(''),
      cause: z.string().max(40).optional(),
      wakeBatchId: Id.optional(),
      chatThreadId: Id.optional(),
      /** The owner pressed Accept on a recommendation of the CEO: the action ran with the owner's say-so. */
      acceptedFrom: Id.optional(),
      /** Set when the call came from an `order` turn: the Owner-authorized standing order (and its pinned wording) it enforced. */
      order: z.object({ entryId: Id, versionHash: z.string().length(64) }).optional(),
      /** Set when the call came from an owner turn (the CEO chat turn the owner started). */
      turnId: Id.optional(),
      origin: z
        .object({ untrusted: z.boolean().default(false), eventIds: z.array(z.string()).default([]) })
        .default({
          untrusted: false,
          eventIds: [],
        }),
      inverse: CeoInverseSchema.optional(),
      idemKey: z.string().min(1).max(200),
      result: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  /** A recommendation put in front of the owner (a desk item, or a block on an existing item). */
  defineEvent(
    'CeoRecommendationMade',
    z.object({
      actionId: Id,
      orgId: Id,
      class: z.string(),
      deskItemId: Id.optional(),
      /** Existing desk item the recommendation sits on (answers), or the new item the recommendation created. */
      onExistingItem: z.boolean().default(false),
      option: z.string().max(40).optional(),
      text: z.string().max(4000).optional(),
      reason: z.string().max(2000),
      confidence: z.number().min(0).max(1),
      action: z.string().max(40).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  /** What the owner did with a recommendation: the training observation. */
  defineEvent(
    'CeoRecommendationResponded',
    z.object({
      actionId: Id,
      orgId: Id,
      class: z.string(),
      response: RecommendationResponse,
      /** The owner's own words or the option they chose instead. */
      note: z.string().max(4000).optional(),
      ownerChoice: z.string().max(200).optional(),
      deskItemId: Id.optional(),
      by: Id,
    }),
  ),
  defineEvent(
    'CeoActionUndone',
    z.object({
      actionId: Id,
      orgId: Id,
      by: Id,
      kind: z.enum(['inverse', 'compensating']),
      note: z.string().max(1000).optional(),
    }),
  ),
  defineEvent(
    'CeoTaskCreated',
    z.object({
      taskId: Id,
      orgId: Id,
      title: z.string().min(1).max(300),
      request: z.string().max(4000).default(''),
      threadId: Id.optional(),
      due: IsoDate.optional(),
      watch: z.array(CeoTaskWatch).default([]),
      by: z.enum(['ceo', 'owner']),
      byUserId: Id.optional(),
    }),
  ),
  defineEvent(
    'CeoTaskUpdated',
    z.object({
      taskId: Id,
      orgId: Id,
      status: CeoTaskStatus.optional(),
      title: z.string().min(1).max(300).optional(),
      note: z.string().max(4000).optional(),
      watch: z.array(CeoTaskWatch).optional(),
      due: IsoDate.nullable().optional(),
      by: z.enum(['ceo', 'owner', 'system']),
    }),
  ),
  defineEvent(
    'CeoMemoryAdded',
    z.object({
      memoryId: Id,
      orgId: Id,
      kind: CeoMemoryKind,
      scope: z.string().max(100).default('org'),
      source: CeoMemorySource,
      sourceRef: z.string().max(200).default(''),
      confidence: z.number().min(0).max(1),
      status: CeoMemoryStatus,
      /** SHA-256 of the text (the text itself is operational data). */
      textHash: z.string().length(64),
      /** The class the pattern is about (decision patterns). */
      class: z.string().max(60).optional(),
      by: Id.optional(),
    }),
  ),
  defineEvent(
    'CeoMemoryConfirmed',
    z.object({ memoryId: Id, orgId: Id, by: Id, status: CeoMemoryStatus.default('active') }),
  ),
  defineEvent(
    'CeoMemoryEdited',
    z.object({
      memoryId: Id,
      orgId: Id,
      textHash: z.string().length(64),
      scope: z.string().max(100).optional(),
      by: Id,
    }),
  ),
  defineEvent(
    'CeoMemoryRetired',
    z.object({ memoryId: Id, orgId: Id, by: Id.optional(), reason: z.string().max(200).default('') }),
  ),
  /** Cited by a decision (confidence adjusts) or observed again. */
  defineEvent(
    'CeoMemoryAdjusted',
    z.object({
      memoryId: Id,
      orgId: Id,
      confidence: z.number().min(0).max(1),
      observations: z.number().int().min(0).optional(),
      reason: z.string().max(200).default(''),
    }),
  ),
  /** The memory is erased: the projection row stays as a tombstone id, the text is deleted from the operational table. */
  defineEvent('CeoMemoryForgotten', z.object({ memoryId: Id, orgId: Id, by: Id })),
  /**
   * The owner reviewed a decision of the CEO on the desk: acknowledged it (positive feedback) or corrected it. A correction
   * starts the CEO-BA review (`reviewId`); the owner's words are kept as an owner-confirmed memory (`memoryId`).
   */
  defineEvent(
    'CeoDecisionReviewed',
    z.object({
      orgId: Id,
      deskItemId: Id,
      actionId: Id.optional(),
      outcome: z.enum(['acknowledged', 'corrected']),
      by: Id,
      correction: z.string().max(4000).optional(),
      applyNow: z.boolean().optional(),
      applied: z.string().max(500).optional(),
      reviewId: Id.optional(),
      memoryId: Id.optional(),
      /** Acknowledge all: how many were closed in the same append. */
      batch: z.boolean().optional(),
    }),
  ),
  /** The BA's short analysis of a corrected decision: why the instinct was wrong, the missed signal, a proposed rule. */
  defineEvent(
    'CeoCorrectionAnalysed',
    z.object({
      orgId: Id,
      deskItemId: Id,
      reviewId: Id,
      analysis: z.string().max(8000),
      proposedRule: z.string().max(1000).optional(),
      baAgentId: Id.optional(),
      fallback: z.boolean().optional(),
      /** The fix cards the BA proposes (not created yet), or why no fix work is needed. */
      proposedCards: z.array(FixCardSchema).max(8).optional(),
      noFixReason: z.string().max(1000).optional(),
      consequences: z.string().max(4000).optional(),
    }),
  ),
  /** The lesson the CEO recorded after the review: a memory linked to the correction, replacing what led to the mistake. */
  defineEvent(
    'CeoLessonRecorded',
    z.object({
      orgId: Id,
      deskItemId: Id,
      reviewId: Id,
      memoryId: Id,
      lesson: z.string().max(1000),
      retiredMemoryIds: z.array(Id).default([]),
      recordedBy: z.enum(['ceo', 'server']),
      /** The CEO's reply in the discussion (absent when the server recorded the lesson without the CEO). */
      stance: z.enum(['agree', 'disagree']).optional(),
      reflection: z.string().max(2000).optional(),
      cardChanges: z.string().max(2000).optional(),
      /** The CEO did not reply in time (or is gone): the lesson was recorded without it. */
      withoutCeo: z.boolean().optional(),
      /** The BA's final turn follows (and ends with `CeoReviewConcluded`); absent: the review ends with the lesson. */
      finalTurn: z.boolean().optional(),
    }),
  ),
  /** The discussion ended: the BA's final turn (or the server in its place) created the fix cards, or none were needed. */
  defineEvent(
    'CeoReviewConcluded',
    z.object({
      orgId: Id,
      deskItemId: Id,
      reviewId: Id,
      summary: z.string().max(4000),
      cards: z
        .array(z.object({ cardId: Id, ref: z.string(), title: z.string().max(300), projectKey: z.string() }))
        .default([]),
      /** Proposed cards that could not be created, with the reason. */
      skipped: z.array(z.string().max(500)).default([]),
      baAgentId: Id.optional(),
      /** No BA took the final turn: the server concluded on its own. */
      fallback: z.boolean().optional(),
    }),
  ),
  /** A CEO shift (a wake batch or the daily review) was handed to the CEO's workstation. */
  defineEvent(
    'CeoShiftDispatched',
    z.object({
      orgId: Id,
      batchId: Id,
      shiftId: Id,
      agentId: Id,
      workstationId: Id,
      purpose: z.enum(['wake', 'review']),
      wakeCount: z.number().int().min(0),
    }),
  ),
  defineEvent(
    'CeoNotified',
    z.object({
      notificationId: Id,
      orgId: Id,
      kind: NotifyKind,
      title: z.string().max(200),
      text: z.string().max(4000),
      taskId: Id.optional(),
      deskItemId: Id.optional(),
      channels: z.object({ desk: z.boolean(), email: z.boolean(), automation: z.boolean() }),
    }),
  ),
  defineEvent(
    'CeoReportPosted',
    z.object({
      orgId: Id,
      localDate: z.string(),
      deskItemId: Id,
      /** True when the server wrote it from a template because the CEO was not available. */
      fallback: z.boolean().default(false),
      batchId: Id.optional(),
    }),
  ),
  /** An answered question was taken back: it is open again and its cards wait again. */
  defineEvent(
    'QuestionReopened',
    z.object({
      deskItemId: Id,
      by: z.object({ kind: z.enum(['user', 'agent', 'system']), id: Id.optional() }),
      note: z.string().max(1000).optional(),
      blockedCardIds: z.array(Id).default([]),
    }),
  ),
  // ---------------------------------------------------------------------------- front door, step 1 (full-power turns)
  /** An owner or order turn was accepted for a CEO thread (persisted before it is sent; a queued one waits for the workstation). */
  defineEvent(
    'CeoTurnQueued',
    z.object({
      turnId: Id,
      orgId: Id,
      threadId: Id,
      /** The user message that started it (an order turn has none). */
      messageId: Id.optional(),
      mode: CeoTurnMode,
      model: ModelChoiceSchema,
      workstationId: Id.optional(),
      /** The workstation was offline: the message waits (`data.queued` on the message). */
      queued: z.boolean().default(false),
      orderEntryId: Id.optional(),
      orderVersionHash: z.string().length(64).optional(),
    }),
  ),
  defineEvent(
    'CeoTurnStarted',
    z.object({ turnId: Id, orgId: Id, threadId: Id, workstationId: Id, model: ModelChoiceSchema }),
  ),
  defineEvent(
    'CeoTurnFinished',
    z.object({
      turnId: Id,
      orgId: Id,
      threadId: Id,
      status: z.enum(['done', 'failed', 'dropped']),
      error: z.string().max(500).optional(),
      /** The runner ran the turn in the restricted profile (`full_power_off`). */
      degraded: z.string().max(40).optional(),
      toolCounts: ToolCountsSchema.optional(),
      model: ModelChoiceSchema.optional(),
    }),
  ),
  /** The owner's model choice for the whole conversation (null: back to the default). */
  defineEvent('ChatThreadModelSet', z.object({ threadId: Id, choice: ModelChoiceSchema.nullable(), by: Id })),
  /** Extra working directories of a CEO conversation (`aom ceo dir add`); persisted on the thread. */
  defineEvent(
    'ChatThreadDirsSet',
    z.object({ threadId: Id, dirs: z.array(z.string().max(500)).max(20), by: Id }),
  ),
  /** A job the CEO did itself instead of through the board (the off-system job log). */
  defineEvent(
    'CeoOffboardJobLogged',
    z.object({
      jobId: Id,
      orgId: Id,
      turnId: Id.optional(),
      kind: z.string().min(1).max(60),
      title: z.string().min(1).max(200),
      summary: z.string().max(2000).default(''),
      projectId: Id.optional(),
      costMicros: z.number().int().min(0).default(0),
      durationMs: z.number().int().min(0).default(0),
      /** The server logged it (the CEO used tools, made no board object and logged nothing). */
      auto: z.boolean().default(false),
      /** The first word of the shell commands the turn ran, for the repeat rule (automation). */
      firstToken: z.string().max(60).optional(),
    }),
  ),
  /** The same kind of job came back often enough (4+ in 7 days or 10+ in 30): propose a feature, skill or automation. */
  defineEvent(
    'CeoRepeatDetected',
    z.object({
      repeatId: Id,
      orgId: Id,
      key: z.string().min(1).max(60),
      jobIds: z.array(Id).min(1).max(100),
      suggestion: RepeatSuggestion,
      count7: z.number().int().min(0),
      count30: z.number().int().min(0),
      projectId: Id.optional(),
    }),
  ),
  defineEvent(
    'CeoRepeatResolved',
    z.object({
      repeatId: Id,
      orgId: Id,
      decision: z.enum(['dismissed', 'feature', 'skill', 'automation']),
      by: Id,
    }),
  ),
  /**
   * The owner corrected something the CEO did ("you did X, I'd rather Y"). The same append writes the active `correction`
   * memory (`CeoMemoryAdded`) and lowers the cited memories (`CeoMemoryAdjusted`).
   */
  defineEvent(
    'CeoCorrected',
    z.object({
      correctionId: Id,
      orgId: Id,
      by: Id,
      actionId: Id.optional(),
      orderTurnId: Id.optional(),
      chatMessageId: Id.optional(),
      deskItemId: Id.optional(),
      /** The owner's words, verbatim. */
      text: z.string().max(4000),
      /** The general rule (editable). */
      rule: z.string().max(1000),
      /** The active `correction` memory written in the same append (absent: the owner unticked "make it a rule"). */
      memoryId: Id.optional(),
      remedy: z.enum(['none', 'undo', 'redo']).default('none'),
      redo: z.object({ action: z.string().min(1), params: z.record(z.string(), z.unknown()) }).optional(),
      /** The class of the corrected action, when there is one. */
      class: z.string().max(60).optional(),
    }),
  ),
  /** The correction's rule was edited in the chat card ("Edit"). */
  defineEvent(
    'CeoCorrectionEdited',
    z.object({ correctionId: Id, orgId: Id, rule: z.string().max(1000), by: Id }),
  ),
  /** The runtime needed a permission it lacks: "authorize this execution" is a question on the desk. */
  defineEvent(
    'CeoPermissionAsked',
    z.object({
      askId: Id,
      orgId: Id,
      turnId: Id,
      threadId: Id.optional(),
      mode: CeoTurnMode,
      tool: z.string().max(200),
      /** The tool input, redacted by the runner. */
      input: z.string().max(4000).default(''),
      reason: z.string().max(1000).default(''),
      deskItemId: Id,
    }),
  ),
  defineEvent(
    'CeoPermissionAnswered',
    z.object({
      askId: Id,
      orgId: Id,
      turnId: Id,
      tool: z.string().max(200),
      decision: CeoPermissionDecision,
      /** The Owner or Admin who pressed the button; absent for a timeout or a turn that ended. */
      by: Id.optional(),
    }),
  ),
  /** `aom runner restart`: a restart was scheduled for after the reply. */
  defineEvent(
    'RunnerRestartRequested',
    z.object({
      workstationId: Id,
      orgId: Id.optional(),
      by: z.string().max(100),
      reason: z.string().max(500).optional(),
    }),
  ),
  /** The Owner marked one of his standing orders "the CEO enforces this with full power", pinned to its wording. */
  defineEvent(
    'StandingOrderAuthorized',
    z.object({
      entryId: Id,
      orgId: Id,
      versionHash: z.string().length(64),
      by: Id,
      scope: z.object({
        projectIds: z.array(Id).nullable().default(null),
        triggers: z.array(z.string().max(60)).optional(),
      }),
      covers: z.array(z.string().max(60)).default([]),
    }),
  ),
  /** The wording changed (or the entry was retired) without the Owner's re-authorization: the authority is void. */
  defineEvent(
    'StandingOrderAuthorityVoided',
    z.object({ entryId: Id, reason: z.enum(['edited', 'retired', 'owner_changed']) }),
  ),
  defineEvent('StandingOrderAuthorityRevoked', z.object({ entryId: Id, by: Id })),
  /** An Admin asks the Owner to take over a standing order as his own (the only way an Admin's order can carry full power). */
  defineEvent(
    'StandingOrderEscalated',
    z.object({
      entryId: Id,
      orgId: Id,
      by: Id,
      note: z.string().max(1000).default(''),
      deskItemId: Id.optional(),
    }),
  ),
  /** The CEO (restricted) judged that a wake falls under an authorized order: the server starts an `order` turn. */
  defineEvent(
    'CeoOrderTurnRequested',
    z.object({
      turnId: Id,
      orgId: Id,
      entryId: Id,
      versionHash: z.string().length(64),
      wakeId: Id.optional(),
      subject: z.string().max(200).default(''),
      why: z.string().max(2000).default(''),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  defineEvent(
    'CeoOrderTurnFinished',
    z.object({
      turnId: Id,
      orgId: Id,
      entryId: Id,
      versionHash: z.string().length(64),
      outcome: z.enum(['done', 'declined', 'failed']),
      summary: z.string().max(4000).default(''),
      commands: z.array(z.string().max(500)).max(200).default([]),
      /** `decline --ask`: the question put to the owner. */
      ask: z.string().max(2000).optional(),
    }),
  ),
] as const;
