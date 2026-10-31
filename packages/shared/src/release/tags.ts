/** A release tag: `v` + semver, no build metadata. */
export const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** "v1.3.0" -> "1.3.0"; null when the name is not a release tag. */
export function tagVersion(tag: string): string | null {
  return RELEASE_TAG_RE.test(tag) ? tag.slice(1) : null;
}
