import { z } from 'zod';
import { NeedsSplitFolderSchema, type StoredNeedsSplitProposal } from '../cards/needs-split.ts';
import { type ReviewSettings, type RiskClass, riskFromPaths, type SizeUnit } from './review-settings.ts';

/**
 * The size estimate the architect records at design time and the verdict against the project's size budget. Only an
 * over-budget verdict raises the needs-split question; a high risk class alone never does.
 */

export type SizeVerdict = 'within_budget' | 'over_budget';
/** The card line when the project has no size budget. */
export const NO_SIZE_BUDGET = 'no size budget set';
export const NO_SIZE_UNIT = 'no size unit set';
export const NO_SIZE_ESTIMATE = 'no size estimate';
export const SIZE_VERDICT_TEXT: Record<SizeVerdict, string> = {
  within_budget: 'within budget',
  over_budget: 'over budget',
};
/** The unit as it reads in a sentence ("640 changed lines"). */
export const SIZE_UNIT_WORDS: Record<SizeUnit, string> = {
  changed_lines: 'changed lines',
  changed_files: 'changed files',
};

/** Pure. Over when the estimate is above the budget (equal is within). No verdict without a budget, a unit or an estimate. */
export function sizeVerdict(
  estimate: number | null | undefined,
  s: Pick<ReviewSettings, 'sizeBudget' | 'sizeUnit'> | null | undefined,
): { verdict: SizeVerdict | null; text: string } {
  if (s?.sizeBudget == null) return { verdict: null, text: NO_SIZE_BUDGET };
  if (s.sizeUnit == null) return { verdict: null, text: NO_SIZE_UNIT };
  if (estimate == null) return { verdict: null, text: NO_SIZE_ESTIMATE };
  const verdict: SizeVerdict = estimate > s.sizeBudget ? 'over_budget' : 'within_budget';
  return { verdict, text: SIZE_VERDICT_TEXT[verdict] };
}

export interface SizingSeam {
  title: string;
  folders: string[];
  repo?: string;
  note?: string;
}

export interface DesignSizing {
  estimate: number | null;
  unit: SizeUnit | null;
  budget: number | null;
  verdict: SizeVerdict | null;
  verdictText: string;
  risk: {
    /** The final class (derived, raised by the declaration); null when the map is not set or nothing matched. */
    class: RiskClass | null;
    derived: RiskClass | null;
    declared: RiskClass | null;
    raisedByDeclaration: boolean;
    /** Why the risk class is inactive (no path-to-risk map), else null. */
    status: string | null;
    matches: Array<{ path: string; pattern: string; risk: RiskClass }>;
  };
  /** What the architect named (`--path`), normalised. */
  paths: string[];
  /** The folders of `paths`: the folder scope a needs split carries. */
  folderScope: string[];
  /** Proposed split seams (`--seam`). */
  seams: SizingSeam[];
}

/** Lenient stored form (event payload, DTO, card JSON): old data always parses. */
export const StoredDesignSizingSchema = z.object({
  estimate: z.number().nullable(),
  unit: z.string().nullable(),
  budget: z.number().nullable(),
  verdict: z.string().nullable(),
  verdictText: z.string(),
  risk: z.object({
    class: z.string().nullable(),
    derived: z.string().nullable(),
    declared: z.string().nullable(),
    raisedByDeclaration: z.boolean(),
    status: z.string().nullable(),
    matches: z.array(z.object({ path: z.string(), pattern: z.string(), risk: z.string() })),
  }),
  paths: z.array(z.string()),
  folderScope: z.array(z.string()),
  seams: z.array(
    z.object({
      title: z.string(),
      folders: z.array(z.string()),
      repo: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
});
export type StoredDesignSizing = z.infer<typeof StoredDesignSizingSchema>;

const MAX_MATCHES = 50;
const MAX_SCOPE = 50;

const normalisePath = (p: string): string =>
  p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** A file becomes its folder; folders stay as they are; whatever is still not a folder is dropped; unique; at most 50. */
export function folderScopeOf(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let p = normalisePath(raw);
    if (!p) continue;
    if (!NeedsSplitFolderSchema.safeParse(p).success) {
      const cut = p.lastIndexOf('/');
      if (cut <= 0) continue;
      p = p.slice(0, cut);
    }
    const ok = NeedsSplitFolderSchema.safeParse(p);
    if (ok.success && !out.includes(ok.data)) out.push(ok.data);
    if (out.length >= MAX_SCOPE) break;
  }
  return out;
}

/**
 * Path-like tokens in free text (the card's Affected areas): `a/b` or `a/b/c.ts`, at least one `/`, no URLs. Kept
 * minimal: a token is letters, digits, `.`, `_`, `-`, `/`, `*`.
 */
export function pathsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9_.*@-]+(?:\/[A-Za-z0-9_.*@-]+)+\/?/g)) {
    const start = m.index ?? 0;
    // Skip URLs (`https://host/...`) and the tail of a longer token.
    const before = text.slice(Math.max(0, start - 3), start);
    if (before.endsWith('://') || /:\/?$/.test(before)) continue;
    const token = normalisePath(m[0].replace(/[.,;:)]+$/, ''));
    if (!token.includes('/') || token.split('/').includes('..') || token.startsWith('/')) continue;
    if (/^[\d./]+$/.test(token)) continue; // dates, versions, fractions
    out.push(token);
  }
  return unique(out);
}

