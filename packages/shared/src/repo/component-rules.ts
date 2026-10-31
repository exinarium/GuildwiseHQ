import { z } from 'zod';
import { isSafeProjectPath } from '../safe.ts';
import { globToRegExp } from '../workflows/high-risk.ts';

/**
 * Component version rules of a repository: which files make a component's version file bump on a release.
 * Shape and size caps are in the zod schemas; every semantic check is in `componentRuleProblems()`, so old events
 * always replay and the API can answer with a message that names the problem.
 */

export const COMPONENT_RULES_MAX = 20;

export const ComponentRuleSchema = z.object({
  name: z.string().max(60),
  paths: z.array(z.string().max(200)).max(20),
  versionFile: z.string().max(200),
  pattern: z.string().max(500),
});
export type ComponentRule = z.infer<typeof ComponentRuleSchema>;
export const ComponentRulesSchema = z.array(ComponentRuleSchema).max(COMPONENT_RULES_MAX);

export type ComponentRuleField = 'name' | 'paths' | 'versionFile' | 'pattern';
export interface ComponentRuleProblem {
  index: number;
  field: ComponentRuleField;
  message: string;
}

const FLAGS = 'md';

/** Number of capture groups of `pattern`, or null when it does not compile. */
export function patternCaptureGroups(pattern: string): number | null {
  try {
    new RegExp(pattern, FLAGS);
    const m = new RegExp(`(?:${pattern})|`, FLAGS).exec('');
    return m ? m.length - 1 : null;
  } catch {
    return null;
  }
}

function label(rule: ComponentRule, index: number): string {
  const n = rule.name.trim();
  return n === '' ? `Rule ${index + 1}` : `Rule "${n}"`;
}

/** Every problem of the list, in rule order. An empty array means valid. */
export function componentRuleProblems(rules: readonly ComponentRule[]): ComponentRuleProblem[] {
  const out: ComponentRuleProblem[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    const who = label(rule, index);
    const add = (field: ComponentRuleField, message: string) => out.push({ index, field, message });
    const name = rule.name.trim();
    if (name === '') add('name', `Rule ${index + 1}: give the rule a name.`);
    else {
      const key = name.toLowerCase();
      if (seen.has(key)) add('name', `${who}: another rule already has this name.`);
      seen.add(key);
    }
    const globs = rule.paths.map((g) => g.trim()).filter((g) => g !== '');
    if (globs.length === 0) add('paths', `${who}: add at least one path glob (like apps/runner/**).`);
    else if (globs.some((g) => g.startsWith('/') || g.includes('\\') || g.split('/').some((s) => s === '..')))
      add('paths', `${who}: path globs are relative to the repository root and cannot contain "..".`);
    const vf = rule.versionFile.trim();
    if (vf === '' || vf === '.' || vf === './' || !isSafeProjectPath(vf))
      add(
        'versionFile',
        `${who}: the version file must be a path inside the repository and cannot contain ".." (like apps/runner/src/version.ts).`,
      );
    if (rule.pattern === '')
      add('pattern', `${who}: the pattern needs exactly one capture group around the version; it has 0.`);
    else {
      try {
        new RegExp(rule.pattern, FLAGS);
        const n = patternCaptureGroups(rule.pattern) ?? 0;
        if (n !== 1)
          add(
            'pattern',
            `${who}: the pattern needs exactly one capture group around the version; it has ${n}.`,
          );
      } catch (e) {
        add(
          'pattern',
          `${who}: the pattern is not a valid regular expression (${e instanceof Error ? e.message : String(e)}).`,
        );
      }
    }
  });
  return out;
}

