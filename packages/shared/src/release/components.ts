import { bumpVersion, type ComponentRule, compareSemver, readComponentVersion } from '../repo/component-rules.ts';
import type { BumpLevel, ReleaseCommit } from './recommend.ts';

export interface ComponentFacts {
  name: string;
  changedCount: number;
  contentAtHead: string | null;
  contentAtTag: string | null;
}
export type ComponentState = 'bump' | 'already_set' | 'unchanged' | 'missing';
export interface ComponentBump {
  name: string;
  level: BumpLevel;
  state: ComponentState;
  from: string | null;
  to: string | null;
  changedCount: number;
  under: string;
  versionFile: string;
  message?: string;
}

/** "apps/runner/**" -> "apps/runner/" (the literal prefix of each glob). */
function underOf(rule: ComponentRule): string {
  const out: string[] = [];
  for (const g of rule.paths.map((p) => p.trim()).filter((p) => p !== '')) {
    const i = g.search(/[*?[{]/);
    const prefix = i < 0 ? g : g.slice(0, i);
    const cut = i < 0 ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1);
    const v = cut === '' ? g : cut;
    if (!out.includes(v)) out.push(v);
  }
  return out.join(', ');
}

/**
 * The bump of each rule. The base is the version at the last tag, so a version bumped by hand since the tag is
 * recognised (`already_set`) and never bumped twice.
 */
export function componentBumps(
  rules: readonly ComponentRule[],
  facts: readonly ComponentFacts[],
  levels: Record<string, BumpLevel> = {},
): ComponentBump[] {
  return rules.map((rule) => {
    const f = facts.find((x) => x.name === rule.name) ?? {
      name: rule.name,
      changedCount: 0,
      contentAtHead: null,
      contentAtTag: null,
    };
    const level: BumpLevel = levels[rule.name] ?? 'patch';
    const under = underOf(rule);
    const common = { name: rule.name, level, changedCount: f.changedCount, under, versionFile: rule.versionFile };
    const head = f.contentAtHead === null ? null : readComponentVersion(rule, f.contentAtHead);
    if (!head || !head.ok || compareSemver(head.version, head.version) === null)
      return {
        ...common,
        state: 'missing' as const,
        from: null,
        to: null,
        message:
          head && !head.ok
            ? head.message
            : head
              ? `the version "${head.version}" in ${rule.versionFile} is not a semantic version`
              : `no version found in ${rule.versionFile} with the rule's pattern`,
      };
    const current = head.version;
    if (f.changedCount === 0) return { ...common, state: 'unchanged' as const, from: current, to: current };
    const tagged = f.contentAtTag === null ? null : readComponentVersion(rule, f.contentAtTag);
    const base = tagged?.ok && compareSemver(tagged.version, tagged.version) !== null ? tagged.version : current;
    const target = bumpVersion(base, level);
    const targetVersion = target.ok ? target.version : base;
    const higher = (compareSemver(current, targetVersion) ?? 0) > 0;
    const to = higher ? current : targetVersion;
    const state: ComponentState = to === current && current !== base ? 'already_set' : 'bump';
    return { ...common, state, from: base, to };
  });
}

export function componentLine(b: ComponentBump): string {
  if (b.state === 'missing') return `${b.name}: ${b.message ?? 'no version found'}`;
  if (b.state === 'unchanged') return `${b.name} ${b.to} (unchanged)`;
  const files = `${b.changedCount} ${b.changedCount === 1 ? 'file' : 'files'} changed${b.under ? ` under ${b.under}` : ''}`;
  if (b.state === 'already_set') return `${b.name} ${b.from} -> ${b.to} (${files}; already set in ${b.versionFile})`;
  return `${b.name} ${b.from} -> ${b.to} (${files})`;
}

const cap = (s: string): string => (s === '' ? s : s[0]?.toUpperCase() + s.slice(1));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The intro line of the release section: one sentence per component rule in front of the Unreleased intro. */
export function releaseIntro(unreleasedIntro: string, bumps: readonly ComponentBump[]): string {
  if (bumps.length === 0) return unreleasedIntro.trim();
  let rest = unreleasedIntro.trim();
  for (const b of bumps) {
    const re = new RegExp(`^${escapeRe(cap(b.name))}\\s+\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]*[0-9A-Za-z])?(?:\\s+\\(unchanged\\))?\\.\\s*`, 'i');
    rest = rest.replace(re, '');
  }
  const sentences = bumps
    .filter((b) => b.state !== 'missing')
    .map((b) => (b.state === 'unchanged' ? `${cap(b.name)} ${b.to} (unchanged).` : `${cap(b.name)} ${b.to}.`));
  return [...sentences, rest].filter((s) => s !== '').join(' ');
}

/** `## [x.y.z] - date`, the intro and the entries, blank parts left out. */
export function composeReleaseSection(version: string, date: string, intro: string, body: string): string {
  return [`## [${version}] - ${date}`, intro.trim(), body.trim()].filter((p) => p !== '').join('\n\n');
}

/** "- <subject>" per commit, newest first (the input order), release commits skipped. */
export function notesFromCommits(commits: readonly ReleaseCommit[]): string {
  return commits
    .filter((c) => !/^chore\(release\)/.test(c.subject))
    .map((c) => `- ${c.subject}`)
    .join('\n');
}
