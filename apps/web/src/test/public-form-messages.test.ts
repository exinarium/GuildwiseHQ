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

  describe('malware scan', () => {
    it('a refused file gets the security message, never a signature, engine or path', () => {
      const m = d('malware_detected', false, 422);
      expect(m.text).toBe(
        'One of your files could not be accepted because it failed a security check. Please check the file and try again, or contact the firm.',
      );
      expect(m).toMatchObject({ retry: false, closed: false });
      expect(m.text).not.toMatch(/FOUND|clam|eicar|signature|\/|\\/i);
    });
    it('names the file the submitter chose when the error says which', () => {
      const m = describePublicError(
        { code: 'malware_detected', status: 422, retryable: false },
        'CV: cv.pdf',
      );
      expect(m.text).toContain('One of your files (CV: cv.pdf) could not be accepted');
    });
    it('an unavailable scan asks to try again later', () => {
      expect(d('scan_unavailable', true, 503)).toEqual({
        text: 'Your submission could not be checked right now. Please try again later.',
        retry: true,
        closed: false,
      });
    });
  });
});
