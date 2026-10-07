import { z } from 'zod';
import { SignalKind, SignalSubjectSchema, SignalUrgency } from '../reporter/index.ts';
import { defineEvent, Id } from './define.ts';
import { DeskActorSchema } from './desk.ts';

/**
 * Part B events (docs/design/phases.md B1-B6). Streams: `user-<id>` (preferences), `desk-<id>` (triage, notes),
 * `ba-signal-<id>`. The routing decision is always recorded in the event (`DeskItemCreated.triage`), never recomputed
 * from settings on replay.
 */
export const reporterEvents = [
  defineEvent(
    'ReportingPrefsChanged',
    z.object({
      userId: Id,
      routeViaBa: z.boolean().optional(),
      dailyAt: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
      /** The org's quiet cap on interest digest items per day (null clears it). */
      interestDigestCap: z.number().int().min(1).max(1000).nullable().optional(),
    }),
  ),
  /** The standing "BA reports" chat of the organization owner (created on the first report). */
  defineEvent('BaChatLinked', z.object({ userId: Id, threadId: Id })),
  /** What happened to a held item. `released`: the BA did not get to it in time. */
  defineEvent(
    'DeskItemTriaged',
    z.object({
      deskItemId: Id,
      outcome: z.enum(['passed', 'released', 'dismissed', 'merged']),
      note: z.string().max(4000).optional(),
      intoDeskItemId: Id.optional(),
      by: DeskActorSchema,
    }),
  ),
  /** The BA's context on an item that is already on the desk. */
  defineEvent(
    'DeskItemAnnotated',
    z.object({
      deskItemId: Id,
      note: z.string().min(1).max(20000),
      by: DeskActorSchema,
      relatedDeskItemIds: z.array(Id).default([]),
      signalId: Id.optional(),
    }),
  ),
  defineEvent(
    'BaSignalRaised',
    z.object({
      signalId: Id,
      projectId: Id.optional(),
      kind: SignalKind,
      fingerprint: z.string().min(1),
      urgency: SignalUrgency,
      subject: SignalSubjectSchema,
      evidence: z.record(z.string(), z.unknown()).default({}),
      count: z.number().int().positive().default(1),
    }),
  ),
  /** The condition was seen again (or got worse). */
  defineEvent(
    'BaSignalUpdated',
    z.object({
      signalId: Id,
      count: z.number().int().positive(),
      urgency: SignalUrgency.optional(),
      subject: SignalSubjectSchema.optional(),
      evidence: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  /** The signal went into a report (a desk item, an annotation, or the floor report). */
  defineEvent('BaSignalReported', z.object({ signalId: Id, deskItemId: Id.optional() })),
  defineEvent('BaSignalResolved', z.object({ signalId: Id, note: z.string().optional() })),
  /** More items or signals joined a reporter task that was still queued. */
  defineEvent(
    'BaTaskItemsAdded',
    z.object({ taskId: Id, deskItemIds: z.array(Id).optional(), signalIds: z.array(Id).optional() }),
  ),
] as const;
