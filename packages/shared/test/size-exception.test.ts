import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  CEO_ACTIONS,
  CEO_CLI_HELP,
  DEFAULT_CEO_POLICY,
  exemptionCovers,
  FOLLOW_UP_SKIP_SUBKINDS,
  SIZE_EXCEPTION_REASON_MIN,
  SizeExceptionParamsSchema,
  SPLIT_REASONS,
  sizeExceptionDue,
  splitNoticeBody,
} from '../src/index.ts';

describe('AC5: a request without a reason is refused', () => {
  const pr = 'https://github.com/acme/toy/pull/9';
  it('refuses a missing, blank or short text and accepts the minimum', () => {
    expect(SizeExceptionParamsSchema.safeParse({ pr }).success).toBe(false);
    expect(SizeExceptionParamsSchema.safeParse({ pr, text: '' }).success).toBe(false);
    expect(SizeExceptionParamsSchema.safeParse({ pr, text: ' '.repeat(40) }).success).toBe(false);
    expect(SizeExceptionParamsSchema.safeParse({ pr, text: 'x'.repeat(SIZE_EXCEPTION_REASON_MIN - 1) }).success).toBe(false);
    expect(SizeExceptionParamsSchema.safeParse({ pr, text: 'x'.repeat(SIZE_EXCEPTION_REASON_MIN) }).success).toBe(true);
    expect(SizeExceptionParamsSchema.safeParse({ pr, text: `  ${'x'.repeat(19)}  ` }).success).toBe(false);
  });
});

describe('the timer rule', () => {
  const due = new Date('2030-03-05T15:00:00Z');
  it('lapses at the due instant and not before, withdraws a closed PR, and ignores decided requests', () => {
    expect(sizeExceptionDue({ state: 'pending', dueAt: due, prClosed: false }, new Date('2030-03-05T14:59:59Z'))).toBeNull();
    expect(sizeExceptionDue({ state: 'pending', dueAt: due, prClosed: false }, due)).toBe('lapse');
    expect(sizeExceptionDue({ state: 'pending', dueAt: due, prClosed: true }, new Date('2030-03-01T00:00:00Z'))).toBe('withdraw');
    expect(sizeExceptionDue({ state: 'approved', dueAt: due, prClosed: false }, new Date('2031-01-01T00:00:00Z'))).toBeNull();
  });
  it('an approval covers the approved size and no more', () => {
    expect(exemptionCovers({ state: 'approved', size: 900 }, 900)).toBe(true);
    expect(exemptionCovers({ state: 'approved', size: 900 }, 901)).toBe(false);
    expect(exemptionCovers({ state: 'rejected', size: 900 }, 100)).toBe(false);
    expect(exemptionCovers(null, 100)).toBe(false);
  });
});

describe('wiring', () => {
  it('the CEO has the action, class and help; the default is decide', () => {
    expect(CEO_ACTIONS).toContain('size-exception');
    expect(ACTION_CLASSES).toContain('pr.request_size_exception');
    expect(JSON.stringify(DEFAULT_CEO_POLICY.classes['pr.request_size_exception'])).toContain('decide');
    expect(CEO_CLI_HELP).toContain('size-exception --pr');
  });
  it('the follow-up chase skips it, so the owner is never reminded', () => {
    expect(FOLLOW_UP_SKIP_SUBKINDS).toContain('size_exception');
  });
  it('the split reasons and the notice body know it', () => {
    expect(SPLIT_REASONS).toContain('size_exception_rejected');
    expect(SPLIT_REASONS).toContain('size_exception_lapsed');
    const base = { unit: 'changed_lines' as const, budget: 600, total: 900, members: [], self: '1', noticeId: 'n' };
    expect(splitNoticeBody({ ...base, reason: 'size_exception_lapsed' })).toContain('size exception');
    expect(splitNoticeBody({ ...base, reason: 'over_budget' })).not.toContain('size exception');
  });
});
