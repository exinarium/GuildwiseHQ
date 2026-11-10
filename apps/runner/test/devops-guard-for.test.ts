import type { ServerToRunnerOf } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { devopsGuardFor } from '../src/devops/requests.ts';

type Msg = ServerToRunnerOf<'shift.start'>;

const msg = (kind: string, isDevops: boolean, extra: object = {}): Msg =>
  ({
    shiftId: 'shift-1',
    kind,
    agent: { isDevops },
    brief: { project: { workingBranch: 'release/1.6.0' } },
    ...extra,
  }) as unknown as Msg;

describe('devopsGuardFor: which shifts run behind the DevOps guard hook', () => {
  it('guards the DevOps engineer’s own request shifts, protecting the working branch', () => {
    expect(devopsGuardFor(msg('devops', true))).toEqual({
      sessionRef: 'shift-1',
      protectedBranches: ['release/1.6.0'],
      approvedCommands: [],
    });
  });

  it('guards the DevOps engineer’s release prep shifts too (GWP-189: they run outside the sandbox)', () => {
    expect(devopsGuardFor(msg('release_prep', true))).toEqual({
      sessionRef: 'shift-1',
      protectedBranches: ['release/1.6.0'],
      approvedCommands: [],
    });
  });

  it('keeps a read-only scan read-only and carries approved commands', () => {
    const g = devopsGuardFor(
      msg('devops', true, { devops: { scan: true, approval: { commands: ['ssh x'] } } }),
    );
    expect(g).toMatchObject({ readOnlyScan: true, approvedCommands: ['ssh x'] });
  });

  it('gives no guard to a non-DevOps agent or to other shift kinds', () => {
    expect(devopsGuardFor(msg('release_prep', false))).toBeUndefined();
    expect(devopsGuardFor(msg('card', true))).toBeUndefined();
    expect(devopsGuardFor(msg('question', false))).toBeUndefined();
  });
});
