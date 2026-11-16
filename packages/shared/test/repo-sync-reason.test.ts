import { describe, expect, it } from 'vitest';
import {
  isQuietRepoSyncReason,
  REPO_SYNC_REASON_TEXT,
  RepoSyncDtoSchema,
  RepoSyncReasonSchema,
  RepoSyncStatusSchema,
} from '../src/index.ts';

const base = {
  repoId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  workingBranch: 'main',
  state: 'behind',
  ahead: 0,
  behind: 2,
  dirty: false,
  onBranch: false,
  checkedOutBranch: 'feature',
  checkedAt: '2026-11-16T10:00:00.000Z',
};

describe('repo sync reason', () => {
  it('accepts a status without reason fields (an older runner)', () => {
    const s = RepoSyncStatusSchema.parse(base);
    expect(s.reason).toBeUndefined();
    expect(s.reasonMessage).toBeUndefined();
  });

  it('keeps a known reason and its message', () => {
    const s = RepoSyncStatusSchema.parse({
      ...base,
      reason: 'checked-out-elsewhere',
      reasonMessage: 'main is checked out in another worktree (~/wt2)',
    });
    expect(s.reason).toBe('checked-out-elsewhere');
    expect(s.reasonMessage).toContain('~/wt2');
  });

  it('drops an unknown reason code but keeps the status (a newer runner)', () => {
    const r = RepoSyncStatusSchema.safeParse({ ...base, reason: 'future-code', reasonMessage: 'x' });
    expect(r.success).toBe(true);
    expect(r.data?.reason).toBeUndefined();
    expect(r.data?.reasonMessage).toBe('x');
  });

  it('drops a message over 400 characters rather than the whole status', () => {
    const r = RepoSyncStatusSchema.safeParse({ ...base, reason: 'diverged', reasonMessage: 'x'.repeat(401) });
    expect(r.success).toBe(true);
    expect(r.data?.reason).toBe('diverged');
    expect(r.data?.reasonMessage).toBeUndefined();
  });

  it('reaches the API type', () => {
    const { repoId: _r, ...dto } = base;
    const d = RepoSyncDtoSchema.parse({ ...dto, reason: 'shift-running', reasonMessage: 'm' });
    expect(d.reason).toBe('shift-running');
  });

  it('treats up-to-date and local-ahead as quiet', () => {
    expect(isQuietRepoSyncReason('up-to-date')).toBe(true);
    expect(isQuietRepoSyncReason('local-ahead')).toBe(true);
    expect(isQuietRepoSyncReason('checked-out-elsewhere')).toBe(false);
    expect(isQuietRepoSyncReason(undefined)).toBe(false);
    expect(isQuietRepoSyncReason(null)).toBe(false);
  });

  it('has a non-empty fallback text for every code', () => {
    for (const code of RepoSyncReasonSchema.options)
      expect(REPO_SYNC_REASON_TEXT[code].length).toBeGreaterThan(0);
  });
});
