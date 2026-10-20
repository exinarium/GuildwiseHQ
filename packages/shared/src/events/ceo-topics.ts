import { z } from 'zod';
import { CeoTopicOutcomeKind, CeoTopicSource } from '../ceo/topics.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Research-topic candidates of an organization (docs/design/ceo-blog-topics.md, Phase 2). Stream `ceo-<orgId>`, audience
 * `org`. Evidence is ids only. The question text lives here because the Owner reviews it, but it never reaches the
 * platform stream through these events: the hand-off sweep appends `BlogTopicQueued` on its own, with a system actor.
 */

const Finding = z.object({
  code: z.string().min(1).max(40),
  detail: z.string().max(60).optional(),
  overridable: z.boolean().optional(),
});

export const ceoTopicEvents = [
  /** A deterministic problem note (no question yet). The id is derived from the source and subject, so a note is made once. */
  defineEvent(
    'CeoTopicNoted',
    z.object({
      candidateId: Id,
      orgId: Id,
      sourceKind: CeoTopicSource,
      evidence: z.array(z.object({ kind: z.string().max(30), id: z.string().max(100) })).max(50),
      /** The signal's own title: org data that stays here. */
      note: z.string().max(300),
    }),
  ),
  /** The CEO proposed a generic question for a note, or the Owner edited it. The scrubber passed. */
  defineEvent(
    'CeoTopicProposed',
    z.object({
      candidateId: Id,
      orgId: Id,
      question: z.string().min(1).max(200),
      area: z.string().min(1).max(30),
      audience: z.string().max(20).optional(),
      findings: z.array(Finding).max(20).default([]),
      by: z.enum(['ceo', 'owner']),
      byUser: Id.optional(),
    }),
  ),
  /** The proposal repeats an earlier candidate: the note joins it (occurrences go up, evidence is united). */
  defineEvent('CeoTopicMerged', z.object({ candidateId: Id, orgId: Id, intoId: Id })),
  /** The Owner (or, in the platform organization, an Admin) accepted or rejected a proposal. */
  defineEvent(
    'CeoTopicReviewed',
    z.object({
      candidateId: Id,
      orgId: Id,
      decision: z.enum(['accepted', 'rejected']),
      /** Set when the question was edited with the decision. */
      question: z.string().min(1).max(200).optional(),
      area: z.string().min(1).max(30).optional(),
      audience: z.string().max(20).optional(),
      /** The key to the platform side, set on accept (the one place it is stored: the org side). */
      topicId: Id.optional(),
      /** Proper nouns the reviewer confirmed for this topic. */
      allowTerms: z.array(z.string().max(60)).max(5).optional(),
      reason: z.string().max(300).optional(),
      by: Id,
    }),
  ),
  /** A note or proposal that nobody decided in time. */
  defineEvent('CeoTopicExpired', z.object({ candidateId: Id, orgId: Id })),
  /** The hand-off sweep gave the topic to the blog queue (`queued`) or the platform already covered it (`duplicate`). */
  defineEvent(
    'CeoTopicHandedOff',
    z.object({ candidateId: Id, orgId: Id, topicId: Id, status: z.enum(['queued', 'duplicate']) }),
  ),
  /** What became of a handed-on topic, read back by the sweep (published, declined, removed, withdrawn, blocked). */
  defineEvent(
    'CeoTopicOutcome',
    z.object({
      candidateId: Id,
      orgId: Id,
      outcome: CeoTopicOutcomeKind,
      postSlug: z.string().max(200).optional(),
      postTitle: z.string().max(300).optional(),
      reason: z.string().max(300).optional(),
    }),
  ),
] as const;
