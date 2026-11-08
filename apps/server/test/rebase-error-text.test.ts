import { FinalizeResultSchema, PROTOCOL_VERSION, RunStatusSchema, ShiftRejectedSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  finalizeFailureText,
  isRealConflict,
  rebaseConflictText,
  rebaseErrorText,
} from '../src/commands/rebase.ts';

const lockError = {
  baseRef: 'origin/release/1.4.0',
  command: 'git rebase origin/release/1.4.0',
  exitCode: 1,
  stderr: "fatal: Unable to create '/repo/.git/worktrees/GWP-27/index.lock': File exists.",
};

const neverAConflict = (text: string) => {
  expect(text).not.toMatch(/conflicted/i);
  expect(text).not.toContain('could not list the files');
};

describe('isRealConflict', () => {
  it('is a conflict only with at least one file', () => {
    expect(isRealConflict(['a.ts'])).toBe(true);
    expect(isRealConflict([])).toBe(false);
    expect(isRealConflict(undefined)).toBe(false);
    expect(isRealConflict(null)).toBe(false);
  });
});

describe('rebaseConflictText (a real conflict)', () => {
  it('keeps the wording and lists the files', () => {
    expect(rebaseConflictText('finalize', 'release/1.4.0', ['a.ts', 'b.ts'])).toBe(
      'Rebase onto release/1.4.0 conflicted before the finalize stage. The card is back in Rework for its builder; conflicted files:\n- a.ts\n- b.ts',
    );
  });

  it('can no longer say the runner could not list the files', () => {
    expect(rebaseConflictText('test', 'main', [])).not.toContain('could not list the files');
  });
});

describe('rebaseErrorText (a rebase error)', () => {
  it('names the base branch, the command, the exit code and quotes git', () => {
    const text = rebaseErrorText('finalize', 'release/1.4.0', { rebaseError: lockError });
    expect(text).toContain('release/1.4.0');
    expect(text).toContain('`git rebase origin/release/1.4.0` exited 1');
    expect(text).toContain(lockError.stderr);
    expect(text).toContain('not sent back to Rework');
    neverAConflict(text);
  });

  it('without a structured report uses the runner detail', () => {
    const text = rebaseErrorText('test', 'main', { detail: 'git rebase main failed: could not detach HEAD' });
    expect(text).toContain('main');
    expect(text).toContain('Git said: git rebase main failed: could not detach HEAD');
    neverAConflict(text);
  });

  it("an older runner's file-less conflict: says no files were listed, drops the empty message", () => {
    const text = rebaseErrorText('test', '', { detail: 'rebase conflict in ', fileLessConflict: true });
    expect(text).toContain('the working branch');
    expect(text).toContain('git listed no conflicting files, so this is not a code conflict');
    expect(text).toContain('Git gave no message.');
    expect(text).not.toContain('rebase conflict in');
    neverAConflict(text);
  });
});

describe('finalizeFailureText', () => {
  it('a rebase error: names the base and git, never a conflict', () => {
    const text = finalizeFailureText('merge', 'release/1.4.0', {
      error: 'rebase onto origin/release/1.4.0 failed: ...',
      rebaseError: lockError,
    });
    expect(text).toMatch(
      /^Finalize \(merge\) did not land\. Updating the card branch with release\/1\.4\.0 failed/,
    );
    expect(text).toContain(lockError.stderr);
    neverAConflict(text);
  });

  it("an older runner's conflict:true without files is an error, not a file-less conflict", () => {
    const text = finalizeFailureText('merge', 'release/1.4.0', {
      conflict: true,
      conflictedFiles: [],
      error: 'merge conflict in ',
    });
    expect(text).toContain('release/1.4.0');
    expect(text).toContain('not a code conflict');
    neverAConflict(text);
  });

  it('any other failure keeps the old text', () => {
    expect(finalizeFailureText('pr', 'main', { error: 'git push failed: denied' })).toBe(
      'Finalize (pr) failed: git push failed: denied',
    );
    expect(finalizeFailureText('merge', 'main', null, 'runner offline')).toBe(
      'Finalize (merge) failed: runner offline',
    );
  });
});

describe('the rebaseError field on the wire (backward compatible)', () => {
  it('is optional on the three payloads and parsed when present', () => {
    expect(
      FinalizeResultSchema.parse({ ok: false, action: 'merge', error: 'x' }).rebaseError,
    ).toBeUndefined();
    expect(
      FinalizeResultSchema.parse({ ok: false, action: 'merge', error: 'x', rebaseError: lockError })
        .rebaseError,
    ).toEqual(lockError);
    const shiftId = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
    expect(
      ShiftRejectedSchema.parse({
        v: PROTOCOL_VERSION,
        id: 'm1',
        ts: '2026-11-08T12:00:00.000Z',
        type: 'shift.rejected',
        shiftId,
        reason: 'worktree_failed',
        rebaseError: lockError,
      }).rebaseError,
    ).toEqual(lockError);
    expect(
      RunStatusSchema.parse({ envId: shiftId, state: 'failed', rebaseError: lockError }).rebaseError,
    ).toEqual(lockError);
    expect(() =>
      FinalizeResultSchema.parse({
        ok: false,
        action: 'merge',
        rebaseError: { ...lockError, stderr: 'x'.repeat(2001) },
      }),
    ).toThrow();
  });
});
