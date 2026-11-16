import { compareSemver } from '../repo/component-rules.ts';

/** A release tag: `v` + semver, no build metadata. */
export const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** "v1.3.0" -> "1.3.0"; null when the name is not a release tag. */
export function tagVersion(tag: string): string | null {
  return RELEASE_TAG_RE.test(tag) ? tag.slice(1) : null;
}

/** The highest release tag (semver order, pre-releases count) among `tags`; null when none is a release tag. */
export function newestReleaseTag(tags: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const t of tags) {
    if (!t || !RELEASE_TAG_RE.test(t)) continue;
    if (best === null || (compareSemver(t.slice(1), best.slice(1)) ?? 0) > 0) best = t;
  }
  return best;
}
