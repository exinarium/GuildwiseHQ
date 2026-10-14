import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_COMMIT_IDENTITY_MESSAGE } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../src/git/git.ts';
import {
  commitEnv,
  isNoCommitIdentity,
  NoCommitIdentityError,
  repoLevelIdentity,
  requireCommitIdentity,
  resolveCommitIdentity,
} from '../src/git/identity.ts';
import { rebaseEnv } from '../src/git/rebase.ts';
import { cleanupTmp, makeRepo, sh } from './helpers.ts';
import { TEST_OWNER } from './setup-git.ts';

cleanupTmp();

const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
afterEach(() => {
  process.env.GIT_CONFIG_GLOBAL = savedGlobal as string;
});

/** Points the "workstation global" config at a throwaway file (never the real ~/.gitconfig). */
function globalConfig(content: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'aom-global-'));
  const f = join(dir, 'gitconfig');
  writeFileSync(f, content);
  process.env.GIT_CONFIG_GLOBAL = f;
}

const PROJECT = { name: 'Pieter Jordaan', email: 'pieter@example.test' };

describe('commit identity resolver (backlog #65)', () => {
  it('1: the project setting wins over the repository and the workstation', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['config', 'user.name', 'Repo Person']);
    sh(repo.clone, 'git', ['config', 'user.email', 'repo@example.test']);
    expect(await resolveCommitIdentity(repo.clone, PROJECT)).toEqual({ ...PROJECT, source: 'project' });
  });

  it('2: the clone-level git config comes next, and a card worktree shares it', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['config', 'user.name', 'Repo Person']);
    sh(repo.clone, 'git', ['config', 'user.email', 'repo@example.test']);
    expect(await resolveCommitIdentity(repo.clone)).toEqual({
      name: 'Repo Person',
      email: 'repo@example.test',
      source: 'repo',
    });
    const wt = join(repo.root, 'wt');
    sh(repo.clone, 'git', ['worktree', 'add', '-b', 'card', wt]);
    expect(await resolveCommitIdentity(wt)).toMatchObject({ name: 'Repo Person', source: 'repo' });
  });

  it('3: then the workstation user global config, reporting the source', async () => {
    const repo = makeRepo();
    expect(await resolveCommitIdentity(repo.clone)).toEqual({ ...TEST_OWNER, source: 'global' });
    expect(await repoLevelIdentity(repo.clone)).toEqual({ ...TEST_OWNER, source: 'global' });
  });

  it('a level that has only a name or only an e-mail is skipped', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['config', 'user.name', 'Only A Name']);
    expect(await resolveCommitIdentity(repo.clone)).toEqual({ ...TEST_OWNER, source: 'global' });
  });

  it('4: nothing set anywhere: refused with the message naming the three places, never a product name', async () => {
    const repo = makeRepo();
    globalConfig('');
    expect(await resolveCommitIdentity(repo.clone)).toBeNull();
    await expect(requireCommitIdentity(repo.clone)).rejects.toBeInstanceOf(NoCommitIdentityError);
    await expect(requireCommitIdentity(repo.clone)).rejects.toThrow(NO_COMMIT_IDENTITY_MESSAGE);
    expect(NO_COMMIT_IDENTITY_MESSAGE).toMatch(/Project settings/);
    expect(NO_COMMIT_IDENTITY_MESSAGE).toMatch(/in the repository/);
    expect(NO_COMMIT_IDENTITY_MESSAGE).toMatch(/--global/);
    expect(NO_COMMIT_IDENTITY_MESSAGE).not.toMatch(/guildwise|aom\b/i);
    expect(isNoCommitIdentity(new NoCommitIdentityError())).toBe(true);
    await expect(rebaseEnv(repo.clone)).rejects.toBeInstanceOf(NoCommitIdentityError);
  });

  it('a rebase uses the resolved identity as committer only', async () => {
    const repo = makeRepo();
    expect(await rebaseEnv(repo.clone, PROJECT)).toEqual({
      GIT_COMMITTER_NAME: PROJECT.name,
      GIT_COMMITTER_EMAIL: PROJECT.email,
    });
    expect(commitEnv(PROJECT)).toEqual({
      GIT_AUTHOR_NAME: PROJECT.name,
      GIT_AUTHOR_EMAIL: PROJECT.email,
      GIT_COMMITTER_NAME: PROJECT.name,
      GIT_COMMITTER_EMAIL: PROJECT.email,
    });
    // the real git sees the same
    const out = await git(repo.clone, ['config', '--get', 'user.name']);
    expect(out.stdout.trim()).toBe(TEST_OWNER.name);
  });
});
