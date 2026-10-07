import { z } from 'zod';
import { FeedVerdictSchema, TranscriptRefSchema } from '../feed/index.ts';
import {
  ALL_INTEREST_KINDS,
  DeliverySpecSchema,
  InterestAgentsSchema,
  InterestKind,
  InterestRunKind,
  InterestRunStatus,
  InterestRunTrigger,
  InterestStatus,
  ScanSpecSchema,
} from '../interests/index.ts';
import { IsoTime } from './common.ts';
import { BudgetDtoSchema, SpendBriefSchema } from './costs.ts';

/** Interests API (docs/design/restructure.md section 7). */

export const InterestStatsSchema = z.object({
  lastRunAt: IsoTime.nullable(),
  lastRun: z
    .object({
      id: z.uuid(),
      kind: InterestRunKind,
      status: InterestRunStatus,
      found: z.number().int().nullable(),
      published: z.number().int().nullable(),
      cardRef: z.string(),
    })
    .nullable(),
  nextScanAt: IsoTime.nullable(),
  nextDeliveryAt: IsoTime.nullable(),
  lastDeliveredAt: IsoTime.nullable(),
  runs30d: z.number().int().nonnegative(),
  items: z.object({
    total: z.number().int().nonnegative(),
    last30d: z.number().int().nonnegative(),
    lastRun: z.number().int().nonnegative(),
    /** Items posted but still waiting for the next delivery. */
    held: z.number().int().nonnegative(),
  }),
  ratings: z.object({
    useful: z.number().int().nonnegative(),
    irrelevant: z.number().int().nonnegative(),
    boring: z.number().int().nonnegative(),
    unrated: z.number().int().nonnegative(),
  }),
  research: z.object({ open: z.number().int().nonnegative(), published: z.number().int().nonnegative() }),
  failing: z.boolean(),
  failCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type InterestStats = z.infer<typeof InterestStatsSchema>;

const AgentRefSchema = z.object({ id: z.uuid(), name: z.string(), online: z.boolean() });

export const InterestDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  name: z.string(),
  description: z.string(),
  slug: z.string().nullable(),
  /** The vault folder, e.g. `interests/rust-async`. */
  vaultDir: z.string().nullable(),
  hasVault: z.boolean(),
  /** The hidden backing project (never listed as a project; the key shows in card refs). */
  projectKey: z.string().nullable(),
  subCategory: z.string().nullable(),
  preferredSites: z.array(z.string()),
  kinds: z.array(InterestKind),
  scan: ScanSpecSchema,
  delivery: DeliverySpecSchema,
  status: InterestStatus,
  archived: z.boolean(),
  /** The preferred agent per role (a soft preference). */
  agents: z.object({
    scout: AgentRefSchema.nullable(),
    curator: AgentRefSchema.nullable(),
    researcher: AgentRefSchema.nullable(),
    checker: AgentRefSchema.nullable(),
  }),
  /** The viewer may edit, pause, archive, delete, run and change the taste rules (the role rule). */
  canManage: z.boolean(),
  /** Owner and Admins: share the interest with other members. */
  canShare: z.boolean(),
  createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  tasteRuleCount: z.number().int().nonnegative(),
  tasteVersion: z.number().int().nonnegative(),
  stats: InterestStatsSchema,
  /** The backing project's monthly budget and this month's spend (Owner and Admin set it). */
  budget: BudgetDtoSchema.optional(),
  spend: SpendBriefSchema.optional(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type InterestDto = z.infer<typeof InterestDtoSchema>;

export const InterestsQuerySchema = z.object({
  status: InterestStatus.optional(),
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export const InterestsResponseSchema = z.object({
  interests: z.array(InterestDtoSchema),
  /** The organization's quiet cap on digest items per day (null: none). */
  quietCap: z.number().int().nullable(),
  /** Digest items put on the desk in the last 24 hours (what the cap counts). */
  deliveredToday: z.number().int().nonnegative(),
  canSetCap: z.boolean(),
});
export type InterestsResponse = z.infer<typeof InterestsResponseSchema>;

export const InterestPublicationSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  cardRef: z.string(),
  title: z.string(),
  vaultPath: z.string().nullable(),
  createdAt: IsoTime,
});

export const InterestMemberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: z.enum(['owner', 'manager']),
  orgGrant: z.boolean(),
});

export const InterestDetailResponseSchema = z.object({
  interest: InterestDtoSchema,
  publications: z.array(InterestPublicationSchema),
  /** The taste rules built into the interest. */
  taste: z.object({
    rules: z.array(z.string()),
    version: z.number().int().nonnegative(),
    hasVault: z.boolean(),
    /** Rating lines the vault `taste.md` holds, newest first (read-only). */
    ratingLines: z.array(z.string()),
  }),
  members: z.array(InterestMemberSchema),
});
export type InterestDetailResponse = z.infer<typeof InterestDetailResponseSchema>;

/** Scan settings of a request: `windowHours` defaults from the cron, `maxItems` to 10. */
export const ScanRequestSchema = z.object({
  cron: z.string().min(1).max(100).default('0 7 * * *'),
  timezone: z.string().min(1).max(60).default('UTC'),
  windowHours: z.number().int().min(1).max(720).optional(),
  maxItems: z.number().int().min(1).max(100).default(10),
  manual: z.boolean().default(false),
});
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

export const DeliveryRequestSchema = z.object({
  mode: z.enum(['immediate', 'scheduled']).default('immediate'),
  cron: z.string().min(1).max(100).default('0 7 * * 1-5'),
  timezone: z.string().min(1).max(60).default('UTC'),
});
export type DeliveryRequest = z.infer<typeof DeliveryRequestSchema>;

/** Patch forms: every key optional, with no defaults (a partial update must not reset what it does not name). */
export const ScanPatchSchema = z.object({
  cron: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(60).optional(),
  windowHours: z.number().int().min(1).max(720).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  manual: z.boolean().optional(),
});
export const DeliveryPatchSchema = z.object({
  mode: z.enum(['immediate', 'scheduled']).optional(),
  cron: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(60).optional(),
});

/** `POST /api/interests` (in the organization of the tab). */
export const CreateInterestRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(20000).default(''),
  subCategory: z.string().trim().min(1).max(120).optional(),
  preferredSites: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  kinds: z.array(InterestKind).min(1).max(3).default(ALL_INTEREST_KINDS),
  scan: ScanRequestSchema.optional(),
  delivery: DeliveryRequestSchema.optional(),
  agents: InterestAgentsSchema.optional(),
  tasteRules: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  status: InterestStatus.default('active'),
});
export type CreateInterestRequest = z.infer<typeof CreateInterestRequestSchema>;

