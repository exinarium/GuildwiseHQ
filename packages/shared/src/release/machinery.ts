import type { ReleaseFacts } from './dto.ts';
import { sameCommit } from './readiness.ts';

/** Subject of the release commit made by the release ship. */
export const releaseCommitSubject = (version: string): string => `chore(release): ${version}`;

/** Subject of the docs commit made by release prep. */
export const releasePrepCommitSubject = (branch: string): string =>
  `docs(release): prepare the release documentation for ${branch}`;

const RELEASE_COMMIT_RE = /^chore\(release\): v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PREP_COMMIT_RE = /^docs\(release\): prepare the release documentation for \S+$/;

/** Whether a commit subject is the release commit of a ship. */
export const isReleaseCommit = (subject: string): boolean => RELEASE_COMMIT_RE.test(subject.trim());

/**
 * Whether a commit was made by release machinery (the release commit or the release prep docs commit). These subjects
 * are reserved: a hand-made commit titled `chore(release): x.y.z` is treated as the release commit of x.y.z.
 */
export const isReleaseMachineryCommit = (subject: string): boolean =>
  isReleaseCommit(subject) || PREP_COMMIT_RE.test(subject.trim());

/**
 * Whether the facts show work that no release contains yet. `real` counts the commits since the last release that
 * are not release machinery (any truncated list counts as real work). `behindRelease` is set when the facts still list
 * the release commit of a published ship whose tag is not the facts' last tag: the facts were read with a stale
 * last-tag rule, so their commits are not new work.
 */
export function releaseChanges(
  facts: Pick<ReleaseFacts, 'commits' | 'commitsTruncated' | 'lastTag'>,
  published: ReadonlyArray<{ tag: string; commitSha: string }> = [],
): { real: number; behindRelease: boolean } {
  const commits = facts.commits ?? [];
  const real = facts.commitsTruncated
    ? Number.POSITIVE_INFINITY
    : commits.filter((c) => !isReleaseMachineryCommit(c.subject)).length;
  const last = facts.lastTag?.name ?? null;
  const behindRelease = published.some(
    (p) => p.tag !== last && commits.some((c) => sameCommit(c.sha, p.commitSha)),
  );
  return { real, behindRelease };
}