/** Stored form: trimmed name, trimmed globs without blanks (a trailing "/" gets "**"), version file without "./". */
export function normalizeComponentRules(rules: readonly ComponentRule[]): ComponentRule[] {
  return rules.map((r) => ({
    name: r.name.trim(),
    paths: r.paths
      .map((g) => g.trim())
      .filter((g) => g !== '')
      .map((g) => (g.endsWith('/') ? `${g}**` : g)),
    versionFile: r.versionFile.trim().replace(/^(\.\/)+/, ''),
    pattern: r.pattern,
  }));
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** Whether any changed file matches a glob of the rule, and which files did (input order). */
export function componentRuleApplies(
  rule: ComponentRule,
  changedFiles: readonly string[],
): { applies: boolean; matched: string[] } {
  const res = rule.paths
    .map((g) => g.trim())
    .filter((g) => g !== '')
    .map(globToRegExp);
  const matched = changedFiles.filter((f) => {
    const p = normPath(f);
    return res.some((re) => re.test(p));
  });
  return { applies: matched.length > 0, matched };
}

export type VersionBump = 'patch' | 'minor' | 'major' | { version: string };

export type ReadVersionResult =
  | { ok: true; version: string; start: number; end: number }
  | { ok: false; reason: 'bad_pattern' | 'no_match' | 'empty'; message: string };

export function readComponentVersion(rule: ComponentRule, text: string): ReadVersionResult {
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern, FLAGS);
  } catch (e) {
    return {
      ok: false,
      reason: 'bad_pattern',
      message: `the pattern is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const m = re.exec(text);
  if (!m)
    return {
      ok: false,
      reason: 'no_match',
      message: `the pattern ${rule.pattern} was not found in ${rule.versionFile}`,
    };
  const ind = m.indices?.[1];
  if (!ind || m[1] === undefined || m[1] === '')
    return {
      ok: false,
      reason: 'empty',
      message: `the pattern matched but the version is empty in ${rule.versionFile}`,
    };
  return { ok: true, version: m[1], start: ind[0], end: ind[1] };
}

const SEMVER = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

interface Parsed {
  v: string;
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

function parse(s: string): Parsed | null {
  const m = SEMVER.exec(s);
  if (!m) return null;
  return { v: m[1] ?? '', major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]), pre: m[5] ?? null };
}

/** Semver precedence (§11): <0, 0 or >0; null when either is not semver. */
export function compareSemver(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn) return -1;
    else if (qn) return 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export type BumpResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'not_semver' | 'invalid_version' | 'not_higher'; message: string };

export function bumpVersion(current: string, bump: VersionBump): BumpResult {
  const cur = parse(current);
  if (!cur)
    return {
      ok: false,
      reason: 'not_semver',
      message: `the current version "${current}" is not a semantic version`,
    };
  if (typeof bump === 'object') {
    const next = parse(bump.version);
    if (!next)
      return {
        ok: false,
        reason: 'invalid_version',
        message: `"${bump.version}" is not a semantic version (like 1.2.3)`,
      };
    const cmp = compareSemver(current, bump.version);
    if (cmp === null || cmp >= 0)
      return { ok: false, reason: 'not_higher', message: `"${bump.version}" is not higher than ${current}` };
    return { ok: true, version: cur.v && !next.v ? `${cur.v}${bump.version}` : bump.version };
  }
  let { major, minor, patch } = cur;
  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else if (cur.pre === null) patch += 1;
  return { ok: true, version: `${cur.v}${major}.${minor}.${patch}` };
}

export type ReplaceVersionResult =
  | { ok: true; from: string; to: string; text: string }
  | {
      ok: false;
      reason: 'bad_pattern' | 'no_match' | 'empty' | 'not_semver' | 'invalid_version' | 'not_higher';
      message: string;
    };

/** Replaces only the captured version (first match); the rest of `text` stays byte-identical. `bump` defaults to patch. */
export function replaceComponentVersion(
  rule: ComponentRule,
  text: string,
  bump: VersionBump = 'patch',
): ReplaceVersionResult {
  const r = readComponentVersion(rule, text);
  if (!r.ok) return r;
  const b = bumpVersion(r.version, bump);
  if (!b.ok) return b;
  return {
    ok: true,
    from: r.version,
    to: b.version,
    text: text.slice(0, r.start) + b.version + text.slice(r.end),
  };
}
