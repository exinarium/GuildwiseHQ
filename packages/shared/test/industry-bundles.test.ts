import { describe, expect, it } from 'vitest';
import { DOCUMENT_MAX_CHARS, documentSlug, normalizeDocumentTags } from '../src/documents/index.ts';
import {
  GUIDANCE_NOTE,
  INDUSTRY_BUNDLES,
  industryBundleById,
  industryDocumentTags,
  SAMPLE_BANNER,
} from '../src/industry/index.ts';
import { getJourneyTemplate } from '../src/journeys/index.ts';
import { rulePackById } from '../src/ledger/rule-packs.ts';
import { BRIEF_PLAYBOOKS, isBriefPlaybookKey } from '../src/schedules/brief-playbooks.ts';

describe('industry bundle catalogue', () => {
  it('has an accounting and a law bundle with unique ids', () => {
    expect(INDUSTRY_BUNDLES.map((b) => b.id).sort()).toEqual(['accounting', 'law']);
    expect(new Set(INDUSTRY_BUNDLES.map((b) => b.id)).size).toBe(INDUSTRY_BUNDLES.length);
    expect(industryBundleById('law')?.industry).toBe('law');
    expect(industryBundleById('nope')).toBeUndefined();
  });

  describe.each(INDUSTRY_BUNDLES.map((b) => [b.id, b] as const))('%s', (_id, b) => {
    it('names a rule pack of the same industry', () => {
      expect(rulePackById(b.rulePackId)?.industry).toBe(b.industry);
    });

    it('names playbooks that exist and belong to the industry', () => {
      expect(b.playbookKeys.length).toBeGreaterThan(0);
      for (const k of b.playbookKeys) {
        expect(isBriefPlaybookKey(k)).toBe(true);
        expect(BRIEF_PLAYBOOKS[k].industry).toBe(b.industry);
      }
    });

    it('names journey templates that exist and belong to the industry', () => {
      expect(b.journeyTemplateIds.length).toBeGreaterThan(0);
      for (const id of b.journeyTemplateIds) expect(getJourneyTemplate(id)?.industry).toBe(b.industry);
    });

    it('has document member ids that are unique', () => {
      const ids = [...b.knowledgeTemplates, ...b.sampleData].map((d) => d.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('marks samples as sample data and templates as guidance', () => {
      expect(b.sampleData.length).toBeGreaterThan(0);
      for (const d of b.sampleData) {
        expect(d.title.startsWith('Sample:')).toBe(true);
        expect(d.content).toContain(SAMPLE_BANNER);
      }
      expect(b.knowledgeTemplates.length).toBeGreaterThan(0);
      for (const d of b.knowledgeTemplates) expect(d.content).toContain(GUIDANCE_NOTE);
    });

    it('keeps every document within the size limit', () => {
      for (const d of [...b.knowledgeTemplates, ...b.sampleData]) {
        expect(d.content.length).toBeGreaterThan(0);
        expect(d.content.length).toBeLessThanOrEqual(DOCUMENT_MAX_CHARS);
      }
    });

    it('uses tags that are already in normalized form', () => {
      for (const kind of ['template', 'sample'] as const) {
        const tags = industryDocumentTags(b, kind);
        expect(normalizeDocumentTags(tags)).toEqual(tags);
      }
      expect(industryDocumentTags(b, 'sample')).toContain('sample');
    });
  });

  it('gives every document a title slug that is unique across all bundles', () => {
    const slugs = INDUSTRY_BUNDLES.flatMap((b) =>
      [...b.knowledgeTemplates, ...b.sampleData].map((d) => documentSlug(d.title)),
    );
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps general playbooks free of an industry', () => {
    expect(BRIEF_PLAYBOOKS.morning_plan.industry).toBeUndefined();
    expect(BRIEF_PLAYBOOKS.weekly_owner_brief.industry).toBeUndefined();
  });
});
