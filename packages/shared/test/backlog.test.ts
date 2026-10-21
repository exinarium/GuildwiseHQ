import { describe, expect, it } from 'vitest';
import {
  BACKLOG_CARD_PRIORITY,
  BacklogFilter,
  type BacklogItemDto,
  BacklogSuggestParams,
  backlogContextBlock,
  CreateBacklogItemRequest,
  compareBacklog,
  filterBacklog,
  matchesBacklog,
  PatchBacklogItemRequest,
} from '../src/index.ts';

let n = 0;
function item(over: Partial<BacklogItemDto> = {}): BacklogItemDto {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: '11111111-1111-4111-8111-111111111111',
    projectKey: 'GWP',
    title: `Item ${n}`,
    description: '',
    priority: 'normal',
    tags: [],
    flagged: false,
    status: 'open',
    source: { kind: 'owner' },
    cardRef: null,
    cardId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    ...over,
  };
}

const filter = (f: Record<string, unknown> = {}) => BacklogFilter.parse(f);

describe('backlog requests', () => {
  it('defaults: Normal, no tags, not flagged', () => {
    const r = CreateBacklogItemRequest.parse({ title: '  Add dark mode  ' });
    expect(r).toEqual({ title: 'Add dark mode', description: '', priority: 'normal', tags: [], flagged: false });
  });
  it('rejects an empty or blank title and unknown priorities', () => {
    expect(CreateBacklogItemRequest.safeParse({ title: '' }).success).toBe(false);
    expect(CreateBacklogItemRequest.safeParse({ title: '   ' }).success).toBe(false);
    expect(CreateBacklogItemRequest.safeParse({ title: 'x', priority: 'urgent' }).success).toBe(false);
  });
  it('lower-cases and de-duplicates tags', () => {
    const r = CreateBacklogItemRequest.parse({ title: 'x', tags: ['UI', 'ui', ' Onboarding '] });
    expect(r.tags).toEqual(['ui', 'onboarding']);
  });
  it('the patch is strict: status, source and the linked card are refused', () => {
    expect(PatchBacklogItemRequest.safeParse({ title: 'ok', flagged: true }).success).toBe(true);
    for (const bad of [{ status: 'done' }, { source: { kind: 'agent' } }, { cardRef: 'GWP-1' }, { cardId: 'x' }])
      expect(PatchBacklogItemRequest.safeParse(bad).success).toBe(false);
  });
  it('an agent suggestion carries no source, agent, card, status or flag', () => {
    expect(BacklogSuggestParams.safeParse({ title: 'Follow up', tags: ['a'], priority: 'low' }).success).toBe(true);
    for (const bad of [{ source: 'owner' }, { agentName: 'Ada' }, { cardRef: 'GWP-1' }, { status: 'done' }, { flagged: true }, { itemId: 'x' }])
      expect(BacklogSuggestParams.safeParse({ title: 't', ...bad }).success).toBe(false);
  });
});

describe('backlog filter', () => {
  it('shows Open items only by default', () => {
    const items = [item(), item({ status: 'done' }), item({ status: 'dropped' })];
    expect(filterBacklog(items, filter()).map((i) => i.status)).toEqual(['open']);
    expect(filterBacklog(items, filter({ status: 'done' })).map((i) => i.status)).toEqual(['done']);
    expect(filterBacklog(items, filter({ status: 'open,dropped' }))).toHaveLength(2);
  });
  it('filters by priority, tag (all given), flagged and source', () => {
    const a = item({ priority: 'high', tags: ['ui', 'x'], flagged: true });
    const b = item({ priority: 'low', tags: ['ui'] });
    const c = item({ source: { kind: 'agent', agentId: '22222222-2222-4222-8222-222222222222', agentName: 'Ada', cardRef: 'GWP-3' } });
    const all = [a, b, c];
    expect(filterBacklog(all, filter({ priority: 'high,critical' }))).toEqual([a]);
    expect(filterBacklog(all, filter({ tag: 'ui' }))).toHaveLength(2);
    expect(filterBacklog(all, filter({ tag: 'ui,x' }))).toEqual([a]);
    expect(filterBacklog(all, filter({ flagged: 'true' }))).toEqual([a]);
    expect(filterBacklog(all, filter({ flagged: 'false' }))).toHaveLength(2);
    expect(filterBacklog(all, filter({ source: 'agent' }))).toEqual([c]);
    expect(filterBacklog(all, filter({ source: 'owner' }))).toHaveLength(2);
  });
  it('combines filters', () => {
    const a = item({ priority: 'high', tags: ['ui'], flagged: true });
    const b = item({ priority: 'high', tags: ['ui'] });
    const c = item({ priority: 'low', tags: ['ui'], flagged: true });
    expect(filterBacklog([a, b, c], filter({ tag: 'ui', flagged: true, priority: 'high' }))).toEqual([a]);
  });
  it('searches the title, the description and the tags, ignoring case', () => {
    const t = item({ title: 'Dark Mode' });
    const d = item({ description: 'needs a darker palette' });
    const g = item({ tags: ['darkroom'] });
    const none = item({ title: 'Other' });
    expect(filterBacklog([t, d, g, none], filter({ q: 'DARK' }))).toHaveLength(3);
    expect(matchesBacklog(none, filter({ q: 'dark' }))).toBe(false);
  });
});

describe('backlog sort', () => {
  it('priority: Critical, High, Normal, Low, newest first within a priority', () => {
    const low = item({ priority: 'low' });
    const n1 = item({ priority: 'normal' });
    const n2 = item({ priority: 'normal' });
    const crit = item({ priority: 'critical' });
    const high = item({ priority: 'high' });
    const sorted = [low, n1, n2, crit, high].sort(compareBacklog('priority'));
    expect(sorted).toEqual([crit, high, n2, n1, low]);
  });
  it('created: newest first', () => {
    const a = item();
    const b = item({ priority: 'critical' });
    const c = item({ priority: 'low' });
    expect(filterBacklog([a, b, c], filter({ sort: 'created' }))).toEqual([c, b, a]);
  });
});

describe('Send to BA mapping', () => {
  it('maps backlog priorities onto the four card priority levels', () => {
    expect(BACKLOG_CARD_PRIORITY).toEqual({ critical: 1, high: 3, normal: 5, low: 8 });
  });
  it('puts priority and tags after the description', () => {
    const text = backlogContextBlock({
      title: 'T',
      description: 'Do the thing',
      priority: 'high',
      tags: ['ui', 'onboarding'],
      source: { kind: 'owner' },
    });
    expect(text).toBe('Do the thing\n\n---\nFrom the project backlog. Priority: High. Tags: ui, onboarding.');
  });
  it('uses the title without a description, leaves out empty tags and names the suggesting agent', () => {
    const text = backlogContextBlock({
      title: 'Only a title',
      description: '  ',
      priority: 'low',
      tags: [],
      source: { kind: 'agent', agentId: '22222222-2222-4222-8222-222222222222', agentName: 'Ada', cardRef: 'GWP-3' },
    });
    expect(text).toBe(
      'Only a title\n\n---\nFrom the project backlog. Priority: Low. Suggested by Ada while working on GWP-3.',
    );
  });
});
