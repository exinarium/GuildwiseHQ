import { z } from 'zod';
import { InterestBodySchema, InterestRunKind, InterestRunTrigger } from '../interests/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Interest events (docs/design/restructure.md section 3.4), stream `interest-<id>`, scope the backing project (so
 * visibility follows its members). Updates carry the full snapshot, like `ScheduleUpdated`. Fields of the first model
 * (feed project, research project, owned schedule) stay optional so old events replay.
 */
export const interestEvents = [
  defineEvent('InterestCreated', InterestBodySchema),
  defineEvent('InterestUpdated', InterestBodySchema),
  defineEvent('InterestArchived', z.object({ interestId: Id, by: Id })),
  defineEvent('InterestRestored', z.object({ interestId: Id, by: Id })),
  /** Used with a permanent `ProjectDeleted` of the backing project (or by the first model's delete). */
  defineEvent('InterestDeleted', z.object({ interestId: Id, keepSchedule: z.boolean().default(false) })),
  /** The taste rules built into the interest (replaced as a whole; `version` bumps on every set). */
  defineEvent(
    'InterestTasteSet',
    z.object({
      interestId: Id,
      version: z.number().int().positive(),
      rules: z.array(z.string().min(1).max(500)).max(100),
    }),
  ),
  /** A run began: always appended with the `CardCreated` (origin `interest`) of its card. */
  defineEvent(
    'InterestRunStarted',
    z.object({
      runId: Id,
      interestId: Id,
      kind: InterestRunKind,
      trigger: InterestRunTrigger,
      cardId: Id,
      parentRunId: Id.optional(),
      startedBy: Id.optional(),
      /** The next scheduled scan, set by a cron fire (and recomputed by a manual run only when the interest was never scheduled). */
      nextScanAt: z.string().nullable().optional(),
    }),
  ),
  /** The card of a due run could not be created (project archived, workflow missing): back-off, like `ScheduleFireFailed`. */
  defineEvent(
    'InterestRunFailed',
    z.object({
      interestId: Id,
      kind: InterestRunKind.default('scan'),
      attempts: z.number().int().nonnegative(),
      error: z.string(),
      nextScanAt: z.string().nullable(),
      /** A run that is skipped because the previous one is still running does not count as a failure. */
      counted: z.boolean().default(true),
      deskItemId: Id.optional(),
    }),
  ),
  /** A run finished with its output (the real event `interest_run_done` schedule triggers listen to). */
  defineEvent(
    'InterestRunDone',
    z.object({
      runId: Id,
      interestId: Id,
      cardId: Id,
      kind: InterestRunKind,
      status: z.enum(['published', 'nothing']),
      found: z.number().int().nonnegative().optional(),
      published: z.number().int().nonnegative(),
      duplicatesDropped: z.number().int().nonnegative().default(0),
      overMaximumDropped: z.number().int().nonnegative().default(0),
      itemIds: z.array(Id).default([]),
    }),
  ),
  /**
   * The items held since the last delivery reached the manager as one digest (or, with `itemIds: []`, a delivery time
   * passed with nothing to deliver). `heldBack` items stay for the next delivery because of the quiet cap.
   */
  defineEvent(
    'InterestDigestDelivered',
    z.object({
      deliveryId: Id,
      interestId: Id,
      itemIds: z.array(Id),
      deskItemId: Id.optional(),
      heldBack: z.number().int().nonnegative().default(0),
      trigger: z.enum(['schedule', 'manual']).default('schedule'),
      nextDeliveryAt: z.string().nullable(),
    }),
  ),
  /**
   * Data migration `restructure-2026-10`: the interest now has its backing project. Back-fills `cards.interest_id` of
   * the project's feed cards, inserts the migrated run log and (with `copySeenFrom`) copies the seen-list.
   */
  defineEvent(
    'InterestMigrated',
    z.object({
      interestId: Id,
      projectId: Id,
      slug: z.string().min(1),
      /** Legacy (ignored). */
      domain: z.enum(['work', 'personal']).optional(),
      fromFeedProjectId: Id.optional(),
      fromScheduleId: Id.optional(),
      cardFilter: z.object({
        projectId: Id.nullable(),
        scheduleId: Id.optional(),
        untaggedFeedCards: z.boolean().default(false),
      }),
      copySeenFrom: Id.optional(),
    }),
  ),
] as const;
