import { z } from 'zod';
import { globToRegExp } from '../workflows/high-risk.ts';

/**
 * Lean Team v3, workflow lean team: pure rules shared by the server, the runner and the web app. Build evidence, the owner
 * approval policy, the size caps of the stored diff and the mapping of changed paths to E2E areas.
 */

// ------------------------------------------------------------------------------------------ build evidence

/** What the builder ran before the handoff. The head SHA is not here: the runner attaches the one it measured. */
export const BuildEvidenceCommandSchema = z.object({
  kind: z.enum(['build', 'test', 'lint', 'other']),
  command: z.string().trim().min(1).max(500),
  /** A failing build or test is not handed off: a failed command makes the handoff refuse. */
  status: z.enum(['passed', 'failed']).default('passed'),
  /** What it printed in one line ("143 tests passed"). */
  result: z.string().trim().max(2000).default(''),
});
export type BuildEvidenceCommand = z.infer<typeof BuildEvidenceCommandSchema>;

export const BuildEvidenceInputSchema = z.object({
  commands: z.array(BuildEvidenceCommandSchema).max(20).default([]),
  /** A change with nothing to build or test (documentation, configuration) says so and why. */
  waived: z.string().trim().min(1).max(500).optional(),
});
export type BuildEvidenceInput = z.infer<typeof BuildEvidenceInputSchema>;

/** The evidence as stored on the card: bound to the head SHA the runner measured after the shift's autocommit. */
export const StoredBuildEvidenceSchema = BuildEvidenceInputSchema.extend({
  sha: z.string().min(7).max(64),
  at: z.iso.datetime(),
  agentId: z.string().nullable().optional(),
  /** A clean rebase before review moved the head: the evidence followed it (from the earlier SHA). */
  rebasedFrom: z.string().optional(),
});
export type StoredBuildEvidence = z.infer<typeof StoredBuildEvidenceSchema>;

/** Why this evidence cannot back a handoff, or null: a build and a unit test run that passed, or a stated waiver. */
export function buildEvidenceProblem(e: BuildEvidenceInput | undefined | null): string | null {
  if (!e)
    return 'attach the build and unit test evidence: `aom handoff --build-command ... --test-command ...`';
  const failed = e.commands.find((c) => c.status === 'failed');
  if (failed) return `the ${failed.kind} command "${failed.command}" failed: fix it before you hand off`;
  if (e.waived) return null;
  const has = (kind: BuildEvidenceCommand['kind']) =>
    e.commands.some((c) => c.kind === kind && c.status === 'passed');
  if (!has('build'))
    return 'the evidence has no build command: run the build and pass it with --build-command "<command>" --build-result "<what it printed>" (or --no-evidence "<why there is nothing to build>")';
  if (!has('test'))
    return 'the evidence has no unit test run: run the unit tests and pass them with --test-command "<command>" --test-result "<what it printed>" (or --no-evidence "<why there is nothing to test>")';
  return null;
}

/** Data of the build handoff outcome (`aom handoff`): the builder's optional evidence. The runner adds the diff. */
export const BuildHandoffDataSchema = z.object({ buildEvidence: BuildEvidenceInputSchema.optional() });

// ------------------------------------------------------------------------------------------------- the diff

/** The diff the runner uploads at the review handoff (base..head); the server keeps at most this many bytes. */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_TRUNCATED_NOTE =
  '\n\n[The diff was cut here: it is larger than 2 MB. Open the branch comparison for the rest.]\n';
/** The most changed paths a handoff reports (the server computes the high-risk flag from them). */
export const CHANGED_PATHS_MAX = 5000;

export const DiffUploadSchema = z.object({
  /** The unified diff, cut at `DIFF_MAX_BYTES` with `DIFF_TRUNCATED_NOTE` appended. */
  text: z.string().max(DIFF_MAX_BYTES + 4096),
  /** Bytes of the full diff before it was cut. */
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** What it was taken against: `origin/main` and the base commit it resolved to. */
  base: z.string().max(200),
  baseSha: z.string().max(64).optional(),
});
export type DiffUpload = z.infer<typeof DiffUploadSchema>;

