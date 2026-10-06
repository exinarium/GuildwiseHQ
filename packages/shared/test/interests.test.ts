import { describe, expect, it } from 'vitest';
import {
  applyManagedSection,
  CreateInterestRequestSchema,
  DomainEventSchema,
  defaultWindowHours,
  type InterestBody,
  interestCardTemplate,
  renderShiftPrompt,
  renderTasteSeedSection,
  researchCardDefaults,
  scheduleEnabled,
  scheduleSyncPlan,
  stripManagedSection,
  suggestProjectKey,
  TASTE_HEADER,
  VaultWriteCommandSchema,
} from '../src/index.ts';
import { buildBrief } from './fixtures.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = (over: Partial<InterestBody> = {}): InterestBody => ({
  interestId: uuid(1),
  orgId: uuid(2),
  name: 'Rust async',
  description: '',
  feedProjectId: uuid(3),
  researchProjectId: null,
  subCategory: null,
  preferredSites: [],
  scan: { cron: '0 7 * * *', timezone: 'UTC', windowHours: 24, maxItems: 10, manual: false },
  status: 'active',
  scheduleId: uuid(4),
  ...over,
});

describe('interestCardTemplate', () => {
  it('derives a feed card template with defaults and omits empty fields', () => {
    expect(interestCardTemplate(base())).toEqual({
      title: 'Rust async',
      cardType: 'feed',
      fields: { topic: 'Rust async', windowHours: 24, maxItems: 10 },
    });
  });
  it('carries description, sites, sub-category and scan values', () => {
    const t = interestCardTemplate(
      base({
        description: ' Deep dives. ',
        preferredSites: ['lobste.rs', ' '],
        subCategory: 'rust/async',
        scan: { cron: '0 * * * *', timezone: 'UTC', windowHours: 1, maxItems: 5, manual: false },
      }),
    );
    expect(t.fields).toEqual({
      topic: 'Rust async',
      description: 'Deep dives.',
      windowHours: 1,
      preferredSites: ['lobste.rs'],
      maxItems: 5,
      subCategory: 'rust/async',
    });
  });
});

describe('defaultWindowHours', () => {
  it.each([
    ['0 * * * *', 1],
    ['0 7 * * *', 24],
    ['0 7 * * 1-5', 24],
    ['0 7 * * 1', 168],
    ['0 7 1 * *', 24],
    ['bad', 24],
  ])('%s -> %i', (cron, hours) => expect(defaultWindowHours(cron)).toBe(hours));
});

describe('scheduleEnabled / scheduleSyncPlan', () => {
  it('is enabled only when active, not manual and with a feed project', () => {
    expect(scheduleEnabled(base())).toBe(true);
    expect(scheduleEnabled(base({ status: 'paused' }))).toBe(false);
    expect(scheduleEnabled(base({ scan: { ...(base().scan as object), manual: true } as never }))).toBe(
      false,
    );
    expect(scheduleEnabled(base({ feedProjectId: null }))).toBe(false);
  });
  it('covers every row of the sync table', () => {
    const b = base();
    expect(scheduleSyncPlan(b, b)).toEqual({ action: 'none' });
    expect(scheduleSyncPlan(base({ feedProjectId: null }), b)).toEqual({ action: 'create' });
    expect(scheduleSyncPlan(b, base({ feedProjectId: null }))).toEqual({ action: 'delete' });
    expect(scheduleSyncPlan(b, base({ feedProjectId: uuid(9) }))).toEqual({ action: 'replace' });
    expect(scheduleSyncPlan(b, base({ description: 'x' }))).toEqual({
      action: 'update',
      template: true,
      reschedule: false,
      enabled: true,
    });
    expect(scheduleSyncPlan(b, base({ name: 'Other' }))).toMatchObject({ action: 'update', template: true });
    expect(
      scheduleSyncPlan(b, base({ scan: { ...(b.scan as object), cron: '0 8 * * *' } as never })),
    ).toEqual({ action: 'update', template: false, reschedule: true, enabled: true });
    expect(scheduleSyncPlan(b, base({ status: 'paused' }))).toEqual({
      action: 'update',
      template: false,
      reschedule: false,
      enabled: false,
    });
    expect(scheduleSyncPlan(base({ status: 'paused' }), b)).toEqual({
      action: 'update',
      template: false,
      reschedule: true,
      enabled: true,
    });
    expect(scheduleSyncPlan(b, base({ researchProjectId: uuid(7) }))).toEqual({ action: 'none' });
    expect(
      scheduleSyncPlan(
        base({ feedProjectId: null, researchProjectId: uuid(7) }),
        base({ feedProjectId: null, researchProjectId: uuid(8) }),
      ),
    ).toEqual({ action: 'none' });
  });
});

