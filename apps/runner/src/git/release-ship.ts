import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  componentBumps,
  hasReleaseSection,
  isSafeGitRef,
  newChangelog,
  type ReleaseShipPayload,
  type ReleaseShipResult,
  type ReleaseShipStep,
  releaseChangelog,
  releaseSectionOf,
  replaceComponentVersion,
} from '@aom/shared';
import { detectSignOff } from './dco.ts';
import { isProtectedBranchRejection } from './gh.ts';
import { advanceLocalBranch, git, hasRemote, revParse } from './git.ts';
import { commitEnv, NO_IDENTITY_WIRE, NoCommitIdentityError, requireCommitIdentity } from './identity.ts';
import { integrationBranchName, withIntegrationWorktree } from './integration.ts';
import { componentFactsAt } from './release-facts.ts';
import { withRepoLock } from './repo-lock.ts';
import type { GitAuth } from './worktrees.ts';

export interface ReleaseShipInput {
  payload: ReleaseShipPayload;
  /** Local clone of the repository. */
  repoPath: string;
  /** Folder of the throwaway integration worktrees. */
  integrationDir: string;
  auth?: GitAuth;
}

type Bumps = ReleaseShipResult['components'];

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstLine = (s: string): string => s.trim().slice(0, 3500);

function fail(
  step: ReleaseShipStep,
  error: string,
  extra: Partial<ReleaseShipResult> = {},
): ReleaseShipResult {
  return { ok: false, step, error: firstLine(error), components: [], notices: [], ...extra };
}

/**
 * `release.ship`: the release commit on the working branch. In a throwaway worktree cut from `origin/<working branch>`
 * it bumps the version file of every changed component, moves `## [Unreleased]` of CHANGELOG.md under
 * `## [version] - date`, commits as the project identity (signed off when the repository asks for a DCO) and pushes the
 * commit to the working branch. Never forces a push and never touches a tag. Repeating it is safe: a branch that already
 * has the version section answers `alreadyDone`, and a commit that was made but not pushed is pushed as it is. Never
 * throws for expected failures.
 */
export async function shipReleaseCommit(input: ReleaseShipInput): Promise<ReleaseShipResult> {
  try {
    return await withRepoLock(input.repoPath, () => shipLocked(input));
  } catch (err) {
    return fail('prepare', errMsg(err));
  }
}

