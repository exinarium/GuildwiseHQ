import { ACCOUNTING_BUNDLE } from './accounting.ts';
import type { IndustryBundle } from './common.ts';
import { LAW_BUNDLE } from './law.ts';

export type { IndustryBundle, IndustryDocument, IndustryKey } from './common.ts';
export { GUIDANCE_NOTE, SAMPLE_BANNER } from './common.ts';

export const INDUSTRY_BUNDLES: readonly IndustryBundle[] = [ACCOUNTING_BUNDLE, LAW_BUNDLE];

export const industryBundleById = (id: string): IndustryBundle | undefined =>
  INDUSTRY_BUNDLES.find((b) => b.id === id);

/** The tags a bundle document carries (normalized form). */
export const industryDocumentTags = (b: IndustryBundle, kind: 'template' | 'sample'): string[] =>
  kind === 'sample' ? ['sample', 'industry-sample', b.industry] : ['industry-template', b.industry];
