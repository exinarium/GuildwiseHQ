import {
  type ComponentFacts,
  type ComponentRule,
  compareSemver,
  componentRuleApplies,
  hasBreakingFooter,
  isSafeGitRef,
  RELEASE_TAG_RE,
  type RepoReleaseFactsPayload,
  type RepoReleaseFactsResult,
} from '@aom/shared';
import { git, revParse } from './git.ts';
import { resolveReleaseBase } from './release-pr.ts';
import type { GitAuth } from './worktrees.ts';

export interface ReleaseFactsInput {
  payload: RepoReleaseFactsPayload;
  /** Local clone of the repository. */
  repoPath: string;
  auth?: GitAuth;
}

const COMMITS_MAX = 1000;
const TAGS_MAX = 500;
const CHANGELOG_MAX = 1_048_576;
const VERSION_FILE_MAX = 262_144;

const nonEmpty = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** The text of `path` at `sha`, or null when it is absent or larger than `max` bytes. */
async function fileAt(repoPath: string, sha: string, path: string, max: number): Promise<string | null> {
  const size = await git(repoPath, ['cat-file', '-s', `${sha}:${path}`]);
  if (size.exitCode !== 0) return null;
  if (Number(size.stdout.trim()) > max) return null;
  const r = await git(repoPath, ['show', `${sha}:${path}`]);
  return r.exitCode === 0 ? r.stdout : null;
}

/**
 * The paths changed since `lastTag` (every tracked file when there is no tag) and, per rule, how many of them it
 * covers plus the version file at `sha` and at the tag. Read-only; shared by the release proposal and the release commit.
 */
export async function componentFactsAt(
  repoPath: string,
  rules: readonly ComponentRule[],
  lastTag: string | null,
  sha: string,
): Promise<{ paths: string[]; components: ComponentFacts[] }> {
  const paths = (
    lastTag
      ? (await git(repoPath, ['diff', '--name-only', '-z', lastTag, sha])).stdout
      : (await git(repoPath, ['ls-tree', '-r', '--name-only', '-z', sha])).stdout
  )
    .split('\0')
    .filter((x) => x !== '');
  const components: ComponentFacts[] = [];
  for (const rule of rules) {
    components.push({
      name: rule.name,
      changedCount: componentRuleApplies(rule, paths).matched.length,
      contentAtHead: await fileAt(repoPath, sha, rule.versionFile, VERSION_FILE_MAX),
      contentAtTag: lastTag ? await fileAt(repoPath, lastTag, rule.versionFile, VERSION_FILE_MAX) : null,
    });
  }
  return { paths, components };
}

/**
 * `repo.release_facts`: what the release proposal needs from the repository. Read-only: fetches the main branch, the
 * working branch and the tags, then reads with `git log`, `git diff` and `git show`. It never pushes, tags or checks
 * out, and never throws for expected failures.
 */
export async function readReleaseFacts(input: ReleaseFactsInput): Promise<RepoReleaseFactsResult> {
  const { payload: p, repoPath } = input;
  const head = p.head;
  if (!isSafeGitRef(head)) return fail(`refusing unsafe branch name ${JSON.stringify(head)}`);
  if (p.base !== undefined && !isSafeGitRef(p.base))
    return fail(`refusing unsafe branch name ${JSON.stringify(p.base)}`);
  const resolved = await resolveReleaseBase(repoPath, p, input.auth, 'cannot read the release facts');
  if (!resolved.ok) return fail(resolved.error);
  const { base, a } = resolved;
  const env = { env: a.env };

  await git(repoPath, [...a.args, 'fetch', '--', 'origin', base], env);
  await git(repoPath, [...a.args, 'fetch', '--', 'origin', head], env);
  // A failed tag fetch (for example "would clobber existing tag") is not fatal: the local tags are used.
  await git(
    repoPath,
    [...a.args, 'fetch', '--no-recurse-submodules', '--', 'origin', 'refs/tags/*:refs/tags/*'],
    env,
  );

  const baseRef = (await revParse(repoPath, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
  const baseSha = await revParse(repoPath, baseRef);
  if (!baseSha) return fail(`the main branch '${base}' does not exist in this repository`, base);
  const headRef = (await revParse(repoPath, `refs/remotes/origin/${head}`)) ? `origin/${head}` : head;
  const headSha = await revParse(repoPath, headRef);
  if (!headSha) return fail(`the working branch '${head}' does not exist yet`, base);

  const ahead = Number(
    (await git(repoPath, ['rev-list', '--count', `${baseSha}..${headSha}`])).stdout.trim() || '0',
  );

  const all = nonEmpty((await git(repoPath, ['tag', '--list', 'v*'])).stdout).filter((t) =>
    RELEASE_TAG_RE.test(t),
  );
  const newestFirst = (xs: string[]) => [...xs].sort((x, y) => compareSemver(y.slice(1), x.slice(1)) ?? 0);
  const merged = new Set(
    nonEmpty((await git(repoPath, ['tag', '--merged', headSha, '--list', 'v*'])).stdout),
  );
  const lastName = newestFirst(all.filter((t) => merged.has(t)))[0] ?? null;
  const lastSha = lastName ? await revParse(repoPath, `refs/tags/${lastName}`) : null;
  const lastTag = lastName && lastSha ? { name: lastName, sha: lastSha } : null;

  const range = lastName ? `${lastName}..${headSha}` : headSha;
  const log = await git(repoPath, [
    'log',
    '--no-merges',
    '-n',
    String(COMMITS_MAX + 1),
    '--format=%H%x1f%s%x1f%b%x1e',
    range,
  ]);
  const rows = log.stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim() !== '');
  const commits = rows.slice(0, COMMITS_MAX).map((r) => {
    const [sha = '', subject = '', body = ''] = r.split('\x1f');
    return {
      sha: sha.trim().slice(0, 40),
      subject: subject.trim().slice(0, 300),
      breakingFooter: hasBreakingFooter(body),
    };
  });

  const { paths, components } = await componentFactsAt(repoPath, p.components, lastName, headSha);

  return {
    ok: true,
    base,
    headSha,
    baseSha,
    ahead,
    lastTag,
    existingTags: newestFirst(all).slice(0, TAGS_MAX),
    commits,
    commitsTruncated: rows.length > COMMITS_MAX,
    changedTotal: paths.length,
    components,
    changelog: await fileAt(repoPath, headSha, 'CHANGELOG.md', CHANGELOG_MAX),
  };
}

function fail(error: string, base?: string): RepoReleaseFactsResult {
  return {
    ok: false,
    error: error.slice(0, 600),
    ...(base ? { base } : {}),
    existingTags: [],
    commits: [],
    commitsTruncated: false,
    changedTotal: 0,
    components: [],
  };
}