/** The size estimate, the verdict and the risk class of a design. */
export function designSizing(i: {
  settings: Pick<ReviewSettings, 'sizeBudget' | 'sizeUnit' | 'riskMap'> | null;
  estimate?: number | null;
  paths: readonly string[];
  affectedAreaPaths: readonly string[];
  declaredRisk?: RiskClass | null;
  seams?: readonly SizingSeam[];
}): DesignSizing {
  const paths = unique(i.paths.map(normalisePath).filter(Boolean));
  const all = unique([...paths, ...i.affectedAreaPaths.map(normalisePath).filter(Boolean)]);
  const v = sizeVerdict(i.estimate, i.settings);
  const declared = i.declaredRisk ?? null;
  const r = riskFromPaths({ paths: all, riskMap: i.settings?.riskMap ?? null, declared });
  const risk: DesignSizing['risk'] =
    r.state === 'inactive'
      ? { class: null, derived: null, declared, raisedByDeclaration: false, status: r.reason, matches: [] }
      : {
          class: r.final,
          derived: r.derived,
          declared: r.declared,
          raisedByDeclaration: r.raisedByDeclaration,
          status: null,
          matches: r.matches.slice(0, MAX_MATCHES),
        };
  return {
    estimate: i.estimate ?? null,
    unit: i.settings?.sizeUnit ?? null,
    budget: i.settings?.sizeBudget ?? null,
    verdict: v.verdict,
    verdictText: v.text,
    risk,
    paths,
    folderScope: folderScopeOf(paths),
    seams: (i.seams ?? []).map((s) => ({
      title: s.title,
      folders: [...s.folders],
      ...(s.repo ? { repo: s.repo } : {}),
      ...(s.note ? { note: s.note } : {}),
    })),
  };
}

/** The design's sizing read back from the card (stored JSON), or null when there is none or it does not parse. */
export function storedDesignSizing(x: unknown): StoredDesignSizing | null {
  if (x == null) return null;
  return StoredDesignSizingSchema.safeParse(x).data ?? null;
}

function unitWords(unit: string | null): string {
  return unit && unit in SIZE_UNIT_WORDS ? SIZE_UNIT_WORDS[unit as SizeUnit] : (unit ?? '');
}

/** One plain line for the thread and the brief. */
export function sizingLine(s: DesignSizing | StoredDesignSizing): string {
  const parts: string[] = [];
  if (s.estimate != null && s.unit) {
    const budget = s.budget != null ? ` (budget ${s.budget})` : '';
    parts.push(
      `Size: ${s.estimate} ${unitWords(s.unit)}, ${s.verdict ? s.verdictText : `no verdict: ${s.verdictText}`}${s.verdict ? budget : ''}.`,
    );
  } else {
    parts.push(`Size: no verdict: ${s.verdictText}.`);
  }
  if (s.risk.status) parts.push(`Risk class: none (${s.risk.status}).`);
  else if (s.risk.class)
    parts.push(
      `Risk class: ${s.risk.class} (${s.risk.raisedByDeclaration ? "raised by the architect's declaration" : 'derived from the path-to-risk map'}).`,
    );
  else parts.push('Risk class: none (no named path is in the path-to-risk map).');
  return parts.join(' ');
}

/** The needs-split proposal from an over-budget sizing: GWP-208's shape. */
export function needsSplitProposalFrom(
  s: DesignSizing | StoredDesignSizing,
  summary: string,
): StoredNeedsSplitProposal {
  const words = unitWords(s.unit);
  const reason =
    `Estimated ${s.estimate ?? '?'} ${words} at design, over the project's size budget of ${s.budget ?? '?'}. ${summary}`
      .trim()
      .slice(0, 2000);
  return {
    reason,
    folderScope: [...s.folderScope],
    seams: s.seams.map((x) => ({
      title: x.title,
      folders: [...x.folders],
      ...(x.repo ? { repo: x.repo } : {}),
      ...(x.note ? { note: x.note } : {}),
    })),
    ...(s.estimate != null && s.budget != null && s.unit
      ? { estimate: { size: s.estimate, budget: s.budget, unit: words } }
      : {}),
  };
}

/** `--seam "[repo] <title>: <folder>, <folder>"`: split at the first `": "`. Throws an Error naming the form. */
export function parseSeamFlag(raw: string): SizingSeam {
  const form = '--seam "<title>: <folder>[, <folder>...]"';
  const at = raw.indexOf(': ');
  if (at < 0) throw new Error(`${form}: "${raw}" has no ": " between the title and the folders`);
  let title = raw.slice(0, at).trim();
  const folders = raw
    .slice(at + 2)
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  let repo: string | undefined;
  const m = title.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (m) {
    repo = (m[1] as string).trim();
    title = (m[2] as string).trim();
  }
  if (!title) throw new Error(`${form}: "${raw}" has no title`);
  if (folders.length === 0) throw new Error(`${form}: "${raw}" names no folder`);
  return { title, folders, ...(repo ? { repo } : {}) };
}