async function shipLocked(input: ReleaseShipInput): Promise<ReleaseShipResult> {
  const { payload: p, repoPath } = input;
  const wb = p.workingBranch;
  const version = p.version;
  const notices: string[] = [];
  if (!isSafeGitRef(wb)) return fail('prepare', `refusing unsafe branch name ${JSON.stringify(wb)}`);
  if (!isSafeGitRef(p.tag)) return fail('prepare', `refusing unsafe tag name ${JSON.stringify(p.tag)}`);
  if (p.lastTag !== null && !isSafeGitRef(p.lastTag))
    return fail('prepare', `refusing unsafe tag name ${JSON.stringify(p.lastTag)}`);
  if (!(await hasRemote(repoPath))) return fail('prepare', 'the repository has no origin remote');
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };
  const authEnv = { env: a.env };

  // 1. prepare
  const fetched = await git(repoPath, [...a.args, 'fetch', '--', 'origin', wb], authEnv);
  if (fetched.exitCode !== 0)
    return fail('prepare', `could not fetch ${wb}: ${(fetched.stderr || fetched.stdout).trim()}`);
  await git(
    repoPath,
    [...a.args, 'fetch', '--no-recurse-submodules', '--', 'origin', 'refs/tags/*:refs/tags/*'],
    authEnv,
  );
  const originRef = `refs/remotes/origin/${wb}`;
  const tip = await revParse(repoPath, originRef);
  if (!tip) return fail('prepare', `the working branch '${wb}' does not exist on origin`);

  // 2. already released: the version section is on the working branch
  const shown = await git(repoPath, ['show', `${tip}:CHANGELOG.md`]);
  if (shown.exitCode === 0 && hasReleaseSection(shown.stdout, version)) {
    const bySubject = await git(repoPath, [
      'log',
      '-1',
      '--format=%H',
      `--grep=^chore(release): ${escapeRe(version)}$`,
      tip,
    ]);
    const byLine = bySubject.stdout.trim()
      ? bySubject
      : await git(repoPath, [
          'log',
          '-1',
          '--format=%H',
          `-G^## \\[${escapeRe(version)}\\]`,
          tip,
          '--',
          'CHANGELOG.md',
        ]);
    const section = releaseSectionOf(shown.stdout, version);
    return {
      ok: true,
      step: 'push',
      alreadyDone: true,
      commit: byLine.stdout.trim() || tip,
      components: [],
      notices: [`${wb} already has the ${version} section: nothing new was committed`],
      ...(section ? { section } : {}),
    };
  }

  // the tag must not exist (a released version is never released again)
  const remoteTag = await git(
    repoPath,
    [...a.args, 'ls-remote', '--tags', 'origin', `refs/tags/${p.tag}`],
    authEnv,
  );
  if (remoteTag.exitCode !== 0)
    return fail(
      'prepare',
      `could not list the tags of origin: ${(remoteTag.stderr || remoteTag.stdout).trim()}`,
    );
  if (remoteTag.stdout.trim() !== '' || (await revParse(repoPath, `refs/tags/${p.tag}`)))
    return fail('prepare', `tag ${p.tag} already exists: this version was released; choose a higher version`);

  // 3. a commit that was made but not pushed (a failed push): push that one
  const kept = `refs/guildwise/release/${version}`;
  const keptSha = await revParse(repoPath, kept);
  if (keptSha) {
    const parent = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${keptSha}^`])).stdout.trim();
    if (parent === tip) {
      const signedOff = /^Signed-off-by:/m.test(
        (await git(repoPath, ['log', '-1', '--format=%B', keptSha])).stdout,
      );
      return pushCommit(input, keptSha, a, { resumed: true, signedOff, components: [], notices });
    }
    await git(repoPath, ['update-ref', '-d', kept]);
    notices.push(`${wb} moved since the first attempt: the release commit was made again`);
  }

  // 4. the commit, in a throwaway worktree
  let identity;
  try {
    identity = await requireCommitIdentity(repoPath, p.commitAs);
  } catch (err) {
    return fail('commit', err instanceof NoCommitIdentityError ? NO_IDENTITY_WIRE : errMsg(err));
  }
  const dir = join(input.integrationDir, `release-${p.repoId}`);
  const made = await withIntegrationWorktree(
    {
      repoPath,
      dir,
      root: input.integrationDir,
      tempBranch: integrationBranchName(`release-${version}`),
      startPoint: tip,
    },
    (wt) => commitRelease(input, wt, tip, identity, notices),
  );
  if (!made.ok) return fail('prepare', made.error, { notices });
  const r = made.value;
  if (!r.ok || !r.commit) return r;
  return pushCommit(input, r.commit, a, {
    resumed: false,
    signedOff: r.signedOff ?? false,
    ...(r.signOffReason ? { signOffReason: r.signOffReason } : {}),
    components: r.components,
    notices: r.notices,
    ...(r.section ? { section: r.section } : {}),
  });
}

async function commitRelease(
  input: ReleaseShipInput,
  wt: string,
  tip: string,
  identity: { name: string; email: string },
  notices: string[],
): Promise<ReleaseShipResult> {
  const { payload: p } = input;
  const written: string[] = [];

  // components: the version files of the rules whose files changed
  const levels = Object.fromEntries(p.components.map((c) => [c.name, c.level]));
  const facts = await componentFactsAt(wt, p.components, p.lastTag, tip);
  const bumps = componentBumps(p.components, facts.components, levels);
  const missing = bumps.find((b) => b.state === 'missing');
  if (missing) return fail('components', missing.message ?? `no version found for ${missing.name}`);
  for (const b of bumps) {
    const rule = p.components.find((c) => c.name === b.name);
    if (!rule) continue;
    if (b.state === 'bump' && b.to !== null) {
      const text = facts.components.find((f) => f.name === b.name)?.contentAtHead ?? null;
      if (text === null) return fail('components', `cannot read ${rule.versionFile}`);
      const out = replaceComponentVersion(rule, text, { version: b.to });
      if (!out.ok) return fail('components', `${rule.versionFile}: ${out.message}`);
      await writeFile(join(wt, rule.versionFile), out.text, 'utf8');
      written.push(rule.versionFile);
    }
    const approved = rule.approvedTo;
    if (approved !== null && b.to !== null && approved !== b.to && b.state !== 'unchanged')
      notices.push(`${b.name} is ${b.to} (approved as ${approved}): the branch changed since the approval`);
  }

  // changelog
  const changelogPath = join(wt, 'CHANGELOG.md');
  let existing: string | null = null;
  try {
    existing = await readFile(changelogPath, 'utf8');
  } catch {
    existing = null;
  }
  let section: string;
  if (existing !== null) {
    const out = releaseChangelog(existing, { version: p.version, date: p.date, bumps });
    if (out.kind === 'error') return fail('changelog', out.message);
    section = out.section;
    if (out.kind === 'rewritten') await writeFile(changelogPath, out.md, 'utf8');
  } else {
    if (!p.notes?.trim())
      return fail('changelog', 'the repository has no CHANGELOG.md and there are no release notes');
    const out = newChangelog(p.projectName, { version: p.version, date: p.date, bumps, notes: p.notes });
    section = out.section;
    await writeFile(changelogPath, out.md, 'utf8');
  }
  written.push('CHANGELOG.md');

  // commit
  const add = await git(wt, ['add', '--', ...written]);
  if (add.exitCode !== 0) return fail('commit', `git add failed: ${(add.stderr || add.stdout).trim()}`);
  const status = (await git(wt, ['status', '--porcelain'])).stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  const extra = status.filter((f) => !written.includes(f));
  if (extra.length > 0)
    return fail('commit', `unexpected changes in the release worktree: ${extra.join(', ')}`);
  if (status.length === 0) return fail('commit', 'the release changes nothing: there is nothing to commit');
  const sign =
    p.signOff === undefined ? await detectSignOff(wt) : { required: p.signOff, reason: 'requested' };
  const commit = await git(
    wt,
    ['commit', '-m', `chore(release): ${p.version}`, ...(sign.required ? ['--signoff'] : [])],
    { env: commitEnv(identity) },
  );
  if (commit.exitCode !== 0)
    return fail('commit', `git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
  const sha = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(wt, ['update-ref', `refs/guildwise/release/${p.version}`, sha]);
  return {
    ok: true,
    commit: sha,
    signedOff: sign.required,
    ...(sign.required && sign.reason ? { signOffReason: sign.reason } : {}),
    components: bumps.map(({ name, state, from, to, changedCount }) => ({
      name,
      state,
      from,
      to,
      changedCount,
    })),
    notices,
    section,
  };
}