/** `PATCH /api/interests/:id`. A null agent clears the preference. */
export const PatchInterestRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(20000),
    subCategory: z.string().trim().min(1).max(120).nullable(),
    preferredSites: z.array(z.string().trim().min(1).max(500)).max(50),
    kinds: z.array(InterestKind).min(1).max(3),
    scan: ScanPatchSchema,
    delivery: DeliveryPatchSchema,
    agents: z.object({
      scout: z.uuid().nullable().optional(),
      curator: z.uuid().nullable().optional(),
      researcher: z.uuid().nullable().optional(),
      checker: z.uuid().nullable().optional(),
    }),
    status: InterestStatus,
  })
  .partial();
export type PatchInterestRequest = z.infer<typeof PatchInterestRequestSchema>;

export const DeleteInterestRequestSchema = z.object({ confirmSlug: z.string().min(1) });
export const CreateInterestResponseSchema = z.object({ id: z.uuid() });

export const InterestTasteRequestSchema = z.object({
  rules: z.array(z.string().trim().min(1).max(500)).max(100),
});

/** `POST /api/interests/:id/run`: a scan, or "Research this" (an optional question, depth and the digest item it starts from). */
export const RunInterestRequestSchema = z.object({
  kind: InterestRunKind.default('scan'),
  question: z.string().trim().min(1).max(2000).optional(),
  depth: z.enum(['quick', 'standard', 'deep']).optional(),
  sourceItemId: z.uuid().optional(),
  /** Mock runtime only (`AOM_MOCK_UI`): the scripted pages or claims the mock agents work from (`mockFeed`, `mockResearch`, `mock`). */
  mock: z.record(z.string(), z.unknown()).optional(),
});
export type RunInterestRequest = z.infer<typeof RunInterestRequestSchema>;
export const RunInterestResponseSchema = z.object({ runId: z.uuid(), cardId: z.uuid(), ref: z.string() });

