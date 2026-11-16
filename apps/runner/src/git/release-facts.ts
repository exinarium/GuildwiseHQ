import {
  type ComponentFacts,
  type ComponentRule,
  compareSemver,
  componentRuleApplies,
  hasBreakingFooter,
  isSafeGitRef,
  RELEASE_TAG_RE,
  type ReleaseProjectRepo,
  type ReleaseSubmoduleFacts,
  type RepoReleaseFactsPayload,
  type RepoReleaseFactsResult,
} from '@aom/shared';
import { git, revParse } from './git.ts';
import { resolveReleaseBase } from './release-pr.ts';
import { withRepoLock } from './repo-lock.ts';
import { type FindRepo, isSafeSubmodulePath, redactGitError } from './submodule-fill.ts';
import { readSubmodules } from './submodule-pin.ts';
import type { GitAuth } from './worktrees.ts';

export interface ReleaseFactsInput {
  payload: RepoReleaseFactsPayload;
  /** Local clone of the repository. */
  repoPath: string;
  auth?: GitAuth;
  /** The runner's registered clone of another repository (for the submodule pointer check). */
  findRepo?: FindRepo;
}

const COMMITS_MAX = 1000;
const TAGS_MAX = 500;
const CHANGELOG_MAX = 1_048_576;
const VERSION_FILE_MAX = 262_144;
const SUBMODULES_MAX = 50;

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
  // byte-exact: the release commit writes this text back, so its final newline (LF or CRLF) must survive
  const r = await git(repoPath, ['show', `${sha}:${path}`], { keepFinalNewline: true });
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
 * Every release tag (`vX.Y.Z`) of the clone, newest first, and the newest one merged into `headSha`. One rule for the
 * release facts and for Release prep (docs and videos).
 */
export async function releaseTagsAt(
  repoPath: string,
  headSha: string,
): Promise<{
  all: string[];
  newestFirst: (xs: string[]) => string[];
  last: { name: string; sha: string } | null;
}> {
  const all = nonEmpty((await git(repoPath, ['tag', '--list', 'v*'])).stdout).filter((t) =>
    RELEASE_TAG_RE.test(t),
  );
  const newestFirst = (xs: string[]) => [...xs].sort((x, y) => compareSemver(y.slice(1), x.slice(1)) ?? 0);
  const merged = new Set(
    nonEmpty((await git(repoPath, ['tag', '--merged', headSha, '--list', 'v*'])).stdout),
  );
  const lastName = newestFirst(all.filter((t) => merged.has(t)))[0] ?? null;
  const lastSha = lastName ? await revParse(repoPath, `refs/tags/${lastName}`) : null;
  return { all, newestFirst, last: lastName && lastSha ? { name: lastName, sha: lastSha } : null };
}

/** The newest release tag merged into `headSha`, or null. */
export const lastReleaseTagAt = async (
  repoPath: string,
  headSha: string,
): Promise<{ name: string; sha: string } | null> => (await releaseTagsAt(repoPath, headSha)).last;

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

  const { all, newestFirst, last: lastTag } = await releaseTagsAt(repoPath, headSha);
  const lastName = lastTag?.name ?? null;

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
    ...(await submodulesField(repoPath, headSha, input)),
  };
}

/** `{ submodules }` only when `.gitmodules` exists at `headSha`, so facts of a repository without submodules stay as they were. */
async function submodulesField(
  repoPath: string,
  headSha: string,
  input: ReleaseFactsInput,
): Promise<{ submodules?: ReleaseSubmoduleFacts[] }> {
  if ((await git(repoPath, ['cat-file', '-e', `${headSha}:.gitmodules`])).exitCode !== 0) return {};
  return { submodules: await submodulePointersAt(repoPath, headSha, input) };
}

/**
 * Every submodule declared at `headSha` with its pinned commit, compared with the latest release tag of the project
 * repository it points to (matched by normalized url against `payload.projectRepos`). The pointed repository's tags are
 * read from the runner's own registered clone of it, under that clone's lock with its origin's auth; the superproject
 * is only read. Never throws: anything that cannot be resolved is `unknown` with the reason.
 */
