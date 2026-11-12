import { z } from 'zod';
import { ReviewRisk } from '../cards/types.ts';
import { globToRegExp } from '../workflows/high-risk.ts';

/**
 * Per-project review settings: the size budget, the unit it is measured in and the path-to-risk map. There are no
 * defaults anywhere: a setting stays null until the project owner sets it, and every feature that needs a setting is
 * inactive (and says which one is missing) until then.
 */

/** How a project's size budget is measured: changed lines or changed files, chosen per project. */
export const SizeUnitSchema = z.enum(['changed_lines', 'changed_files']);
export type SizeUnit = z.infer<typeof SizeUnitSchema>;
export const SIZE_UNITS: readonly SizeUnit[] = SizeUnitSchema.options;
export const SIZE_UNIT_LABELS: Record<SizeUnit, string> = {
  changed_lines: 'Changed lines (added + removed)',
  changed_files: 'Changed files',
};

/** The risk class a path maps to: the same scale the reviewer rates with. */
export const RiskClassSchema = ReviewRisk;
export type RiskClass = z.infer<typeof RiskClassSchema>;
export const RISK_CLASSES: readonly RiskClass[] = RiskClassSchema.options;
export const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2 };

export const SIZE_BUDGET_MAX = 1_000_000;
export const RISK_PATTERN_MAX = 300;
export const RISK_MAP_MAX = 200;

