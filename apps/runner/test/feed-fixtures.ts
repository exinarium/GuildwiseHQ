import { BUILTIN_ROLES, type FeedItemInput, type ShiftBrief, uuidv7 } from '@aom/shared';
import { makeShiftStart } from './fixtures.ts';

export const feedItem = (n: number, over: Partial<FeedItemInput> = {}): FeedItemInput => ({
  kind: 'article',
  url: `https://news.example.test/story-${n}`,
  title: `Headline ${n}`,
  source: 'News Example',
  publishedAt: '2026-10-02',
  summary: `Summary ${n}`,
  ...over,
});

export interface FeedShiftOptions {
  stage: 'scan' | 'curate';
  fields?: Record<string, unknown>;
  feed?: ShiftBrief['feed'];
  shiftId?: string;
  vault?: { vaultId: string; kind: 'org' | 'project'; folder: string };
}

/** A `shift.start` for a feed card (scout at `scan`, curator at `curate`): no worktree, no repo. */
export function makeFeedShiftStart(o: FeedShiftOptions): Record<string, unknown> {
  const base = makeShiftStart({
    remoteNormalized: 'unused',
    ref: 'NEWS-1',
    title: 'News run',
    shiftId: o.shiftId,
  });
  const roleKey = o.stage === 'scan' ? 'scout' : 'curator';
  const role = BUILTIN_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error('role missing');
  const brief = base.brief as ShiftBrief;
  const outcomes: ShiftBrief['shift']['outcomes'] =
    o.stage === 'scan'
      ? [{ id: 'handoff', label: 'Hand off candidates', kind: 'success', data: 'candidates' }]
      : [{ id: 'digest', label: 'Post digest', kind: 'success', data: 'digest' }];
  const agent = base.agent as Record<string, unknown>;
  return {
    ...base,
    agent: { ...agent, roleKey, permissions: role.permissions },
    worktree: null,
    ...(o.vault ? { vault: o.vault } : {}),
    brief: {
      ...brief,
      shift: { ...brief.shift, stage: o.stage, stageLabel: o.stage === 'scan' ? 'Scan' : 'Curate', outcomes },
      card: {
        ...brief.card,
        id: uuidv7(),
        cardType: 'feed',
        fields: { topic: 'reloading', ...o.fields },
      },
      project: { ...brief.project, key: 'NEWS', name: 'News' },
      role: {
        key: role.key,
        name: role.name,
        instructions: role.instructions,
        coreRules: role.coreRules,
        skills: [],
      },
      ...(o.feed ? { feed: o.feed } : {}),
    },
  };
}
