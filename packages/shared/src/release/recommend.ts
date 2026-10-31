import { bumpVersion } from '../repo/component-rules.ts';
import { parseConventionalTitle } from './commits.ts';

export type BumpLevel = 'patch' | 'minor' | 'major';

export interface ChangelogCounts {
  added: number;
  breaking: number;
  entries: number;
  /** Non-empty section names with their counts, for the patch reason ("1 Fixed entry"). */
  sections?: { name: string; count: number }[];
}
export interface ReleaseCommit {
  sha: string;
  subject: string;
  breakingFooter: boolean;
}
export interface ReleaseRecommendation {
  version: string;
  level: BumpLevel;
  reason: string;
  base: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const entries = (n: number, what: string): string => plural(n, `${what} entry`, `${what} entries`);

function isBreaking(c: ReleaseCommit): boolean {
  return c.breakingFooter || parseConventionalTitle(c.subject)?.bang === true;
}

export function recommendVersion(input: {
  base: string;
  changelog: ChangelogCounts | null;
  commits: ReleaseCommit[];
}): ReleaseRecommendation {
  const { base, changelog, commits } = input;
  const breakingCommits = commits.filter(isBreaking);
  const feats = commits.filter((c) => parseConventionalTitle(c.subject)?.type === 'feat').length;
  const breakingEntries = changelog?.breaking ?? 0;
  const added = changelog?.added ?? 0;
  let level: BumpLevel;
  let reason: string;
  if (breakingEntries > 0 || breakingCommits.length > 0) {
    level = 'major';
    const parts: string[] = [];
    if (breakingEntries > 0) parts.push(plural(breakingEntries, 'BREAKING entry', 'BREAKING entries'));
    if (breakingCommits.length > 0) {
      const only = breakingEntries === 0 && breakingCommits.length === 1;
      parts.push(
        only
          ? `1 breaking commit (${(breakingCommits[0] as ReleaseCommit).subject})`
          : plural(breakingCommits.length, 'breaking commit', 'breaking commits'),
      );
    }
    reason = `major: ${parts.join(', ')}`;
  } else if (added > 0 || feats > 0) {
    level = 'minor';
    const parts: string[] = [];
    if (added > 0) parts.push(entries(added, 'Added'));
    if (feats > 0) parts.push(plural(feats, 'feat commit', 'feat commits'));
    reason = `minor: ${parts.join(' and ')}, no breaking changes`;
  } else {
    level = 'patch';
    if (changelog && changelog.entries > 0) {
      const names = (changelog.sections ?? [])
        .filter((s) => s.count > 0)
        .map((s) => entries(s.count, s.name));
      const what = names.length > 0 ? names.join(', ') : plural(changelog.entries, 'entry', 'entries');
      reason = `patch: ${what}, no Added entries or breaking changes`;
    } else {
      reason = `patch: ${plural(commits.length, 'commit', 'commits')}, no feat commits or breaking changes`;
    }
  }
  const b = bumpVersion(base, level);
  return { version: b.ok ? b.version : base, level, reason, base };
}
