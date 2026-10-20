import { z } from 'zod';
import { TOPIC_AREAS, TOPIC_AUDIENCES } from '../blog/topic.ts';

/**
 * Problem notes and research-topic candidates on the organization side (docs/design/ceo-blog-topics.md, Phase 2). A note
 * is a deterministic record of something that went wrong or took long (evidence ids and the signal's own title, org data
 * that never leaves). The CEO turns notes into generic questions; the Owner reviews them; a sweep hands accepted ones on.
 */

export const CEO_TOPIC_STATUSES = [
  'note',
  'proposed',
  'accepted',
  'rejected',
  'merged',
  'expired',
  /** Handed on: it is in the blog writer's queue. */
  'queued',
  /** The platform already covers it, or the writer found no public sources. */
  'duplicate',
  'declined',
  'published',
  /** The consent was turned off (or the platform removed it) before it was written. */
  'withdrawn',
  /** The hand-off scrubber refused it (defence in depth: it passed at propose and at accept). */
  'blocked',
] as const;
export const CeoTopicStatus = z.enum(CEO_TOPIC_STATUSES);
export type CeoTopicStatus = z.infer<typeof CeoTopicStatus>;

export const CEO_TOPIC_SOURCES = [
  'offboard_job',
  'repeat',
  'correction',
  'loop',
  'deploy',
  'desk',
  'owner',
] as const;
export const CeoTopicSource = z.enum(CEO_TOPIC_SOURCES);
export type CeoTopicSource = z.infer<typeof CeoTopicSource>;

/** What the org-side outcome events say happened to a handed-on topic. */
export const CEO_TOPIC_OUTCOMES = [
  'published',
  'declined',
  'rejected',
  'duplicate',
  'withdrawn',
  'blocked',
] as const;
export const CeoTopicOutcomeKind = z.enum(CEO_TOPIC_OUTCOMES);
export type CeoTopicOutcomeKind = z.infer<typeof CeoTopicOutcomeKind>;

/** Job kinds that are everyday work, not a problem worth a note (the owner's routine). */
export const ROUTINE_JOB_KINDS: readonly string[] = [
  'db-query',
  'release-notes',
  'direct-edit',
  'unlabelled',
  'status-report',
  'summary',
];
/** A job that took longer than this becomes a note even when its kind is routine. */
export const SLOW_JOB_MS = 20 * 60_000;
/** A blocking desk item the owner took longer than this to answer becomes a note. */
export const SLOW_ANSWER_MS = 4 * 3_600_000;
/** A note or a proposal nobody acted on within this many days expires. */
export const TOPIC_EXPIRY_DAYS = 14;
/** Candidates within this window count for the org-side duplicate check. */
export const TOPIC_DEDUPE_DAYS = 180;
/** Org-side dedupe: the share of the shorter question's words that must overlap, within one area. */
export const TOPIC_DEDUPE_OVERLAP = 0.6;
/** Open notes listed in the daily review brief. */
export const TOPIC_BRIEF_NOTES = 10;
/** The desk question to the Owner of a customer organization, per batch (owner decision, section 11.2). */
export const TOPICS_DESK_QUESTION =
  'These might make good blog articles for the community. May I send them to Guildwise as research topics?';
export const TOPICS_DESK_SUBKIND = 'ceo_blog_topics';

export interface TopicFindingDto {
  code: string;
  detail?: string;
  overridable?: boolean;
}

export interface CeoTopicDto {
  id: string;
  status: CeoTopicStatus;
  sourceKind: CeoTopicSource;
  /** The signal's own title (org data: shown to the org only). */
  note: string | null;
  question: string | null;
  area: string | null;
  audience: string | null;
  /** Reason codes of the last scrub. */
  findings: TopicFindingDto[];
  occurrences: number;
  /** The evidence kinds, never text. */
  evidenceKinds: string[];
  postSlug: string | null;
  postTitle: string | null;
  createdAt: string;
  decidedAt: string | null;
  publishedAt: string | null;
}

export interface CeoTopicsDto {
  /** False: this organization has not switched on diagnostic sharing (nothing is collected), or has no CEO. */
  enabled: boolean;
  reason?: 'sharing_off' | 'no_ceo';
  /** Customer organizations: only the Owner may answer. */
  ownerOnly: boolean;
  /** How many topics the organization may still hand on this month (customer organizations; null: no cap). */
  remainingThisMonth: number | null;
  topics: CeoTopicDto[];
}

export const CeoTopicEditSchema = z.object({
  question: z.string().trim().min(1).max(400),
  area: z.enum(TOPIC_AREAS).optional(),
  audience: z.enum(TOPIC_AUDIENCES).optional(),
  /** The Owner's second confirmation of an unknown proper noun. */
  allowTerms: z.array(z.string().trim().min(1).max(60)).max(5).optional(),
});
export type CeoTopicEdit = z.infer<typeof CeoTopicEditSchema>;

export const CeoTopicAcceptSchema = CeoTopicEditSchema.partial();
export type CeoTopicAccept = z.infer<typeof CeoTopicAcceptSchema>;
export const CeoTopicRejectSchema = z.object({ reason: z.string().trim().max(300).optional() });
export const CeoTopicCheckSchema = CeoTopicEditSchema;

export interface CeoTopicCheckDto {
  ok: boolean;
  findings: TopicFindingDto[];
}

/** What the daily report carries about topics (the web renders Accept / Edit / Reject from it). */
export interface CeoReportTopicsDto {
  proposed: CeoTopicDto[];
  published: CeoTopicDto[];
  ownerOnly: boolean;
}
