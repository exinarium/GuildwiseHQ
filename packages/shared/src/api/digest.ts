import { z } from 'zod';
import { FeedVerdictSchema } from '../feed/index.ts';
import { IsoTime } from './common.ts';

export const DigestItemDtoSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  cardRef: z.string(),
  projectId: z.uuid(),
  projectKey: z.string(),
  kind: z.string(),
  url: z.string(),
  title: z.string(),
  source: z.string(),
  publishedAt: IsoTime.nullable(),
  summary: z.string(),
  verdict: FeedVerdictSchema.nullable(),
  verdictReason: z.string().nullable(),
  ratedAt: IsoTime.nullable(),
  /** The grouped rating item on the desk this digest created. */
  deskItemId: z.uuid().nullable(),
  createdAt: IsoTime,
});
export type DigestItemDto = z.infer<typeof DigestItemDtoSchema>;

export const DigestItemsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  /** `unrated` (default) or every item of the project's running list. */
  status: z.enum(['unrated', 'all']).default('all'),
});
export const DigestItemsResponseSchema = z.object({ items: z.array(DigestItemDtoSchema) });

/** `POST /api/digest-items/:id/rate` */
export const RateDigestItemRequestSchema = z.object({
  verdict: FeedVerdictSchema,
  reason: z.string().max(1000).optional(),
});
export type RateDigestItemRequest = z.infer<typeof RateDigestItemRequestSchema>;

/**
 * `GET /api/projects/:id/taste`: what `projects/<name>/taste.md` holds, rebuilt from the ratings and approved rules
 * (the site holds no vault content; this is the preview of what was written).
 */
export const TasteResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  /** One readable line per rating or approved rule, oldest first. */
  lines: z.array(z.string()),
});
export type TasteResponse = z.infer<typeof TasteResponseSchema>;

/** `GET /api/projects/:id/feed`: the project's running list, oldest first (`projects/<name>/feed.md`). */
export const FeedListResponseSchema = z.object({
  path: z.string(),
  items: z.array(DigestItemDtoSchema),
});
export type FeedListResponse = z.infer<typeof FeedListResponseSchema>;
