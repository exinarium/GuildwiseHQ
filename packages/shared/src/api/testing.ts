import { z } from 'zod';
import {
  CardStatus,
  CardType,
  CompletionAction,
  StoredCompletionAction,
  TestEvidence,
} from '../cards/types.ts';
import { RegressionPlatform, SuiteKind, TestPlatform } from '../events/testing.ts';
import { IsoTime } from './common.ts';

/** `POST /api/cards/:id/finalize` (manager). Without a BA (before M7) the manager triggers finalize by hand. */
export const FinalizeCardRequestSchema = z.object({
  /** Overrides the card's completion action (the BA may revise it before finalize). */
  action: CompletionAction.optional(),
});
export type FinalizeCardRequest = z.infer<typeof FinalizeCardRequestSchema>;

export const FinalizeCardResponseSchema = z.object({
  cardId: z.uuid(),
  ref: z.string(),
  /** `awaiting_approval`: a large-tier merge waits for the desk; `running`: `finalize.execute` was queued. */
  state: z.enum(['awaiting_approval', 'running']),
  action: StoredCompletionAction,
  deskItemId: z.uuid().nullable(),
});
export type FinalizeCardResponse = z.infer<typeof FinalizeCardResponseSchema>;

/** `POST /api/projects/:id/regression` (manager): one regression card per platform, queued for testers. */
export const RegressionRequestSchema = z.object({ platform: RegressionPlatform });
export type RegressionRequest = z.infer<typeof RegressionRequestSchema>;
export const RegressionResponseSchema = z.object({
  cards: z.array(z.object({ id: z.uuid(), ref: z.string(), platform: TestPlatform })),
});
export type RegressionResponse = z.infer<typeof RegressionResponseSchema>;

export const TestRunDtoSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  shiftId: z.uuid().nullable(),
  kind: z.enum(['feature', 'full_suite', 'regression']),
  platform: TestPlatform.nullable(),
  result: z.enum(['passed', 'failed']),
  evidence: TestEvidence,
  createdAt: IsoTime,
});
export type TestRunDto = z.infer<typeof TestRunDtoSchema>;

export const RelatedCardSchema = z.object({
  id: z.uuid(),
  ref: z.string(),
  title: z.string(),
  cardType: CardType,
  stage: z.string(),
  status: CardStatus,
});
export type RelatedCard = z.infer<typeof RelatedCardSchema>;

/** Testing and finalize facts of a card, additive on `CardDetailResponse`. */
export const CardTestingSchema = z.object({
  testRuns: z.array(TestRunDtoSchema),
  /** The card this one was spawned from (bug child, suite card) and the cards it spawned. */
  parent: RelatedCardSchema.nullable(),
  children: z.array(RelatedCardSchema),
  /** Waiting on this open bug child (the Test column's "waiting on bug" state). */
  waitingOn: RelatedCardSchema.nullable(),
  /** Set while a tester shift is parked on a DevOps request (app not deployed / Docker missing). */
  parkedOn: z.object({ requestId: z.uuid(), problem: z.string() }).nullable(),
  finalize: z.object({
    /** The manager may press Finalize now (stage finalize, queued, unclaimed). */
    available: z.boolean(),
    action: StoredCompletionAction.nullable(),
    /** Merge on a large-tier card waits for a desk approval first. */
    requiresApproval: z.boolean(),
    state: z.enum(['idle', 'awaiting_approval', 'running', 'failed']),
    deskItemId: z.uuid().nullable(),
    lastError: z.string().nullable(),
  }),
  suiteKind: SuiteKind.nullable(),
});
export type CardTesting = z.infer<typeof CardTestingSchema>;
