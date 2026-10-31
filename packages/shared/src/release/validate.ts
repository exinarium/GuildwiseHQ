import { compareSemver } from '../repo/component-rules.ts';
import { RELEASE_TAG_RE } from './tags.ts';

export type VersionCheck = { ok: true; version: string } | { ok: false; message: string };

/** Checks a release version typed by the owner: semver, higher than the last tag, not already tagged. */
export function validateReleaseVersion(
  input: string,
  lastTag: string | null,
  existingTags: readonly string[],
): VersionCheck {
  const raw = input.trim().replace(/^v/, '');
  if (!RELEASE_TAG_RE.test(`v${raw}`))
    return {
      ok: false,
      message: `${raw === '' ? 'An empty version' : raw} is not a semantic version (use MAJOR.MINOR.PATCH, for example 1.4.0)`,
    };
  if (lastTag) {
    const c = compareSemver(raw, lastTag.replace(/^v/, ''));
    if (c !== null && c <= 0) return { ok: false, message: `${raw} is not higher than the last release ${lastTag}` };
  }
  if (existingTags.includes(`v${raw}`)) return { ok: false, message: `v${raw} already exists as a tag` };
  return { ok: true, version: raw };
}