/** Trim, `\` to `/`, drop a leading `./` and a trailing `/`. */
export function normaliseRiskPattern(pattern: string): string {
  return pattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

/** Why a (normalised) pattern is refused, or null when it is fine. */
export function riskPatternProblem(pattern: string): string | null {
  const p = normaliseRiskPattern(pattern);
  if (p.length === 0) return 'enter a path';
  if (p.length > RISK_PATTERN_MAX) return `at most ${RISK_PATTERN_MAX} characters`;
  if (p.startsWith('/')) return 'a path inside the repository, not starting with /';
  if (p.split('/').includes('..')) return 'no .. in a path';
  return null;
}

export const RiskPatternSchema = z
  .string()
  .transform(normaliseRiskPattern)
  .superRefine((p, ctx) => {
    const problem = riskPatternProblem(p);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

export const RiskMapEntrySchema = z.object({ pattern: RiskPatternSchema, risk: RiskClassSchema });
export type RiskMapEntry = { pattern: string; risk: RiskClass };

/** A stored entry (event payload, DTO): no normalisation or refinement, so old data always parses. */
export const StoredRiskMapEntrySchema = z.object({
  pattern: z.string().min(1).max(RISK_PATTERN_MAX),
  risk: RiskClassSchema,
});
export const StoredRiskMapSchema = z.array(StoredRiskMapEntrySchema);

/** Indexes of entries whose normalised pattern already appeared earlier in the list (case-insensitive, as matching). */
export function duplicateRiskPatterns(entries: ReadonlyArray<{ pattern: string }>): number[] {
  const seen = new Set<string>();
  const dupes: number[] = [];
  entries.forEach((e, i) => {
    const key = normaliseRiskPattern(e.pattern).toLowerCase();
    if (seen.has(key)) dupes.push(i);
    else seen.add(key);
  });
  return dupes;
}

export const RiskMapSchema = z
  .array(RiskMapEntrySchema)
  .max(RISK_MAP_MAX)
  .superRefine((entries, ctx) => {
    for (const i of duplicateRiskPatterns(entries)) {
      ctx.addIssue({ code: 'custom', message: 'each path appears once', path: [i, 'pattern'] });
    }
  });

export const SizeBudgetSchema = z.number().int().min(1).max(SIZE_BUDGET_MAX);

/** The settings as the owner saves them; every field is required and null means not set (whole-value replace). */
export const ReviewSettingsSchema = z.object({
  sizeBudget: SizeBudgetSchema.nullable(),
  sizeUnit: SizeUnitSchema.nullable(),
  riskMap: RiskMapSchema.nullable(),
});
export interface ReviewSettings {
  sizeBudget: number | null;
  sizeUnit: SizeUnit | null;
  riskMap: RiskMapEntry[] | null;
}

/** What a feature reports while the setting it needs is not set. */
export const REVIEW_SETTING_MISSING = {
  sizeBudget: 'inactive: no size budget set',
  sizeUnit: 'inactive: no size unit set',
  riskMap: 'inactive: no path-to-risk map set',
} as const;
export const ReviewSettingKeySchema = z.enum(['sizeBudget', 'sizeUnit', 'riskMap']);
export type ReviewSettingKey = z.infer<typeof ReviewSettingKeySchema>;

export const FeatureStatusSchema = z.discriminatedUnion('active', [
  z.object({ active: z.literal(true) }),
  z.object({
    active: z.literal(false),
    missing: z.array(ReviewSettingKeySchema),
    reason: z.string(),
    reasons: z.array(z.string()),
  }),
]);
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;

export const ReviewSettingsStatusSchema = z.object({ size: FeatureStatusSchema, risk: FeatureStatusSchema });
export type ReviewSettingsStatus = z.infer<typeof ReviewSettingsStatusSchema>;

type MaybeSettings = Partial<ReviewSettings> | null | undefined;

function statusOf(missing: ReviewSettingKey[]): FeatureStatus {
  if (missing.length === 0) return { active: true };
  const reasons = missing.map((k) => REVIEW_SETTING_MISSING[k]);
  return { active: false, missing, reason: reasons[0] as string, reasons };
}

/** The size verdict, needs-split and the hard size check need a budget and a unit. */
export function sizeChecksStatus(s: MaybeSettings): FeatureStatus {
  const missing: ReviewSettingKey[] = [];
  if (s?.sizeBudget == null) missing.push('sizeBudget');
  if (s?.sizeUnit == null) missing.push('sizeUnit');
  return statusOf(missing);
}

/** Risk from paths needs a non-empty map. */
export function riskFromPathsStatus(s: MaybeSettings): FeatureStatus {
  return statusOf(s?.riskMap && s.riskMap.length > 0 ? [] : ['riskMap']);
}

export function reviewSettingsStatus(s: MaybeSettings): ReviewSettingsStatus {
  return { size: sizeChecksStatus(s), risk: riskFromPathsStatus(s) };
}

/** What a diff measures in the unit (numstat: a binary file counts 0 lines and 1 file). */
export function diffSize(files: ReadonlyArray<{ added: number; deleted: number }>, unit: SizeUnit): number {
  if (unit === 'changed_files') return files.length;
  return files.reduce((n, f) => n + Math.max(0, f.added) + Math.max(0, f.deleted), 0);
}

/** A pattern with `*` or `?` is a glob; a bare path matches itself and everything under it. */
function compilePattern(pattern: string): RegExp[] {
  const p = normaliseRiskPattern(pattern);
  if (/[*?]/.test(p)) return [globToRegExp(p)];
  return [globToRegExp(p), globToRegExp(`${p}/**`)];
}

const normalisePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\/+/, '');

/** Whether a repository path falls under a map pattern. */
export function riskPatternMatches(pattern: string, path: string): boolean {
  const p = normalisePath(path);
  return compilePattern(pattern).some((re) => re.test(p));
}

export type DerivedRisk =
  | { state: 'inactive'; reason: string }
  | {
      state: 'active';
      /** The highest class among the touched paths; null when no touched path is in the map (no default). */
      derived: RiskClass | null;
      declared: RiskClass | null;
      /** max(derived, declared): a declaration raises the class, never lowers it. */
      final: RiskClass | null;
      raisedByDeclaration: boolean;
      matches: Array<{ path: string; pattern: string; risk: RiskClass }>;
    };

const higher = (a: RiskClass | null, b: RiskClass | null): RiskClass | null => {
  if (a == null) return b;
  if (b == null) return a;
  return RISK_ORDER[b] > RISK_ORDER[a] ? b : a;
};

/**
 * The risk class of a diff from the project's path-to-risk map: the highest class of any touched path. A declared
 * class can raise it, never lower it. Without a map the result is inactive; the declaration does not stand in for it.
 */
export function riskFromPaths(input: {
  paths: readonly string[];
  riskMap: readonly RiskMapEntry[] | null | undefined;
  declared?: RiskClass | null;
}): DerivedRisk {
  const map = input.riskMap;
  if (!map || map.length === 0) return { state: 'inactive', reason: REVIEW_SETTING_MISSING.riskMap };
  const compiled = map.map((e) => ({ pattern: e.pattern, risk: e.risk, res: compilePattern(e.pattern) }));
  const matches: Array<{ path: string; pattern: string; risk: RiskClass }> = [];
  let derived: RiskClass | null = null;
  for (const raw of input.paths) {
    const path = normalisePath(raw);
    let best: { pattern: string; risk: RiskClass } | null = null;
    for (const c of compiled) {
      if (!c.res.some((re) => re.test(path))) continue;
      if (!best || RISK_ORDER[c.risk] > RISK_ORDER[best.risk]) best = { pattern: c.pattern, risk: c.risk };
    }
    if (best) {
      matches.push({ path, ...best });
      derived = higher(derived, best.risk);
    }
  }
  const declared = input.declared ?? null;
  const final = higher(derived, declared);
  const raisedByDeclaration =
    declared != null && (derived == null || RISK_ORDER[declared] > RISK_ORDER[derived]);
  return { state: 'active', derived, declared, final, raisedByDeclaration, matches };
}
