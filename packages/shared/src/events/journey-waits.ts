import { z } from 'zod';
import { HookMappingSchema } from '../journeys/steps-wait.ts';
import { defineEvent, Id } from './define.ts';

const Visit = z.number().int().min(1);
const WaitKind = z.enum(['duration', 'date', 'form', 'webhook', 'gate', 'manual']);

/**
 * Journey waits, gates, outbound webhook calls and inbound hook triggers (project scope). Wait, gate and call events go on
 * `journey-instance-<id>`, trigger events on `journey-<journeyId>`. None carries payload content, an address, a link
 * token or a secret in clear text.
 */
export const journeyWaitEvents = [
  defineEvent(
    'JourneyWaitStarted',
    z.object({
      waitId: Id,
      instanceId: Id,
      visit: Visit,
      stepId: z.string().min(1),
      kind: WaitKind,
      startedAt: z.string(),
      deadlineAt: z.string().optional(),
      nextFireAt: z.string().optional(),
      config: z.record(z.string(), z.unknown()),
      linkId: z.string().optional(),
      linkExpiresAt: z.string().optional(),
      triggerId: Id.optional(),
    }),
  ),
  defineEvent(
    'JourneyWaitLinkSent',
    z.object({
      waitId: Id,
      linkId: z.string().min(1),
      via: z.enum(['desk', 'webhook', 'offline_email']),
      expiresAt: z.string(),
      deskItemId: Id.optional(),
    }),
  ),
  /** The client tried the form while the firm's runner was offline: a sub-state of the form wait (no email in it). */
  defineEvent('JourneyWaitOfflinePending', z.object({ waitId: Id, requestId: Id, attemptedAt: z.string() })),
  defineEvent(
    'JourneyWaitTimedOut',
    z.object({
      waitId: Id,
      firedFor: z.string(),
      action: z.enum(['remind', 'goto', 'escalate', 'cancel']),
      n: z.number().int().optional(),
    }),
  ),
  defineEvent(
    'JourneyWaitReminded',
    z.object({
      waitId: Id,
      firedFor: z.string(),
      n: z.number().int().min(1),
      of: z.number().int().min(1),
      nextFireAt: z.string(),
      linkId: z.string().optional(),
      /** A gate reminder raises a fresh desk question for the approver; it replaces the one the wait pointed at. */
      deskItemId: Id.optional(),
    }),
  ),
  defineEvent(
    'JourneyWaitEscalated',
    z.object({
      waitId: Id,
      firedFor: z.string().optional(),
      deskItemId: Id,
      addresseeUserId: Id,
      reason: z.enum(['timeout', 'date_missing']),
    }),
  ),
  defineEvent('JourneyWaitExtended', z.object({ waitId: Id, by: Id, deadlineAt: z.string() })),
  defineEvent(
    'JourneyWaitResolved',
    z.object({
      waitId: Id,
      reason: z.enum([
        'elapsed',
        'date_reached',
        'form_submitted',
        'webhook_received',
        'approved',
        'rejected',
        'continued',
        'goto',
        'cancelled',
      ]),
      by: Id.optional(),
      submissionId: Id.optional(),
      firedFor: z.string().optional(),
    }),
  ),
  defineEvent('JourneyWaitCancelled', z.object({ waitId: Id, reason: z.string().max(200) })),
  defineEvent(
    'JourneyGateOpened',
    z.object({
      waitId: Id,
      deskItemId: Id,
      approverUserId: Id.optional(),
      approverRole: z.string().optional(),
      fellBack: z.boolean().default(false),
    }),
  ),
  defineEvent(
    'JourneyGateDecided',
    z.object({
      waitId: Id,
      decision: z.enum(['approved', 'rejected']),
      by: Id,
      note: z.string().max(2000).optional(),
    }),
  ),
  defineEvent(
    'JourneyWebhookCallStarted',
    z.object({ callId: Id, instanceId: Id, visit: Visit, stepId: z.string().min(1), workstationId: Id }),
  ),
  defineEvent(
    'JourneyWebhookCallDispatched',
    z.object({ callId: Id, attempt: z.number().int().min(1), commandId: Id, deadline: z.string() }),
  ),
  defineEvent(
    'JourneyWebhookCallAttempted',
    z.object({
      callId: Id,
      attempt: z.number().int().min(1),
      ok: z.boolean(),
      httpStatus: z.number().int().optional(),
      error: z.string().max(500).optional(),
      durationMs: z.number().int().min(0),
      nextAttemptAt: z.string().optional(),
    }),
  ),
  defineEvent(
    'JourneyWebhookCallFinished',
    z.object({
      callId: Id,
      ok: z.boolean(),
      attempts: z.number().int().min(0),
      httpStatus: z.number().int().optional(),
    }),
  ),
  defineEvent(
    'JourneyHookTriggerCreated',
    z.object({
      triggerId: Id,
      journeyId: Id,
      orgId: Id,
      projectId: Id,
      purpose: z.enum(['start', 'resume']),
      name: z.string().min(1).max(120),
      tokenHash: z.string().min(1),
      secretEnc: z.string().min(1),
      scheme: z.enum(['guildwise', 'body_sha256']),
      mapping: HookMappingSchema,
      onNoMatch: z.enum(['create', 'refuse']),
      by: Id,
    }),
  ),
  defineEvent(
    'JourneyHookTriggerUpdated',
    z.object({
      triggerId: Id,
      name: z.string().min(1).max(120).optional(),
      scheme: z.enum(['guildwise', 'body_sha256']).optional(),
      mapping: HookMappingSchema.optional(),
      onNoMatch: z.enum(['create', 'refuse']).optional(),
    }),
  ),
  defineEvent(
    'JourneyHookTriggerRotated',
    z.object({ triggerId: Id, tokenHash: z.string().min(1), secretEnc: z.string().min(1) }),
  ),
  defineEvent('JourneyHookTriggerDisabled', z.object({ triggerId: Id })),
  defineEvent(
    'JourneyStartedByHook',
    z.object({ triggerId: Id, instanceId: Id, recordId: Id, recordMatched: z.boolean() }),
  ),
] as const;
