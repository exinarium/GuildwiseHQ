import { z } from 'zod';
import { tagVersion } from './tags.ts';

/** How a submodule pin compares with the latest release of the project repository it points to. */
export const SubmodulePointerStateSchema = z.enum(['pinned', 'behind', 'not_on_release_tag', 'not_checked', 'unknown']);
export type SubmodulePointerState = z.infer<typeof SubmodulePointerStateSchema>;

/** One submodule of the released commit and how its pin compares with the pointed repository's latest release. */
export const ReleaseSubmoduleFactsSchema = z.object({
  path: z.string().max(500),
  /** The normalized submodule url (never the raw url: it may carry credentials). */
  url: z.string().max(500),
  pinned: z.string().max(40),
  /** The project repository it points to (absent: outside the project). */
  repoId: z.uuid().optional(),
  repoName: z.string().max(200).optional(),
  latestTag: z.object({ name: z.string().max(100), sha: z.string().max(40) }).nullable().optional(),
  /** Newest release tag merged into the pinned commit ("contains 1.7.2"). */
  containsTag: z.string().max(100).nullable().optional(),
  state: SubmodulePointerStateSchema,
  /** Why not_checked / unknown / a server-side staleness upgrade (plain words, shown on the item). */
  reason: z.string().max(300).optional(),
});
export type ReleaseSubmoduleFacts = z.infer<typeof ReleaseSubmoduleFactsSchema>;
export const ReleaseSubmodulesSchema = z.array(ReleaseSubmoduleFactsSchema).max(50);

/** Another repository of the same project, sent with `repo.release_facts`. */
export const ReleaseProjectRepoSchema = z.object({
  repoId: z.uuid(),
  name: z.string().max(200),
  remoteUrlNormalized: z.string().max(500),
});
export type ReleaseProjectRepo = z.infer<typeof ReleaseProjectRepoSchema>;

/** The conflict code of a ship refused by the submodule pointer gate. */
export const RELEASE_SUBMODULE_GATE_CODE = 'release_submodule_behind';

const BLOCKING: ReadonlySet<SubmodulePointerState> = new Set(['behind', 'not_on_release_tag']);

function short(sha: string): string {
  return sha.slice(0, 7);
}

function version(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return tagVersion(tag) ?? tag;
}

function comparison(s: ReleaseSubmoduleFacts): string {
  const contains = version(s.containsTag);
  const latest = version(s.latestTag?.name) ?? 'unknown';
  return `pinned ${short(s.pinned)} (${contains ? `contains ${contains}` : 'contains no release'}), latest release ${latest}`;
}

/** One line per submodule, e.g. "core: behind - pinned abc1234 (contains 1.7.2), latest release 1.8.0". */
export function submoduleLine(s: ReleaseSubmoduleFacts): string {
  switch (s.state) {
    case 'pinned':
      return `${s.path}: pinned - ${short(s.pinned)} is release ${version(s.latestTag?.name) ?? 'unknown'}`;
    case 'behind':
      return `${s.path}: behind - ${comparison(s)}`;
    case 'not_on_release_tag':
      return `${s.path}: not on a release tag - ${comparison(s)}`;
    case 'not_checked':
      return `${s.path}: not checked - ${s.reason ?? 'not compared'}`;
    case 'unknown':
      return `${s.path}: unknown - ${s.reason ?? 'could not be verified'}`;
  }
}

export interface ReleasePointerGate {
  blocked: boolean;
  /** The refusal with the fix, identical on the server (409) and on the item. */
  message: string | null;
  blocking: ReleaseSubmoduleFacts[];
  /** Entries that could not be verified (state 'unknown'): shown, never blocking. */
  warnings: ReleaseSubmoduleFacts[];
}

/** Whether a release of `repoName` may ship with these submodule pointers. Absent or empty list: nothing checked. */
export function releasePointerGate(
  subs: readonly ReleaseSubmoduleFacts[] | undefined,
  repoName: string,
): ReleasePointerGate {
  const list = subs ?? [];
  const blocking = list.filter((s) => BLOCKING.has(s.state));
  const warnings = list.filter((s) => s.state === 'unknown');
  if (blocking.length === 0) return { blocked: false, message: null, blocking, warnings };
  const sentences = blocking.map((s) => {
    const of = s.repoName ? ` of ${s.repoName}` : '';
    const tag = s.latestTag?.name ?? 'the latest release tag';
    return `${submoduleLine(s)}${of}. Bump the submodule ${s.path} to ${tag} in ${repoName} and refresh the release.`;
  });
  return { blocked: true, message: `Cannot ship ${repoName}: ${sentences.join(' ')}`, blocking, warnings };
}
