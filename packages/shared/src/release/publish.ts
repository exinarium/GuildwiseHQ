import { compareSemver } from '../repo/component-rules.ts';
import { releaseSectionOf } from './changelog-rewrite.ts';
import { RELEASE_TAG_RE, tagVersion } from './tags.ts';

/** The steps after the release commit: reach main, tag, create the forge release. */
export const RELEASE_PUBLISH_STEPS = ['land', 'tag', 'publish'] as const;
export type ReleasePublishStep = (typeof RELEASE_PUBLISH_STEPS)[number];

/** Tag message and release title: "<release name> <version>". */
export const releaseTitle = (name: string, version: string): string => `${name.trim()} ${version}`;

/** One version's section of CHANGELOG.md without its heading line, trimmed; null when the section is absent. */
export function changelogSection(md: string, version: string): string | null {
  const section = releaseSectionOf(md, version);
  if (section === null) return null;
  const nl = section.indexOf('\n');
  return nl < 0 ? '' : section.slice(nl + 1).trim();
}

export type TagDecision =
  | { action: 'create' }
  /** A local tag on the target that the remote does not have yet. */
  | { action: 'push' }
  /** The remote already has the tag on the target. */
  | { action: 'report' }
  /** The tag is somewhere else: it is never moved. */
  | { action: 'refuse'; message: string };

/**
 * What to do with the release tag. `remote` and `local` are the commits the tag peels to (null: no such tag).
 * An existing tag is never moved: on another commit it is a refusal.
 */
export function decideTag(input: {
  tag: string;
  target: string;
  remote: string | null;
  local: string | null;
}): TagDecision {
  const { tag, target, remote, local } = input;
  if (remote !== null) {
    if (remote === target) return { action: 'report' };
    return {
      action: 'refuse',
      message: `tag ${tag} already exists on ${remote.slice(0, 10)}, not on ${target.slice(0, 10)}. A tag is never moved: choose a higher version or resolve it by hand.`,
    };
  }
  if (local !== null) {
    if (local === target) return { action: 'push' };
    return {
      action: 'refuse',
      message: `tag ${tag} exists locally on ${local.slice(0, 10)}, not on ${target.slice(0, 10)}. A tag is never moved: remove the local tag or choose a higher version.`,
    };
  }
  return { action: 'create' };
}

/** `--latest` only for a non-pre-release version that is the highest among the remote release tags. */
export function isLatestRelease(version: string, remoteTags: string[]): boolean {
  if (version.includes('-')) return false;
  for (const t of remoteTags) {
    const v = tagVersion(t);
    if (v === null || v === version) continue;
    const c = compareSemver(v, version);
    if (c !== null && c > 0 && !v.includes('-')) return false;
  }
  return RELEASE_TAG_RE.test(`v${version}`);
}
