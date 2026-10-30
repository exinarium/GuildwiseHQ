import { describe, expect, it } from 'vitest';
import {
  EditLedgerEntryRequestSchema,
  CreateLedgerEntryRequestSchema,
  isReviewDue,
  LedgerEntryDtoSchema,
  ledgerToday,
  renderStandingOrderBlock,
} from '../src/index.ts';

describe('isReviewDue', () => {
  const today = '2026-10-30';
  it.each([
    ['yesterday', '2026-10-29', {}, true],
    ['today', '2026-10-30', {}, true],
    ['tomorrow', '2026-10-31', {}, false],
    ['no date', null, {}, false],
    ['retired', '2026-10-01', { retired: true }, false],
    ['superseded', '2026-10-01', { superseded: true }, false],
  ])('%s', (_n, reviewDate, flags, due) => {
    expect(isReviewDue({ reviewDate, ...flags }, today)).toBe(due);
  });
  it('ledgerToday is the UTC calendar date', () => {
    expect(ledgerToday(new Date('2026-10-30T23:59:59Z'))).toBe('2026-10-30');
    expect(ledgerToday(new Date('2026-10-31T00:00:00Z'))).toBe('2026-10-31');
  });
});

describe('renderStandingOrderBlock', () => {
  it('is unchanged without a review date', () => {
    const old = `\n## T\n\nbody\n\n_Added 2026-10-01._\n`;
    expect(renderStandingOrderBlock({ title: ' T ', body: ' body ', addedDay: '2026-10-01' })).toBe(old);
    expect(renderStandingOrderBlock({ title: 'T', body: 'body', addedDay: '2026-10-01', reviewDate: null })).toBe(old);
  });
  it('adds the review date line', () => {
    expect(
      renderStandingOrderBlock({ title: 'T', body: 'body', addedDay: '2026-10-01', reviewDate: '2027-01-01' }),
    ).toBe(`\n## T\n\nbody\n\n_Added 2026-10-01._\n_Review by 2027-01-01._\n`);
  });
});

describe('ledger review date schemas', () => {
  it('accepts a calendar date and rejects other text', () => {
    const base = { scope: 'standing_order', title: 't', body: 'b' };
    expect(CreateLedgerEntryRequestSchema.safeParse({ ...base, reviewDate: '2027-01-01' }).success).toBe(true);
    expect(CreateLedgerEntryRequestSchema.safeParse({ ...base, reviewDate: 'soon' }).success).toBe(false);
  });
  it('an edit with only a review date (or null) is valid; an empty edit is not', () => {
    expect(EditLedgerEntryRequestSchema.safeParse({ reviewDate: null }).success).toBe(true);
    expect(EditLedgerEntryRequestSchema.safeParse({ reviewDate: '2027-01-01' }).success).toBe(true);
    expect(EditLedgerEntryRequestSchema.safeParse({}).success).toBe(false);
  });
  it('an old DTO without review fields still parses with defaults', () => {
    const r = LedgerEntryDtoSchema.parse({
      id: crypto.randomUUID(), scope: 'decision', projectId: null, projectKey: null, cardId: null, cardRef: null,
      title: 't', body: 'b', tags: [], sourceDeskItemId: null, vaultPath: null, createdByKind: 'user',
      createdByName: null, supersededBy: null, createdAt: new Date().toISOString(),
    });
    expect(r.reviewDate).toBeNull();
    expect(r.reviewDue).toBe(false);
  });
});
