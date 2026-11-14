import type { RulePack } from '../ledger/rule-packs.ts';
import type { BriefPlaybookKey } from '../schedules/brief-playbooks.ts';

export type IndustryKey = NonNullable<RulePack['industry']>;

/** A Documents draft the bundle creates in the organization (kind `template` or `sample`). */
export interface IndustryDocument {
  /** Stable within the bundle (kebab-case); never reused for different content. */
  id: string;
  title: string;
  /** Markdown. */
  content: string;
}

export interface IndustryBundle {
  id: string;
  version: number;
  industry: IndustryKey;
  name: string;
  description: string;
  rulePackId: string;
  playbookKeys: BriefPlaybookKey[];
  knowledgeTemplates: IndustryDocument[];
  sampleData: IndustryDocument[];
  journeyTemplateIds: string[];
}

export const SAMPLE_BANNER = '> SAMPLE DATA: fictional, safe to remove.';
export const GUIDANCE_NOTE = '> Process guidance only. This is not legal, tax or accounting advice.';
