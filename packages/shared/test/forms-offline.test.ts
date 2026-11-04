import { describe, expect, it } from 'vitest';
import { OfflineRequestSchema, offlineNoticeText } from '../src/index.ts';

describe('offlineNoticeText', () => {
  it('names the client, form and journey, and never an email address', () => {
    const t = offlineNoticeText({
      kind: 'sent',
      formTitle: 'Rental application',
      clientReference: 'CL-1042',
      recordName: 'Ann Client',
      journeyName: 'Rentals',
    });
    expect(t.title).toBe('Secure link sent: Rental application (CL-1042, Ann Client)');
    expect(t.body).toContain('Rentals');
    expect(`${t.title} ${t.body}`).not.toContain('@');
  });

  it('calls a public-URL visitor "a visitor of the public form"', () => {
    const t = offlineNoticeText({ kind: 'sent', formTitle: 'Contact', clientReference: null });
    expect(t.title).toBe('Secure link sent: Contact (a visitor of the public form)');
  });

  it('says what happened when the hold ran out, sending failed or the link expired', () => {
    const base = { formTitle: 'F', clientReference: 'C1' };
    expect(offlineNoticeText({ ...base, kind: 'hold_expired', holdDays: 7 }).body).toContain(
      'offline for 7 days',
    );
    expect(offlineNoticeText({ ...base, kind: 'failed' }).body).toContain('could not email');
    expect(offlineNoticeText({ ...base, kind: 'link_expired' }).body).toContain('expired unused');
    expect(offlineNoticeText({ ...base, kind: 'cancelled' }).body).toContain('cancelled');
  });
});

describe('OfflineRequestSchema', () => {
  const ok = { session: 'x'.repeat(20), nonce: '0', website: '', email: 'a@b.example' };
  it('takes a session, a proof and one email address, nothing else', () => {
    expect(OfflineRequestSchema.safeParse(ok).success).toBe(true);
    expect(OfflineRequestSchema.safeParse({ ...ok, answers: { a: 1 } }).success).toBe(false);
    expect(OfflineRequestSchema.safeParse({ ...ok, email: 'not-an-email' }).success).toBe(false);
    expect(OfflineRequestSchema.safeParse({ ...ok, email: `${'a'.repeat(250)}@b.example` }).success).toBe(
      false,
    );
  });
});
