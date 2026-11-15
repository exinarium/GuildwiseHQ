import { z } from 'zod';
import { type SizeUnit, SizeUnitSchema } from '../projects/review-settings.ts';
import { sizeUnitWord } from './size-check.ts';

/**
 * A size exception: the CEO agent asks the owner, with a reason, to let an over-budget pull request stay as one pull
 * request. The owner approves or rejects. With no answer in 2 working days the request lapses and the pull request goes
 * back to its author to split; the owner is never reminded (it is deliberately not an owner-pending timer).
 */
export const SIZE_EXCEPTION_SUBKIND = 'size_exception';
/** The reason the owner reads must say something: fewer characters than this (after trimming) is refused. */
export const SIZE_EXCEPTION_REASON_MIN = 20;
export const SIZE_EXCEPTION_LAPSE_WORKING_DAYS = 2;
export const SIZE_EXCEPTION_STATES = [
  'pending',
  'approved',
  'rejected',
  'lapsed',
  'withdrawn',
  'superseded',
] as const;
export const SizeExceptionStateSchema = z.enum(SIZE_EXCEPTION_STATES);
export type SizeExceptionState = z.infer<typeof SizeExceptionStateSchema>;

export const SizeExceptionReason = z
  .string()
  .trim()
  .min(
    SIZE_EXCEPTION_REASON_MIN,
    `give the reason this pull request may stay over budget (at least ${SIZE_EXCEPTION_REASON_MIN} characters)`,
  )
  .max(2000);

/** `aom ceo act size-exception --pr <id|url> --text "<reason>"`: the owner-facing reason is `--text`. */
export const SizeExceptionParamsSchema = z
  .object({
    pr: z.string().trim().min(1).max(500),
    text: SizeExceptionReason,
  })
  .strict();
export type SizeExceptionParams = z.infer<typeof SizeExceptionParamsSchema>;

export const SizeExceptionDtoSchema = z.object({
  id: z.uuid(),
  prReviewId: z.uuid(),
  prUrl: z.string(),
  changeId: z.string(),
  repoName: z.string(),
  chainPrReviewIds: z.array(z.uuid()),
  size: z.number().int(),
  budget: z.number().int(),
  unit: SizeUnitSchema,
  reason: z.string(),
  state: SizeExceptionStateSchema,
  requestedAt: z.string(),
  dueAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  note: z.string().nullable(),
});
export type SizeExceptionDto = z.infer<typeof SizeExceptionDtoSchema>;

/** What the sweep does with a request: lapse it (due), withdraw it (the pull request closed), or leave it. Pure. */
export function sizeExceptionDue(
  r: { state: string; dueAt: Date; prClosed: boolean },
  now: Date,
): 'lapse' | 'withdraw' | null {
  if (r.state !== 'pending') return null;
  if (r.prClosed) return 'withdraw';
  return now.getTime() >= r.dueAt.getTime() ? 'lapse' : null;
}

/** An approved exception covers the pull request only up to the approved size. */
export function exemptionCovers(
  e: { state: string; size: number } | null | undefined,
  currentSize: number,
): boolean {
  return !!e && e.state === 'approved' && currentSize <= e.size;
}

export function sizeExceptionDeskText(i: {
  changeId: string;
  repoName: string;
  size: number;
  budget: number;
  unit: SizeUnit;
  reason: string;
  dueAt: Date;
}): { title: string; body: string } {
  const title =
    `Size exception: PR #${i.changeId} in ${i.repoName} (${i.size} of ${i.budget} ${sizeUnitWord(i.unit)})`.slice(
      0,
      280,
    );
  const body = [
    i.reason,
    '',
    'Approve to keep it as one pull request, reject to send it back to its author to split.',
    `If you do not answer by ${i.dueAt.toISOString().slice(0, 10)}, it goes back to the author to split; you will not be reminded.`,
  ].join('\n');
  return { title, body };
}

export const SizeExceptionsQuerySchema = z.object({ state: SizeExceptionStateSchema.optional() });
