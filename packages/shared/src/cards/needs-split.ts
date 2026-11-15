import { z } from 'zod';

/**
 * Needs split: a card over its project's size budget goes back to the BA once, carrying the architect's folder scope and
 * proposed split seams. The BA splits it with the existing `spec_card` split (one splitting route). A card that already
 * took the route, or was split out of one that did, goes to the owner's desk instead. Contract shared by the server, the
 * runner and the web.
 */

/** Most seams a proposal may name: the most cards a `spec_card` split creates (`SPEC_CARD_MAX_SPLIT`). */
export const NEEDS_SPLIT_MAX_SEAMS = 8;

/** A folder inside a repository (scope is folders, never exact paths). */
export const NeedsSplitFolderSchema = z
  .string()
  .transform((s) =>
    s
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, ''),
  )
  .pipe(
    z
      .string()
      .min(1, 'name a folder')
      .max(300)
      .refine((p) => !p.startsWith('/'), 'a folder inside the repository, not starting with /')
      .refine((p) => !p.split('/').includes('..'), 'no .. in a folder')
      .refine((p) => !/[*?[\]]/.test(p), 'a folder, not a pattern')
      // the last segment looks like a file (name.ext); a dot-folder such as .github is a folder
      .refine(
        (p) => !/(^|\/)[^/.][^/]*\.[A-Za-z0-9]{1,8}$/.test(p),
        'a folder, not a file: name the folder that holds it',
      ),
  );

export const NeedsSplitSeamSchema = z.object({
  title: z.string().trim().min(1).max(200),
  folders: z.array(NeedsSplitFolderSchema).min(1).max(20),
  /** Repository name for multi-repository projects; absent: the card's repository. */
  repo: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});

const EstimateSchema = z.object({
  size: z.number().int().min(0),
  budget: z.number().int().min(1),
  /** The size unit of the project (kept a plain string here). */
  unit: z.string().min(1).max(40),
});

/** The architect's proposal that goes with the card to the BA (strict: request input). */
export const NeedsSplitProposalSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    folderScope: z.array(NeedsSplitFolderSchema).min(1).max(50),
    seams: z.array(NeedsSplitSeamSchema).min(2).max(NEEDS_SPLIT_MAX_SEAMS),
    /** The size verdict it came from. */
    estimate: EstimateSchema.optional(),
  })
  .refine(
    (p) => new Set(p.folderScope).size === p.folderScope.length,
    'each folder appears once in the folder scope',
  );
export type NeedsSplitProposal = z.infer<typeof NeedsSplitProposalSchema>;

/** Stored and DTO form: the same shape with no transform or refinement, so an old event always parses. */
export const StoredNeedsSplitProposalSchema = z.object({
  reason: z.string(),
  folderScope: z.array(z.string()),
  seams: z.array(
    z.object({
      title: z.string(),
      folders: z.array(z.string()),
      repo: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  estimate: z.object({ size: z.number(), budget: z.number(), unit: z.string() }).optional(),
});
export type StoredNeedsSplitProposal = z.infer<typeof StoredNeedsSplitProposalSchema>;

/** `dropped`: the BA task ended without a split (the card left the draft, or the task was cancelled). */
export const NeedsSplitState = z.enum(['with_ba', 'owner', 'split', 'continued', 'cancelled', 'dropped']);
export type NeedsSplitState = z.infer<typeof NeedsSplitState>;
export const NeedsSplitReason = z.enum([
  'first',
  'second_time',
  'inherited',
  'no_ba',
  'ba_failed',
  'owner_again',
]);
export type NeedsSplitReason = z.infer<typeof NeedsSplitReason>;

/** Desk subkind of the owner's decision on an over-budget card that may not go to the BA (again). */
export const NEEDS_SPLIT_DESK_SUBKIND = 'needs_split_decision';
export const NEEDS_SPLIT_OPTIONS = { continue: 'continue', baAgain: 'ba_again', cancel: 'cancel' } as const;

/**
 * The architect's needs-split question on a design over the size budget (the first time): the CEO holds it first, then
 * the owner. `split` sends the card back to the BA (the transition above), `build` keeps the design and goes on.
 */
export const NEEDS_SPLIT_QUESTION_SUBKIND = 'needs_split_question';
export const NEEDS_SPLIT_QUESTION_OPTIONS = { split: 'split', build: 'build' } as const;
/** Runners from this version send the size estimate with `aom design` (`--size`, `--path`, `--risk`, `--seam`). */
export const MIN_RUNNER_FOR_DESIGN_SIZE = '0.1.75';

export const NEEDS_SPLIT_REASON_TEXT: Record<NeedsSplitReason, string> = {
  first: 'over budget: back to the BA to split (the one return this card gets)',
  second_time: 'over budget again after it already went back to the BA once',
  inherited: 'over budget, and it was itself split out of a card that already went back to the BA',
  no_ba: 'over budget, but no BA is hired to split it',
  ba_failed: 'the BA could not split it',
  owner_again: 'the owner sent it to the BA again',
};

/** The once-only rule: the first return goes to the BA, a second one (or one with no BA) to the owner. */
export function needsSplitRoute(i: {
  taken: boolean;
  inherited?: boolean;
  force?: boolean;
  hasBa: boolean;
}): {
  route: 'ba' | 'owner';
  reason: NeedsSplitReason;
} {
  if (i.taken && !i.force) return { route: 'owner', reason: i.inherited ? 'inherited' : 'second_time' };
  if (!i.hasBa) return { route: 'owner', reason: 'no_ba' };
  return { route: 'ba', reason: i.force ? 'owner_again' : 'first' };
}

/** The needs-split record on a card (the projection of `CardNeedsSplitRequested`/`Resolved`). */
export const NeedsSplitRecordSchema = z.object({
  state: NeedsSplitState,
  reason: NeedsSplitReason,
  round: z.number().int(),
  fromStage: z.string(),
  requestedAt: z.string(),
  proposal: StoredNeedsSplitProposalSchema,
  taskId: z.string().nullable().default(null),
  deskItemId: z.string().nullable().default(null),
  inheritedFromCardId: z.string().nullable().default(null),
  childCardIds: z.array(z.string()).default([]),
  note: z.string().nullable().default(null),
});
export type NeedsSplitRecord = z.infer<typeof NeedsSplitRecordSchema>;

/** The proposal as plain text lines (thread note, desk question). */
export function needsSplitProposalLines(p: StoredNeedsSplitProposal, defaultRepo?: string): string[] {
  const out: string[] = [];
  out.push(`Folder scope: ${p.folderScope.join(', ')}`);
  out.push('Proposed seams:');
  p.seams.forEach((s, i) => {
    const repo = s.repo && s.repo !== defaultRepo ? ` [${s.repo}]` : '';
    out.push(`${i + 1}. ${s.title}${repo}: ${s.folders.join(', ')}${s.note ? ` (${s.note})` : ''}`);
  });
  if (p.estimate) out.push(`Estimate: ${p.estimate.size} ${p.estimate.unit}, budget ${p.estimate.budget}`);
  return out;
}
