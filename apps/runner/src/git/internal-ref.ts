import { internalRefPattern } from '@aom/shared';
import { git } from './git.ts';

export interface InternalRefCommit {
  sha: string;
  subject: string;
}

/** At most this many offending commits are listed (the finalize result caps the list at 50). */
const MAX_LISTED = 50;

/**
 * The commits in `range` (rev-list arguments, e.g. `origin/main..HEAD`) whose full message names the card's own internal
 * ref `ref` (whole key, any case). Newest first. A git failure lists nothing: the guard never blocks on its own error.
 */
export async function commitsWithInternalRef(
  cwd: string,
  range: string | string[],
  ref: string,
): Promise<InternalRefCommit[]> {
  const r = await git(cwd, [
    'log',
    '--format=%H%x1f%s%x1f%B%x1e',
    ...(Array.isArray(range) ? range : [range]),
    '--',
  ]);
  if (r.exitCode !== 0) return [];
  const re = internalRefPattern(ref);
  const out: InternalRefCommit[] = [];
  for (const rec of r.stdout.split('\x1e')) {
    const [sha, subject, body] = rec.replace(/^\s+/, '').split('\x1f');
    if (!sha || !re.test(body ?? subject ?? '')) continue;
    out.push({ sha: sha.trim(), subject: (subject ?? '').slice(0, 200) });
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** `<sha10> "<subject>"` for the first few commits, for a message to the agent or the card. */
export function describeCommits(commits: InternalRefCommit[], max = 5): string {
  const shown = commits.slice(0, max).map((c) => `${c.sha.slice(0, 10)} "${c.subject}"`);
  return commits.length > max ? `${shown.join(', ')} and ${commits.length - max} more` : shown.join(', ');
}
