import { z } from 'zod';
import { JourneyDefinitionSchema, JourneyRecordTypeSchema } from '../journeys/schema.ts';
import { JourneyReferenceKindSchema } from '../journeys/record.ts';
import { defineEvent, Id } from './define.ts';

const Visit = z.number().int().min(1);

/**
 * Journeys (streams `journey-<id>`, `journey-instance-<id>`, `journey-record-<id>`, project scope). No event carries a
 * form answer or document content: only ids, keys, labels, the display name and the firm's external id.
 */
export const journeyEvents = [
  defineEvent(
    'JourneySaved',
    z.object({
      journeyId: Id,
      orgId: Id,
      projectId: Id,
      version: z.number().int().min(1),
      definition: JourneyDefinitionSchema,
      by: Id,
    }),
  ),
  defineEvent('JourneyArchived', z.object({ journeyId: Id })),
  defineEvent(
    'JourneyRecordCreated',
    z.object({
      recordId: Id,
      orgId: Id,
      projectId: Id,
      recordType: JourneyRecordTypeSchema,
      externalId: z.string().max(120).optional(),
      displayName: z.string().min(1).max(200),
    }),
  ),
  defineEvent(
    'JourneyRecordReferenceAdded',
    z.object({
      recordId: Id,
      kind: JourneyReferenceKindSchema,
      ref: z.string().min(1).max(500),
      label: z.string().max(200).optional(),
    }),
  ),
  defineEvent('JourneyRecordClosed', z.object({ recordId: Id })),
  defineEvent(
    'JourneyInstanceStarted',
    z.object({
      instanceId: Id,
      journeyId: Id,
      version: z.number().int().min(1),
      recordId: Id,
      orgId: Id,
      projectId: Id,
      firstStepId: z.string().min(1),
      startedBy: Id,
    }),
  ),
  defineEvent(
    'JourneyStepEntered',
    z.object({
      instanceId: Id,
      visit: Visit,
      stepId: z.string().min(1),
      /** `workflow`: a card will be started; otherwise a placeholder that waits for 'Continue'. */
      kind: z.enum(['workflow', 'wait', 'gate']).default('workflow'),
      fromVisit: Visit.optional(),
      handoffId: z.string().optional(),
    }),
  ),
  defineEvent(
    'JourneyStepCardStarted',
    z.object({
      instanceId: Id,
      visit: Visit,
      cardId: Id,
      workflowKey: z.string().min(1),
      workflowVersion: z.number().int().min(1),
    }),
  ),
  defineEvent(
    'JourneyStepRefused',
    z.object({
      instanceId: Id,
      visit: Visit,
      reason: z.enum(['not_enabled', 'not_found', 'not_member', 'invalid_mapping', 'visit_limit']),
      detail: z.string().max(1000),
      deskItemId: Id.optional(),
    }),
  ),
  defineEvent(
    'JourneyStepCompleted',
    z.object({
      instanceId: Id,
      visit: Visit,
      result: z.enum(['done', 'cancelled', 'skipped']),
      cardId: Id.optional(),
    }),
  ),
  defineEvent(
    'JourneyStepPlaybookStarted',
    z.object({ instanceId: Id, visit: Visit, playbookKey: z.string().min(1), threadId: Id }),
  ),
  defineEvent(
    'JourneyInstanceStuck',
    z.object({ instanceId: Id, visit: Visit, reason: z.string().max(1000), deskItemId: Id.optional() }),
  ),
  defineEvent('JourneyInstanceCompleted', z.object({ instanceId: Id, visit: Visit })),
  defineEvent('JourneyInstanceCancelled', z.object({ instanceId: Id, by: Id })),
] as const;