async function pushCommit(
  input: ReleaseShipInput,
  sha: string,
  a: { args: string[]; env: Record<string, string> },
  carry: {
    resumed: boolean;
    signedOff: boolean;
    signOffReason?: string;
    components: Bumps;
    notices: string[];
    section?: string;
  },
): Promise<ReleaseShipResult> {
  const { payload: p, repoPath } = input;
  const base = {
    commit: sha,
    resumed: carry.resumed,
    signedOff: carry.signedOff,
    ...(carry.signOffReason ? { signOffReason: carry.signOffReason } : {}),
    components: carry.components,
    notices: carry.notices,
    ...(carry.section ? { section: carry.section } : {}),
  };
  // A fast-forward push of the commit: no --force and no leading '+'.
  const push = await git(repoPath, [...a.args, 'push', 'origin', `${sha}:refs/heads/${p.workingBranch}`], {
    env: a.env,
  });
  if (push.exitCode !== 0) {
    const why = (push.stderr || push.stdout).trim();
    const msg = isProtectedBranchRejection(why)
      ? `${p.workingBranch} is protected and refused the push: ${why}`
      : `pushing ${p.workingBranch} failed: ${why}`;
    return { ok: false, step: 'push', error: firstLine(msg), ...base };
  }
  await git(repoPath, ['update-ref', '-d', `refs/guildwise/release/${p.version}`]);
  await advanceLocalBranch(repoPath, p.workingBranch, sha);
  let section = carry.section;
  if (!section) {
    const text = await git(repoPath, ['show', `${sha}:CHANGELOG.md`]);
    section = (text.exitCode === 0 ? releaseSectionOf(text.stdout, p.version) : null) ?? undefined;
  }
  return { ok: true, step: 'push', ...base, ...(section ? { section } : {}) };
}
