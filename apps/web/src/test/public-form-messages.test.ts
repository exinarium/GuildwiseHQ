import { describe, expect, it } from 'vitest';
import { describePublicError } from '../public-form/messages.ts';

const d = (code: string, retryable = false, status = 400) => describePublicError({ code, status, retryable });

describe('describePublicError', () => {
  it('closed forms and links are final and say what to do', () => {
    expect(d('form_not_available')).toEqual({
      text: 'This form is not available.',
      retry: false,
      closed: true,
    });
    expect(d('link_expired').text).toMatch(/expired.*Ask the firm for a new one/);
    expect(d('link_revoked').text).toMatch(/no longer valid/);
    expect(d('link_used').text).toMatch(/already used/);
    expect(d('destination_missing')).toMatchObject({ closed: true, retry: false });
  });

  it('storage and connection trouble can be retried without retyping', () => {
    for (const code of ['storage_failed', 'runner_offline', 'network', 'rate_limited']) {
      const m = d(code, true);
      expect(m.retry).toBe(true);
      expect(m.closed).toBe(false);
    }
    expect(d('storage_failed', true).text).toContain('Your answers are still here');
    expect(d('runner_offline', true).text).toMatch(/try again later/i);
    expect(d('storage_failed', false)).toMatchObject({ retry: false, closed: true });
  });

  it('never repeats anything the server sent beyond its code', () => {
    expect(d('something_new_and_odd', false, 500).text).toBe(
      'Something went wrong. Your answers are still here. Try again.',
    );
  });
});