/** Cuts a diff text to the cap on a line boundary and appends the note. Pure; used by the runner and re-checked by the server. */
export function capDiff(
  full: string,
  max = DIFF_MAX_BYTES,
): { text: string; bytes: number; truncated: boolean } {
  const encoded = new TextEncoder().encode(full);
  const bytes = encoded.length;
  if (bytes <= max) return { text: full, bytes, truncated: false };
  let cut = new TextDecoder().decode(encoded.subarray(0, max));
  // never end inside a multi-byte character (toString replaced it) or in the middle of a line
  cut = cut.replace(/�$/, '');
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  return { text: cut + DIFF_TRUNCATED_NOTE, bytes, truncated: true };
}

// --------------------------------------------------------------------------------- the owner approval policy

/**
 * `large_or_high_risk` (default): the owner approves large and high-risk cards; a small low-risk card is approved
 * automatically (and the decision is recorded). `always`: the owner approves every card. A high-risk card always needs
 * the approval; the setting cannot switch that off.
 */
export const OwnerApprovalPolicySchema = z.enum(['large_or_high_risk', 'always']);
export type OwnerApprovalPolicy = z.infer<typeof OwnerApprovalPolicySchema>;
export const DEFAULT_OWNER_APPROVAL_POLICY: OwnerApprovalPolicy = 'large_or_high_risk';

export type OwnerApprovalReason =
  | 'high_risk'
  | 'reviewer_high_risk'
  | 'large'
  | 'policy_always'
  | 'waived_large'
  | 'auto_small';

export interface OwnerApprovalDecision {
  required: boolean;
  reason: OwnerApprovalReason;
}

export const OWNER_APPROVAL_REASON_TEXT: Record<OwnerApprovalReason, string> = {
  high_risk:
    'the change touches high-risk paths (authentication, permissions or secrets, data and migrations, tenancy or billing)',
  reviewer_high_risk: 'the reviewer rated the change high risk',
  large: 'it is a large change',
  policy_always: 'the project asks for the owner approval of every change',
  waived_large: 'a large change, but the project merges large changes without approval',
  auto_small: 'a small, low-risk change: approved automatically by the project setting',
};

export function ownerApprovalDecision(i: {
  policy: OwnerApprovalPolicy;
  highRisk: boolean;
  reviewerHighRisk: boolean;
  riskTier: 'small' | 'large' | null | undefined;
  /** The older project setting "merge large changes without my approval". */
  largeWaived: boolean;
}): OwnerApprovalDecision {
  if (i.highRisk) return { required: true, reason: 'high_risk' };
  if (i.reviewerHighRisk) return { required: true, reason: 'reviewer_high_risk' };
  if (i.policy === 'always') return { required: true, reason: 'policy_always' };
  if (i.riskTier === 'large')
    return i.largeWaived ? { required: false, reason: 'waived_large' } : { required: true, reason: 'large' };
  return { required: false, reason: 'auto_small' };
}

// ----------------------------------------------------------------------------------------------- E2E areas

export const E2eAreaSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Globs of the source paths that belong to the area (`apps/web/src/pages/desk/**`). */
  paths: z.array(z.string().max(300)).max(100).default([]),
  /** Spec files, globs or Playwright tags of the area (`e2e/tests/desk.spec.ts`, `@desk`). */
  specs: z.array(z.string().max(300)).max(100).default([]),
});
export type E2eArea = z.infer<typeof E2eAreaSchema>;

export const E2eAreaMapSchema = z.object({
  areas: z.array(E2eAreaSchema).max(100).default([]),
  /** Specs that always run besides the areas (a smoke test). */
  always: z.array(z.string().max(300)).max(50).default([]),
  /** When no area matches a changed path: run the `always` specs and the core areas (`core`), or everything (`all`). */
  fallback: z.enum(['core', 'all']).default('core'),
});
export type E2eAreaMap = z.infer<typeof E2eAreaMapSchema>;

/** Where the runner looks for a project's own mapping inside the card's repository. */
export const E2E_AREAS_FILE = 'e2e/areas.json';

const SPEC_RE = /\.(spec|test|e2e)\.[a-z0-9]+$/i;
const CORE_NAMES = new Set(['core', 'smoke', 'sanity', 'core-loop', 'happy-path']);

const tokensOf = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

/** The area a spec file belongs to by folder structure: the first folder under the E2E root, else the file name. */
export function areaNameOfSpec(
  specPath: string,
  roots: readonly string[] = ['e2e/tests', 'tests/e2e', 'playwright', 'e2e'],
): string {
  const p = specPath.replace(/\\/g, '/');
  let rel = p;
  for (const r of roots) {
    if (p.startsWith(`${r}/`)) {
      rel = p.slice(r.length + 1);
      break;
    }
  }
  const parts = rel.split('/');
  if (parts.length > 1 && parts[0]) return parts[0].toLowerCase();
  return (parts[0] ?? p).replace(SPEC_RE, '').toLowerCase();
}

