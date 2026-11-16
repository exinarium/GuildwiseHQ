import {
  type BumpLevel,
  type ChangelogCounts,
  type ComponentBump,
  type ComponentRule,
  compareSemver,
  componentBumps,
  composeReleaseSection,
  isReleaseMachineryCommit,
  newestReleaseTag,
  notesFromCommits,
  type ReleaseFacts,
  type ReleaseProposalView,
  recommendVersion,
  releaseIntro,
  tagVersion,
} from '@aom/shared';
import { parseChangelog, parseUnreleased } from '../blog/releases.ts';

export interface BuiltProposal {
  base: string;
  /** Where `base` came from (see `releaseBase`). */
  baseSource: ReleaseBase['source'];
  /** The newest release tag of the repository, with "v"; null when there is none. */
  newestTag: string | null;
  recommended: ReleaseProposalView['recommended'];
  changelog: ReleaseProposalView['changelog'];
  notes: string;
  notesSource: 'changelog' | 'commits';
  notesEditable: boolean;
  components: ComponentBump[];
  /** The section body without heading, as `composeReleaseSection` takes it. */
  intro: string;
  body: string;
}

export interface ReleaseBase {
  /** Without "v". */
  version: string;
  source: 'tag' | 'changelog' | 'none';
  /** The newest release tag of the repository, with "v". */
  tag: string | null;
  /** The highest dated version in CHANGELOG.md. */
  changelogVersion: string | null;
}

/** The newest release tag in the facts: the higher of the runner's last tag and every existing tag. */
export const newestTagOf = (facts: Pick<ReleaseFacts, 'lastTag' | 'existingTags'>): string | null =>
  newestReleaseTag([facts.lastTag?.name, ...(facts.existingTags ?? [])]);

/**
 * The base of the recommendation: the higher of the newest release tag and the highest dated version in CHANGELOG.md
 * (the tag on a tie), else 0.0.0. So the recommendation is always above every release tag.
 */
export function releaseBase(facts: ReleaseFacts): ReleaseBase {
  const tag = newestTagOf(facts);
  const tagV = tag ? tagVersion(tag) : null;
  const changelogVersion = facts.changelog
    ? parseChangelog(facts.changelog)
        .map((r) => r.version)
        .reduce<string | null>((a, v) => (a === null || (compareSemver(v, a) ?? 0) > 0 ? v : a), null)
    : null;
  if (tagV && changelogVersion && (compareSemver(changelogVersion, tagV) ?? 0) > 0)
    return { version: changelogVersion, source: 'changelog', tag, changelogVersion };
  if (tagV) return { version: tagV, source: 'tag', tag, changelogVersion };
  if (changelogVersion)
    return { version: changelogVersion, source: 'changelog', tag: null, changelogVersion };
  return { version: '0.0.0', source: 'none', tag: null, changelogVersion: null };
}

/** The base version of the recommendation (see `releaseBase`). */
export const baseVersion = (facts: ReleaseFacts): string => releaseBase(facts).version;

/** Everything the desk item and the approval show, from the facts and the rules. Pure. */
export function buildProposal(
  facts: ReleaseFacts,
  rules: readonly ComponentRule[],
  levels: Record<string, BumpLevel> = {},
): BuiltProposal {
  const b = releaseBase(facts);
  const base = b.version;
  const unreleased = facts.changelog !== null ? parseUnreleased(facts.changelog) : null;
  const counts: ChangelogCounts | null =
    facts.changelog === null
      ? null
      : {
          added: unreleased?.sections.added.length ?? 0,
          breaking: unreleased?.breaking ?? 0,
          entries: unreleased?.entries ?? 0,
          sections: unreleased
            ? [
                { name: 'Added', count: unreleased.sections.added.length },
                { name: 'Changed', count: unreleased.sections.changed.length },
                { name: 'Fixed', count: unreleased.sections.fixed.length },
              ]
            : [],
        };
  const rec = recommendVersion({ base, changelog: counts, commits: facts.commits });
  const components = componentBumps(rules, facts.components, levels);
  const fromChangelog = unreleased !== null && !unreleased.empty;
  const intro = releaseIntro(unreleased?.intro ?? '', components);
  const body = fromChangelog ? unreleased.body : '';
  const notes = fromChangelog
    ? [intro, body].filter((x) => x !== '').join('\n\n')
    : notesFromCommits(facts.commits.filter((c) => !isReleaseMachineryCommit(c.subject)));
  return {
    base,
    baseSource: b.source,
    newestTag: b.tag,
    recommended: { version: rec.version, level: rec.level, reason: rec.reason },
    changelog:
      facts.changelog === null
        ? null
        : { present: true, empty: unreleased?.empty ?? true, intro: unreleased?.intro ?? '', body },
    notes,
    notesSource: fromChangelog ? 'changelog' : 'commits',
    notesEditable: !fromChangelog,
    components,
    intro,
    body,
  };
}

/** The section as it will read in CHANGELOG.md under the chosen version (the preview of the desk item). */
export const previewSection = (version: string, date: string, built: BuiltProposal): string =>
  composeReleaseSection(version, date, built.intro, built.body);
