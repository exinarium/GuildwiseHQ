import { describe, expect, it } from 'vitest';
import {
  COMPLETION_ACTION_LABELS,
  CompletionAction,
  CreateCardRequestSchema,
  FinalizeAction,
  FinalizeCardRequestSchema,
  PatchCardRequestSchema,
  StoredCompletionAction,
  StoredFinalizeAction,
} from '../src/index.ts';

describe('push_branch is retired (backlog #61)', () => {
  it('commands offer pr and merge only', () => {
    expect(CompletionAction.options).toEqual(['pr', 'merge']);
    expect(FinalizeAction.options).toEqual(['pr', 'merge', 'none']);
    expect(CompletionAction.safeParse('push_branch').success).toBe(false);
    expect(FinalizeAction.safeParse('push_branch').success).toBe(false);
  });

  it('request bodies refuse it', () => {
    const create = { projectId: '0192f3a0-0000-7000-8000-000000000001', title: 't', cardType: 'feature' };
    expect(CreateCardRequestSchema.safeParse({ ...create, completionAction: 'pr' }).success).toBe(true);
    expect(CreateCardRequestSchema.safeParse({ ...create, completionAction: 'push_branch' }).success).toBe(
      false,
    );
    expect(PatchCardRequestSchema.safeParse({ completionAction: 'push_branch' }).success).toBe(false);
    expect(PatchCardRequestSchema.safeParse({ completionAction: null }).success).toBe(true);
    expect(FinalizeCardRequestSchema.safeParse({ action: 'push_branch' }).success).toBe(false);
  });

  it('old events and rows still parse', () => {
    expect(StoredCompletionAction.safeParse('push_branch').success).toBe(true);
    expect(StoredFinalizeAction.safeParse('push_branch').success).toBe(true);
    expect(COMPLETION_ACTION_LABELS.push_branch.label).toMatch(/retired/);
  });
});