describe('research defaults and project keys', () => {
  it('prefills the research dialog from the interest', () => {
    expect(
      researchCardDefaults(
        base({ description: 'Tokio internals', subCategory: 'rust/async', preferredSites: ['a.org'] }),
      ),
    ).toEqual({
      title: 'Research: Rust async',
      question: 'What should I know now about Rust async?',
      scope: 'Tokio internals',
      subCategory: 'rust/async',
      preferredSites: ['a.org'],
      depth: 'standard',
    });
  });
  it('suggests valid project keys', () => {
    expect(suggestProjectKey('AI feeds')).toBe('AF');
    expect(suggestProjectKey('Rust')).toBe('RUST');
    expect(suggestProjectKey('3d printing')).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    expect(suggestProjectKey('x')).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    expect(suggestProjectKey('Machine learning papers')).toBe('MLP');
  });
});

describe('managed taste section', () => {
  const names = { [uuid(5)]: 'Rust async' };
  it('renders general rules first, then one group per interest', () => {
    const text = renderTasteSeedSection(
      [
        { text: 'Skip beginner tutorials', interestId: uuid(5) },
        { text: 'Prefer primary sources', interestId: null },
      ],
      names,
    );
    expect(text).toBe(
      '## Explicit rules\n\n- Rule: Prefer primary sources\n\n### Rust async (interest)\n\n- Rule: Skip beginner tutorials\n',
    );
  });
  it('renders an empty rule set', () => {
    expect(renderTasteSeedSection([])).toContain('No explicit rules yet');
  });

  const content = renderTasteSeedSection([{ text: 'A rule', interestId: null }]);
  it('creates a missing file with the header', () => {
    const r = applyManagedSection(null, TASTE_HEADER, 'seed', 1, content);
    expect(r.changed).toBe(true);
    expect(r.text.startsWith(TASTE_HEADER)).toBe(true);
    expect(r.text).toContain('aom:section seed v=1 begin');
    expect(r.text).toContain('- Rule: A rule');
  });
  it('inserts above the rating lines', () => {
    const current = `${TASTE_HEADER}- Prefer articles like "x" (rated useful).\n`;
    const r = applyManagedSection(current, TASTE_HEADER, 'seed', 1, content);
    expect(r.text.indexOf('aom:section seed v=1 begin')).toBeLessThan(r.text.indexOf('- Prefer articles'));
    expect(r.text.endsWith('(rated useful).\n')).toBe(true);
  });
  it('replaces an older block, never duplicates, and ignores stale or identical writes', () => {
    const v1 = applyManagedSection(`${TASTE_HEADER}- Skip x.\n`, TASTE_HEADER, 'seed', 1, content).text;
    const v2 = applyManagedSection(
      v1,
      TASTE_HEADER,
      'seed',
      2,
      renderTasteSeedSection([{ text: 'B rule', interestId: null }]),
    );
    expect(v2.changed).toBe(true);
    expect(v2.text.match(/aom:section seed v=/g)).toHaveLength(1);
    expect(v2.text).toContain('v=2 begin');
    expect(v2.text).toContain('B rule');
    expect(v2.text).not.toContain('A rule');
    expect(applyManagedSection(v2.text, TASTE_HEADER, 'seed', 1, content)).toEqual({
      text: v2.text,
      changed: false,
    });
    expect(applyManagedSection(v2.text, TASTE_HEADER, 'seed', 2, 'whatever')).toEqual({
      text: v2.text,
      changed: false,
    });
  });
  it('handles CRLF files and strips the block again', () => {
    const v1 = applyManagedSection(`${TASTE_HEADER}- Skip x.\n`, TASTE_HEADER, 'seed', 1, content).text;
    const crlf = v1.replace(/\n/g, '\r\n');
    const v2 = applyManagedSection(crlf, TASTE_HEADER, 'seed', 2, content);
    expect(v2.changed).toBe(true);
    expect(v2.text.match(/aom:section seed v=/g)).toHaveLength(1);
    const stripped = stripManagedSection(v1);
    expect(stripped).not.toContain('aom:section');
    expect(stripped).toContain('- Skip x.');
    expect(stripped).toContain('# Taste');
    expect(stripManagedSection(stripped)).toBe(stripped);
  });
});

