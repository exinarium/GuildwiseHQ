import { z } from 'zod';
import { CeoPolicySchema } from '../ceo/policy.ts';
import { CeoSettingsSchema, CeoTrainingSchema, NotifyKind, RecommendationResponse } from '../ceo/settings.ts';
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
]);
export type CeoMemorySource = z.infer<typeof CeoMemorySource>;

export const ceoEvents = [
  /** The CEO agent was hired: its settings, default policy and training period start. */
  defineEvent(
    'CeoEnabled',
    z.object({
      orgId: Id,
      agentId: Id,
      by: Id,
      policy: CeoPolicySchema,
      settings: CeoSettingsSchema,
      training: CeoTrainingSchema,
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
] as const;