export async function submodulePointersAt(
  repoPath: string,
  headSha: string,
  input: ReleaseFactsInput,
): Promise<ReleaseSubmoduleFacts[]> {
  const p = input.payload;
  const origin = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const declared = (await readSubmodules(repoPath, origin, { at: headSha })).slice(0, SUBMODULES_MAX);
  const out: ReleaseSubmoduleFacts[] = [];
  for (const sub of declared) {
    if (!isSafeSubmodulePath(sub.path)) continue;
    const entry = (await git(repoPath, ['ls-tree', '-z', headSha, '--', sub.path])).stdout;
    const pinned = /^160000 commit ([0-9a-f]{40})\t/.exec(entry)?.[1];
    if (!pinned) continue;
    const base = { path: sub.path.slice(0, 500), url: sub.normalized.slice(0, 500), pinned };
    if (!p.projectRepos) {
      out.push({ ...base, state: 'not_checked', reason: "not compared with the project's repositories" });
      continue;
    }
    const repo = p.projectRepos.find(
      (r) => r.remoteUrlNormalized === sub.normalized && r.repoId !== p.repoId,
    );
    if (!repo) {
      out.push({ ...base, state: 'not_checked', reason: 'points outside this project' });
      continue;
    }
    const pointed = { ...base, repoId: repo.repoId, repoName: repo.name };
    try {
      const local = await input.findRepo?.(repo.remoteUrlNormalized).catch(() => undefined);
      if (!local) {
        out.push({ ...pointed, state: 'unknown', reason: `no clone of ${repo.name} on this workstation` });
        continue;
      }
      out.push(await classifyPointer(local.localPath, pointed, repo, input.auth));
    } catch (err) {
      const why = redactGitError(err instanceof Error ? err.message : String(err));
      out.push({
        ...pointed,
        state: 'unknown',
        reason: `could not check ${repo.name}: ${why}`.slice(0, 300),
      });
    }
  }
  return out;
}

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim() !== '') ?? '';

/** Compares the pin with the newest release tag of the pointed repository's clone. */
async function classifyPointer(
  clone: string,
  pointed: Omit<ReleaseSubmoduleFacts, 'state'>,
  repo: ReleaseProjectRepo,
  auth: GitAuth | undefined,
): Promise<ReleaseSubmoduleFacts> {
  const { pinned } = pointed;
  const unknown = (reason: string): ReleaseSubmoduleFacts => ({
    ...pointed,
    state: 'unknown',
    reason: reason.slice(0, 300),
  });
  return withRepoLock(clone, async () => {
    const origin = (await git(clone, ['remote', 'get-url', 'origin'])).stdout.trim();
    const a = auth && origin ? await auth(origin) : { args: [], env: {} };
    const opts = { env: a.env, timeoutMs: 300_000 };
    const tags = await git(
      clone,
      [...a.args, 'fetch', '--no-recurse-submodules', '--', 'origin', 'refs/tags/*:refs/tags/*'],
      opts,
    );
    if (tags.exitCode !== 0)
      return unknown(
        `could not fetch the tags of ${repo.name}: ${redactGitError(firstLine(tags.stderr || tags.stdout) || `exit code ${tags.exitCode}`)}`,
      );
    const has = async () => (await git(clone, ['cat-file', '-e', `${pinned}^{commit}`])).exitCode === 0;
    if (!(await has())) {
      await git(clone, [...a.args, 'fetch', '--no-recurse-submodules', 'origin'], opts);
      if (!(await has()))
        await git(clone, [...a.args, 'fetch', '--no-recurse-submodules', 'origin', pinned], opts);
      if (!(await has())) return unknown(`pinned commit ${pinned.slice(0, 7)} is not in ${repo.name}`);
    }
    const { all, newestFirst, last } = await releaseTagsAt(clone, pinned);
    const latest = newestFirst(all)[0];
    if (!latest) return { ...pointed, state: 'not_checked', reason: `${repo.name} has no release tags` };
    const latestSha = await revParse(clone, `refs/tags/${latest}`);
    if (!latestSha) return unknown(`could not read the tag ${latest} of ${repo.name}`);
    const known = {
      ...pointed,
      latestTag: { name: latest, sha: latestSha },
      containsTag: last?.name ?? null,
    };
    if (latestSha === pinned) return { ...known, state: 'pinned' };
    const anc = await git(clone, ['merge-base', '--is-ancestor', latestSha, pinned]);
    if (anc.exitCode === 0) return { ...known, state: 'not_on_release_tag' };
    if (anc.exitCode === 1) return { ...known, state: 'behind' };
    return {
      ...known,
      state: 'unknown',
      reason:
        `could not compare with ${latest} of ${repo.name}: ${redactGitError(firstLine(anc.stderr) || `exit code ${anc.exitCode}`)}`.slice(
          0,
          300,
        ),
    };
  });
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