/** Deliver the held items now, ahead of the delivery schedule (still within the quiet cap). */
export const DeliverInterestResponseSchema = z.object({
  delivered: z.number().int().nonnegative(),
  heldBack: z.number().int().nonnegative(),
});

export const InterestRunsQuerySchema = z.object({
  before: IsoTime.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  kind: InterestRunKind.optional(),
});

export const InterestRunDtoSchema = z.object({
  id: z.uuid(),
  kind: InterestRunKind,
  trigger: InterestRunTrigger,
  status: InterestRunStatus,
  startedAt: IsoTime,
  finishedAt: IsoTime.nullable(),
  found: z.number().int().nullable(),
  published: z.number().int().nullable(),
  duplicatesDropped: z.number().int().nullable(),
  overMaxDropped: z.number().int().nullable(),
  startedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  ratings: z.object({
    useful: z.number().int().nonnegative(),
    irrelevant: z.number().int().nonnegative(),
    boring: z.number().int().nonnegative(),
    unrated: z.number().int().nonnegative(),
  }),
  card: z.object({ id: z.uuid(), ref: z.string() }),
  parentRunId: z.uuid().nullable(),
  childRunIds: z.array(z.uuid()),
});
export type InterestRunDto = z.infer<typeof InterestRunDtoSchema>;
export const InterestRunsResponseSchema = z.object({
  runs: z.array(InterestRunDtoSchema),
  hasMore: z.boolean(),
});

export const InterestRunItemSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  title: z.string(),
  url: z.string(),
  source: z.string(),
  summary: z.string(),
  verdict: FeedVerdictSchema.nullable(),
  verdictReason: z.string().nullable(),
  transcript: TranscriptRefSchema.nullable(),
  /** Whether the item reached the desk yet (a scheduled delivery holds it). */
  delivered: z.boolean(),
});
export const InterestRunDetailResponseSchema = z.object({
  run: InterestRunDtoSchema,
  items: z.array(InterestRunItemSchema),
  notes: z.array(InterestPublicationSchema),
  shifts: z.array(
    z.object({
      id: z.uuid(),
      role: z.string().nullable(),
      agentName: z.string().nullable(),
      status: z.string(),
      startedAt: IsoTime.nullable(),
      endedAt: IsoTime.nullable(),
    }),
  ),
});
export type InterestRunDetailResponse = z.infer<typeof InterestRunDetailResponseSchema>;

export const InterestDeliveriesResponseSchema = z.object({
  deliveries: z.array(
    z.object({
      id: z.uuid(),
      at: IsoTime,
      itemCount: z.number().int().nonnegative(),
      heldBack: z.number().int().nonnegative(),
      trigger: z.enum(['schedule', 'manual']),
      deskItemId: z.uuid().nullable(),
    }),
  ),
});
export type InterestDeliveriesResponse = z.infer<typeof InterestDeliveriesResponseSchema>;
export type InterestRunsResponse = z.infer<typeof InterestRunsResponseSchema>;

/** The agents that qualify for the interest, by role. */
export const EligibleAgentsResponseSchema = z.object({
  scout: z.array(AgentRefSchema),
  curator: z.array(AgentRefSchema),
  researcher: z.array(AgentRefSchema),
  checker: z.array(AgentRefSchema),
});
export type EligibleAgentsResponse = z.infer<typeof EligibleAgentsResponseSchema>;

export const InterestMemberRequestSchema = z.object({ userId: z.uuid() });
