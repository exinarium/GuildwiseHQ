import { compareSemver } from '../repo/component-rules.ts';
import { newestReleaseTag, RELEASE_TAG_RE } from './tags.ts';

export type VersionCheck =
  | { ok: true; version: string }
  | { ok: false; reason: 'not_semver' | 'not_higher' | 'exists'; message: string };

/**
 * Checks a release version typed by the owner: semver, higher than the newest release tag (the higher of `lastTag`
 * and `existingTags`), higher than `opts.base` when that is a newer version from CHANGELOG.md, and not already tagged.
 */
export function validateReleaseVersion(
  input: string,
  lastTag: string | null,
  existingTags: readonly string[],
  opts: { base?: string } = {},
): VersionCheck {
  const raw = input.trim().replace(/^v/, '');
  if (!RELEASE_TAG_RE.test(`v${raw}`))
    return {
      ok: false,
      reason: 'not_semver',
      message: `${raw === '' ? 'An empty version' : raw} is not a semantic version (use MAJOR.MINOR.PATCH, for example 1.4.0)`,
    };
  const floorTag = newestReleaseTag([lastTag, ...existingTags]);
  const floor = floorTag ? floorTag.slice(1) : null;
  if (floorTag && floor) {
    const c = compareSemver(raw, floor);
    if (c !== null && c <= 0)
      return {
        ok: false,
        reason: 'not_higher',
        message: `${raw} is not higher than the last release ${floorTag}`,
      };
  }
  const base = opts.base?.trim().replace(/^v/, '');
  if (base && (floor === null || (compareSemver(base, floor) ?? 0) > 0)) {
    const c = compareSemver(raw, base);
    if (c !== null && c <= 0)
      return {
        ok: false,
        reason: 'not_higher',
        message: `${raw} is not higher than ${base}, the newest version in CHANGELOG.md`,
      };
  }
  if (existingTags.includes(`v${raw}`))
    return { ok: false, reason: 'exists', message: `v${raw} already exists as a tag` };
  return { ok: true, version: raw };
}