/** The default mapping, derived from the E2E folder structure: one area per spec file or folder, matched by name. */
export function deriveE2eAreas(specFiles: readonly string[]): E2eArea[] {
  const byName = new Map<string, string[]>();
  for (const f of specFiles) {
    if (!SPEC_RE.test(f)) continue;
    const name = areaNameOfSpec(f);
    byName.set(name, [...(byName.get(name) ?? []), f]);
  }
  return [...byName.entries()].map(([name, specs]) => ({ name, paths: [], specs }));
}

export interface E2eSelection {
  /** `areas`: the specs of the matched areas; `core`/`all`: nothing matched, the fallback applies. */
  mode: 'areas' | 'core' | 'all';
  areas: string[];
  specs: string[];
  /** Why, in one line for the tester's prompt. */
  reason: string;
}

/**
 * Which E2E specs a card needs: the areas its changed paths map to (explicit `paths` globs first, then the default name
 * match: every word of an area name appears in the path), plus the areas the planner named in `hint` and the mapping's
 * `always` specs. Nothing matched: the core specs, or all of them when there are none (or the mapping says `all`).
 */
export function selectE2eSpecs(i: {
  changedPaths: readonly string[];
  mapping?: E2eAreaMap | null;
  specFiles?: readonly string[];
  hint?: string;
}): E2eSelection {
  const mapping = E2eAreaMapSchema.parse(i.mapping ?? {});
  const derived = deriveE2eAreas(i.specFiles ?? []);
  // explicit areas win over a derived one of the same name; derived areas fill in the rest
  const explicit = new Set(mapping.areas.map((a) => a.name.toLowerCase()));
  const areas: E2eArea[] = [...mapping.areas, ...derived.filter((d) => !explicit.has(d.name.toLowerCase()))];
  const hit = new Set<string>();
  const globs = areas.map((a) => ({ a, res: a.paths.map(globToRegExp) }));
  const hintTokens = new Set(tokensOf(i.hint ?? ''));
  for (const p of i.changedPaths) {
    const norm = p.replace(/\\/g, '/');
    const pathTokens = new Set(tokensOf(norm.replace(SPEC_RE, '')));
    for (const { a, res } of globs) {
      if (CORE_NAMES.has(a.name.toLowerCase())) continue;
      if (res.some((re) => re.test(norm))) hit.add(a.name);
      else if (res.length === 0 || !explicit.has(a.name.toLowerCase())) {
        const t = tokensOf(a.name);
        if (t.length > 0 && t.every((x) => pathTokens.has(x))) hit.add(a.name);
      }
    }
  }
  for (const a of areas) {
    if (CORE_NAMES.has(a.name.toLowerCase())) continue;
    const t = tokensOf(a.name);
    if (t.length > 0 && t.every((x) => hintTokens.has(x))) hit.add(a.name);
  }
  const specsOf = (names: Iterable<string>): string[] => {
    const want = new Set([...names].map((n) => n.toLowerCase()));
    return [...new Set(areas.filter((a) => want.has(a.name.toLowerCase())).flatMap((a) => a.specs))];
  };
  const always = mapping.always;
  if (hit.size > 0) {
    const names = [...hit];
    return {
      mode: 'areas',
      areas: names,
      specs: [...new Set([...specsOf(names), ...always])],
      reason: `the changed files belong to the area${names.length === 1 ? '' : 's'} ${names.join(', ')}`,
    };
  }
  const core = areas.filter((a) => CORE_NAMES.has(a.name.toLowerCase())).map((a) => a.name);
  if (mapping.fallback === 'core' && (core.length > 0 || always.length > 0))
    return {
      mode: 'core',
      areas: core,
      specs: [...new Set([...specsOf(core), ...always])],
      reason: 'no area matched the changed files: the core specs run',
    };
  return {
    mode: 'all',
    areas: [],
    specs: [],
    reason:
      mapping.fallback === 'all'
        ? 'no area matched the changed files and the mapping says to run everything'
        : 'no area matched the changed files and the project has no core specs: run the whole E2E suite',
  };
}
