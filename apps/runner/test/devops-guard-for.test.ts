import type { ServerToRunnerOf } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { devopsGuardFor, guardedShift } from '../src/devops/requests.ts';

type Msg = ServerToRunnerOf<'shift.start'>;

const msg = (kind: string, isDevops: boolean, extra: object = {}): Msg =>
  ({
    shiftId: 'shift-1',
    kind,
    agent: { isDevops },
    brief: { project: { workingBranch: 'release/1.6.0' } },
    ...extra,
  }) as unknown as Msg;

const prep = (isDevops = true, extra: object = {}) =>
  msg('release_prep', isDevops, { releasePrep: { releaseBranch: 'release/1.6.0' }, ...extra });

describe('guardedShift: which shifts run behind the DevOps guard hook', () => {
  it('is true for devops and release_prep shifts of a DevOps agent only', () => {
    expect(guardedShift(msg('devops', true))).toBe(true);
    expect(guardedShift(prep(true))).toBe(true);
    for (const kind of ['card', 'question', 'ba_task', 'ceo']) expect(guardedShift(msg(kind, true))).toBe(false);
    expect(guardedShift(prep(false))).toBe(false);
    expect(guardedShift(msg('devops', false))).toBe(false);
  });
});

describe('devopsGuardFor: the guard settings of a shift', () => {
  it('guards the DevOps engineer’s own request shifts, protecting the working branch', () => {
    expect(devopsGuardFor(msg('devops', true))).toEqual({
      sessionRef: 'shift-1',
      shiftKind: 'devops',
      protectedBranches: ['release/1.6.0'],
      approvedCommands: [],
    });
  });

  it('freezes the release branch of a release prep shift and pre-approves nothing', () => {
    expect(devopsGuardFor(prep())).toEqual({
      sessionRef: 'shift-1',
      shiftKind: 'release_prep',
      protectedBranches: ['release/1.6.0'],
      frozenBranches: ['release/1.6.0'],
      approvedCommands: [],
    });
  });

  it('takes the release branch from the release prep, not from the brief, and ignores stray approvals', () => {
    const g = devopsGuardFor(
      msg('release_prep', true, {
        releasePrep: { releaseBranch: ' release/2.0.0 ' },
        devops: { approval: { commands: ['ssh x'] } },
      }),
    );
    expect(g?.protectedBranches).toEqual(['release/2.0.0']);
    expect(g?.frozenBranches).toEqual(['release/2.0.0']);
    expect(g?.approvedCommands).toEqual([]);
  });

  it('gives no guard to a release prep without its release branch', () => {
    expect(devopsGuardFor(msg('release_prep', true, { releasePrep: {} }))).toBeUndefined();
    expect(devopsGuardFor(msg('release_prep', true))).toBeUndefined();
  });

  it('keeps a read-only scan read-only and carries approved commands (devops shifts have no frozen branches)', () => {
    const g = devopsGuardFor(
      msg('devops', true, { devops: { scan: true, approval: { commands: ['ssh x'] } } }),
    );
    expect(g).toMatchObject({ readOnlyScan: true, approvedCommands: ['ssh x'] });
    expect(g?.frozenBranches).toBeUndefined();
  });

  it('gives no guard to a non-DevOps agent or to other shift kinds', () => {
    expect(devopsGuardFor(prep(false))).toBeUndefined();
    expect(devopsGuardFor(msg('card', true))).toBeUndefined();
    expect(devopsGuardFor(msg('question', false))).toBeUndefined();
  });
});
