import { z } from 'zod';
import { ProjectDomain } from '../events/project.ts';
import { ProjectKeySchema } from '../ids.ts';
import { InterestStatus, ScanSpecSchema, TasteSeedRuleSchema } from '../interests/index.ts';
import { IsoTime } from './common.ts';

/** Interests API (docs/design/interests.md section 7). */

export const InterestStatsSchema = z.object({
  lastScanAt: IsoTime.nullable(),
  lastScanCard: z.object({ id: z.uuid(), ref: z.string(), status: z.string() }).nullable(),
  nextScanAt: IsoTime.nullable(),
  scans30d: z.number().int().nonnegative(),
  items: z.object({
    total: z.number().int().nonnegative(),
    last30d: z.number().int().nonnegative(),
    lastScan: z.number().int().nonnegative(),
  }),
  ratings: z.object({
    useful: z.number().int().nonnegative(),
    irrelevant: z.number().int().nonnegative(),
    boring: z.number().int().nonnegative(),
    unrated: z.number().int().nonnegative(),
  }),
  research: z.object({ open: z.number().int().nonnegative(), published: z.number().int().nonnegative() }),
  failing: z.boolean(),
});
export type InterestStats = z.infer<typeof InterestStatsSchema>;

const ProjectRefSchema = z.object({ id: z.uuid(), key: z.string(), name: z.string(), archived: z.boolean() });

export const InterestDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  name: z.string(),
  description: z.string(),
  feedProject: ProjectRefSchema.nullable(),
  researchProject: ProjectRefSchema.nullable(),
  subCategory: z.string().nullable(),
  preferredSites: z.array(z.string()),
  scan: ScanSpecSchema.nullable(),
  status: InterestStatus,
  scheduleId: z.uuid().nullable(),
  adoptedFrom: z.uuid().nullable(),
  /** The viewer may edit, pause and delete this interest (and its taste rules). */
  canManage: z.boolean(),
  /** The viewer may run the feed now. */
  canRun: z.boolean(),
  /** The viewer may create a research card for it. */
  canResearch: z.boolean(),
  /** Number of explicit taste rules tagged with this interest. */
  tasteRuleCount: z.number().int().nonnegative(),
  schedule: z
    .object({
      id: z.uuid(),
      enabled: z.boolean(),
      nextFireAt: IsoTime.nullable(),
      failCount: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  stats: InterestStatsSchema,
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type InterestDto = z.infer<typeof InterestDtoSchema>;

export const InterestsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  status: InterestStatus.optional(),
});
export const InterestsResponseSchema = z.object({
  interests: z.array(InterestDtoSchema),
  /** Per feed project with explicit rules (or an owned feed project): how many rules and whether they are mirrored. */
  tasteProjects: z.array(
    z.object({
      projectId: z.uuid(),
      key: z.string(),
      name: z.string(),
      ruleCount: z.number().int().nonnegative(),
      version: z.number().int().nonnegative(),
      hasVault: z.boolean(),
      canManage: z.boolean(),
    }),
  ),
  /** Unlinked feed schedules the viewer may adopt. */
  adoptableCount: z.number().int().nonnegative(),
});

export const InterestScanSchema = z.object({
  cardId: z.uuid(),
  ref: z.string(),
  status: z.string(),
  firedAt: IsoTime,
  items: z.number().int().nonnegative(),
  nothingQualified: z.boolean(),
});
export const InterestPublicationSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  cardRef: z.string(),
  title: z.string(),
  createdAt: IsoTime,
});

export const InterestDetailResponseSchema = z.object({
  interest: InterestDtoSchema,
  scans: z.array(InterestScanSchema),
  publications: z.array(InterestPublicationSchema),
  /** Explicit taste rules tagged with this interest. */
  taste: z.object({
    rules: z.array(z.string()),
    version: z.number().int().nonnegative(),
    hasVault: z.boolean(),
  }),
});
export type InterestDetailResponse = z.infer<typeof InterestDetailResponseSchema>;

const NewFeedProjectSchema = z.object({
  key: ProjectKeySchema,
  name: z.string().min(1).max(120),
  domain: ProjectDomain.default('personal'),
});

/** Scan settings of a request: `windowHours` defaults from the cron, `maxItems` to 10. */
export const ScanRequestSchema = z.object({
  cron: z.string().min(1).max(100).default('0 7 * * *'),
  timezone: z.string().min(1).max(60).default('UTC'),
  windowHours: z.number().int().min(1).max(720).optional(),
  maxItems: z.number().int().min(1).max(100).default(10),
  manual: z.boolean().default(false),
});
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

/** `POST /api/interests`. At least one of a feed project (existing or new) and a research project. */
export const CreateInterestRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(20000).default(''),
  feedProjectId: z.uuid().optional(),
  newFeedProject: NewFeedProjectSchema.optional(),
  researchProjectId: z.uuid().optional(),
  subCategory: z.string().trim().min(1).max(120).optional(),
  preferredSites: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  scan: ScanRequestSchema.optional(),
  status: InterestStatus.default('active'),
});
export type CreateInterestRequest = z.infer<typeof CreateInterestRequestSchema>;

/** `PATCH /api/interests/:id`: a null project unlinks it. */
export const PatchInterestRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(20000),
    feedProjectId: z.uuid().nullable(),
    researchProjectId: z.uuid().nullable(),
    subCategory: z.string().trim().min(1).max(120).nullable(),
    preferredSites: z.array(z.string().trim().min(1).max(500)).max(50),
    scan: ScanRequestSchema.partial(),
    status: InterestStatus,
  })
  .partial();
export type PatchInterestRequest = z.infer<typeof PatchInterestRequestSchema>;

export const DeleteInterestQuerySchema = z.object({
  keepSchedule: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const CreateInterestResponseSchema = z.object({ id: z.uuid() });

export const AdoptableSchedulesResponseSchema = z.object({
  schedules: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      projectId: z.uuid(),
      projectKey: z.string(),
      cron: z.string(),
      timezone: z.string(),
      enabled: z.boolean(),
      topic: z.string().nullable(),
    }),
  ),
});
export const AdoptRequestSchema = z.object({ scheduleIds: z.array(z.uuid()).min(1).max(100) });
export const AdoptResponseSchema = z.object({
  results: z.array(
    z.object({
      scheduleId: z.uuid(),
      interestId: z.uuid().optional(),
      error: z.string().optional(),
    }),
  ),
});
export type AdoptResponse = z.infer<typeof AdoptResponseSchema>;

export const InterestTasteRequestSchema = z.object({
  rules: z.array(z.string().trim().min(1).max(500)).max(100),
});
export const TasteSeedResponseSchema = z.object({
  projectId: z.uuid(),
  version: z.number().int().nonnegative(),
  rules: z.array(TasteSeedRuleSchema),
  hasVault: z.boolean(),
});
export type TasteSeedResponse = z.infer<typeof TasteSeedResponseSchema>;
export const TasteSeedRequestSchema = z.object({ rules: z.array(TasteSeedRuleSchema).max(100) });

export const RunInterestResponseSchema = z.object({ cardId: z.uuid(), ref: z.string() });
