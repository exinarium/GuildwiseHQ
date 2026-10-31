import { describe, expect, it } from 'vitest';
import { releaseStatusLine } from '../components/WorkingBranchControl.tsx';

const base = { deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1', version: '1.4.0' };
const ship = {
  version: '1.4.0',
  step: null,
  commit: null,
  error: null,
  branch: 'develop',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

describe('releaseStatusLine', () => {
  it('waiting for the owner', () => {
    expect(releaseStatusLine({ ...base, state: 'proposed' })).toBe('Ship release waiting on the desk');
  });
  it('preparing the commit (no ship row yet, or committing)', () => {
    expect(releaseStatusLine({ ...base, state: 'approved' })).toBe(
      'Release 1.4.0: preparing the release commit…',
    );
    expect(
      releaseStatusLine({ ...base, state: 'approved', ship: { ...ship, status: 'committing' } }),
    ).toContain('preparing');
  });
  it('pushed, in the release PR', () => {
    expect(
      releaseStatusLine({
        ...base,
        state: 'approved',
        ship: { ...ship, status: 'committed', commit: 'abcdef1234567' },
      }),
    ).toBe('Release commit abcdef1 pushed to develop, in the release PR');
  });
  it("stopped at a step with the first line of git's message", () => {
    expect(
      releaseStatusLine({
        ...base,
        state: 'approved',
        ship: { ...ship, status: 'failed', step: 'push', error: '\nremote: policy says no\nmore' },
      }),
    ).toBe('Release 1.4.0 stopped at push: remote: policy says no (Retry on the desk)');
  });
});
