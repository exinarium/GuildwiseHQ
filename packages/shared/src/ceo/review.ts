import { z } from 'zod';

/**
 * The CEO-BA discussion after the owner corrected a CEO decision (exactly BA analysis, CEO reply, BA final). The BA writes
 * its proposal as markdown plus one fenced json block; the server parses the block, so the proposed cards travel as data.
 */

/** The wake reason of the CEO's turn in the discussion. */
export const CEO_DECISION_REVIEW_REASON = 'decision_review';

/** How long the CEO has to reply after the BA analysis; then the server records the lesson on its behalf. */
export const CEO_REVIEW_REPLY_TIMEOUT_MS = 2 * 3_600_000;

/** One fix card the BA proposes (and, in its final turn, creates). */
export const FixCardSchema = z.object({
  title: z.string().trim().min(1).max(300),
  /** Project key. */
  project: z.string().trim().min(1).max(20),
  cardType: z.enum(['feature', 'bug', 'support', 'refactor', 'docs']).default('bug'),
  /** What to change, and why the wrong decision makes it necessary. */
  change: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(12).default([]),
  /** Optional: where the change is, constraints, how to test it (sensible defaults are filled in). */
  affectedAreas: z.string().trim().max(1000).optional(),
  constraints: z.string().trim().max(1000).optional(),
  testPlan: z.string().trim().max(1000).optional(),
  /** Refs of existing cards, or the titles of other cards in the same proposal. */
  dependsOn: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  priority: z.number().int().min(1).max(9).optional(),
});
export type FixCard = z.infer<typeof FixCardSchema>;

export const FixPlanSchema = z.object({
  /** What already happened because of the wrong decision. */
  consequences: z.string().max(4000).optional(),
  /** Set when no fix work is needed: why. */
  noFixNeeded: z.string().trim().max(1000).optional(),
  fixCards: z.array(FixCardSchema).max(8).default([]),
});
export type FixPlan = z.infer<typeof FixPlanSchema>;

const FENCE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

/**
 * Splits a BA report into its prose and its fix plan (the last fenced block that parses as one). `plan` is undefined when
 * there is no such block or it is invalid; `error` then says why (the prose is still returned, without the block).
 */
export function splitFixPlan(text: string): { prose: string; plan?: FixPlan; error?: string } {
  const blocks = [...text.matchAll(FENCE)];
  for (const m of blocks.reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(m[1] ?? '');
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const parsed = FixPlanSchema.safeParse(raw);
    const prose = `${text.slice(0, m.index)}${text.slice((m.index ?? 0) + m[0].length)}`.trim();
    if (parsed.success) return { prose, plan: parsed.data };
    return { prose, error: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') };
  }
  return { prose: text.trim() };
}

/** The stance of the CEO's reply. The owner's correction stands whatever it says. */
export const CeoReviewStance = z.enum(['agree', 'disagree']);
export type CeoReviewStance = z.infer<typeof CeoReviewStance>;
