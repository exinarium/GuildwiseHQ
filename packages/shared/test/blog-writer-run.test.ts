import { describe, expect, it } from 'vitest';
import { BlogWriterRunSchema } from '../src/index.ts';

const run = (kind: string) => ({
  id: '22222222-2222-4222-8222-222222222222',
  kind,
  status: 'ok',
  slot: 'video:article:first-post',
  topic: null,
  model: 'claude-haiku-4-5',
  startedAt: '2026-10-28T08:00:00.000Z',
  finishedAt: null,
  inputTokens: 1,
  outputTokens: 1,
  searches: 0,
  costUsd: 0.01,
  postId: null,
  slug: null,
  error: null,
});

describe('BlogWriterRunSchema', () => {
  it('knows the video kind of the hosted writer, and no other', () => {
    for (const k of ['scheduled', 'manual', 'release', 'video'])
      expect(BlogWriterRunSchema.safeParse(run(k)).success).toBe(true);
    expect(BlogWriterRunSchema.safeParse(run('nonsense')).success).toBe(false);
  });
});