describe('events, requests and prompt', () => {
  it('round-trips the interest and taste events', () => {
    const body = base();
    for (const e of [
      { type: 'InterestCreated', payload: body },
      { type: 'InterestUpdated', payload: body },
      { type: 'InterestDeleted', payload: { interestId: body.interestId, keepSchedule: true } },
      { type: 'ScheduleLinked', payload: { scheduleId: uuid(4), interestId: null } },
      {
        type: 'TasteSeedSet',
        payload: { projectId: uuid(3), version: 2, rules: [{ text: 'Rule', interestId: null }] },
      },
    ]) {
      expect(DomainEventSchema.parse(e)).toMatchObject({ type: e.type });
    }
  });
  it('accepts an interest id on CardCreated and ScheduleCreated', () => {
    const r = DomainEventSchema.safeParse({
      type: 'ScheduleCreated',
      payload: {
        scheduleId: uuid(4),
        projectId: uuid(3),
        name: 'n',
        kind: 'feed',
        cron: '0 7 * * *',
        timezone: 'UTC',
        cardTemplate: { title: 't' },
        enabled: true,
        nextFireAt: null,
        interestId: uuid(1),
      },
    });
    expect(r.success).toBe(true);
  });
  it('parses a section write and refuses one without a section id', () => {
    const ok = VaultWriteCommandSchema.parse({
      vaultId: 'v1',
      path: 'projects/x/taste.md',
      mode: 'section',
      content: 'c',
      commitMessage: 'm',
      section: { id: 'seed', version: 3 },
    });
    expect(ok.section?.version).toBe(3);
    expect(
      VaultWriteCommandSchema.safeParse({
        vaultId: 'v1',
        path: 'p.md',
        mode: 'section',
        content: 'c',
        commitMessage: 'm',
      }).success,
    ).toBe(false);
  });
  it('defaults a create request', () => {
    const r = CreateInterestRequestSchema.parse({ name: 'X', researchProjectId: uuid(7) });
    expect(r).toMatchObject({ description: '', preferredSites: [], status: 'active' });
  });
  it('puts explicit taste rules ahead of taste.md in the feed prompt', () => {
    const brief = buildBrief();
    const feedBrief = {
      ...brief,
      card: { ...brief.card, cardType: 'feed', fields: { topic: 'Rust', subCategory: 'rust/async' } },
      feed: { candidates: [], seenUrls: [], taste: '# Taste', tasteSeed: ['Skip beginner tutorials'] },
    };
    const prompt = renderShiftPrompt(feedBrief as never);
    expect(prompt).toContain('- Sub-category: rust/async');
    const seed = prompt.indexOf('### Explicit taste rules (set by the manager; follow these first)');
    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(prompt.indexOf('### Taste (taste.md)'));
    expect(prompt).toContain('- Skip beginner tutorials');
    const none = renderShiftPrompt({ ...feedBrief, feed: { ...feedBrief.feed, tasteSeed: [] } } as never);
    expect(none).not.toContain('Explicit taste rules');
  });
});
