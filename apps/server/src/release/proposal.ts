import {
  type BumpLevel,
  type ChangelogCounts,
  type ComponentBump,
  type ComponentRule,
  componentBumps,
  composeReleaseSection,
  notesFromCommits,
  type ReleaseFacts,
  type ReleaseProposalView,
  recommendVersion,
  releaseIntro,
} from '@aom/shared';
import { parseChangelog, parseUnreleased } from '../blog/releases.ts';

export interface BuiltProposal {
  base: string;
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

/** The base of the recommendation: the last tag, else the newest version in CHANGELOG.md, else 0.0.0. */
export function baseVersion(facts: ReleaseFacts): string {
  if (facts.lastTag) return facts.lastTag.name.replace(/^v/, '');
  if (facts.changelog) return parseChangelog(facts.changelog)[0]?.version ?? '0.0.0';
  return '0.0.0';
}

/** Everything the desk item and the approval show, from the facts and the rules. Pure. */
export function buildProposal(
  facts: ReleaseFacts,
  rules: readonly ComponentRule[],
  levels: Record<string, BumpLevel> = {},
): BuiltProposal {
  const base = baseVersion(facts);
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
    : notesFromCommits(facts.commits);
  return {
    base,
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
